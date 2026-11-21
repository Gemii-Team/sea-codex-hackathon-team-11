import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { contactIdPattern, createHistoryStore } from './history.mjs';
import { createEvidenceAccess } from './evidence.mjs';
import { startRealtime } from './standalone-realtime.mjs';
import { createTranscript, maskSensitive } from './transcript.mjs';

const port = Number(process.env.PHONE_DEMO_PORT ?? 8783);
const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const origins = new Set([...hosts].map((host) => 'http://' + host));
const rootEnv = new URL('../../.env', import.meta.url);
const storage = {
  bucket: process.env.PHONE_HISTORY_BUCKET,
  directory: fileURLToPath(new URL(process.env.PHONE_HISTORY_DIR ?? './.history/', import.meta.url)),
  profile: process.env.PHONE_HISTORY_PROFILE ?? 'bsirikxm',
  region: process.env.PHONE_HISTORY_REGION ?? 'ap-southeast-1',
};
const store = createHistoryStore(storage);
const evidenceStore = createHistoryStore({
  ...storage,
  directory: join(storage.directory, 'evidence'),
  prefix: 'v1/evidence/',
});
const canReadEvidence = await createEvidenceAccess(storage.directory);
const fixture = JSON.parse(await readFile(new URL(
  '../contracts/conversations/v1/examples/demo-otp-request.json', import.meta.url,
), 'utf8'));
const fixtureEvidence = JSON.parse(await readFile(new URL(
  '../contracts/conversations/v1/examples/demo-otp-request.evidence.json', import.meta.url,
), 'utf8'));
const pages = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);
const calls = new Map();

async function apiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const env = await readFile(rootEnv, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return parseEnv(env).OPENAI_API_KEY?.trim();
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return null; }
}

function finishCall(call, disconnected) {
  if (call.saving) return call.saving;
  call.saving = (async () => {
    if (!disconnected && !call.closed) {
      // Give committed caller audio time to return its asynchronous final transcript.
      await delay(1400);
      await call.realtime.hangUp().catch(() => false);
    }
    call.realtime.close();
    call.closed = true;
    const transcript = call.transcript.snapshot();
    if (disconnected && transcript.transcriptStatus === 'complete') transcript.transcriptStatus = 'partial';
    const entries = call.transcript.evidence();
    const saved = { ...call.record, ...transcript, evidenceCount: entries.length };
    if (entries.length) {
      await evidenceStore.save({ contactId: saved.contactId, startedAt: saved.startedAt, entries });
    }
    await store.save(saved);
    calls.delete(saved.contactId);
    return saved;
  })().catch((error) => {
    call.saving = undefined;
    throw error;
  });
  return call.saving;
}

async function beginCall(req, res) {
  const key = await apiKey();
  if (!key) return json(res, 503, { error: 'ตั้งค่า OPENAI_API_KEY ในไฟล์ .env ที่ root ของ repo ก่อนเริ่มสาย' });
  const body = await readJson(req);
  if (typeof body?.sdp !== 'string' || !body.sdp.startsWith('v=0') ||
      (body.contactName != null && (typeof body.contactName !== 'string' || body.contactName.length > 80))) {
    return json(res, 400, { error: 'ข้อมูลเริ่มสายไม่ถูกต้อง' });
  }

  const contactId = 'rt-' + randomUUID();
  const contactName = maskSensitive(body.contactName ?? '').slice(0, 80);
  const call = {
    record: {
      schemaVersion: 1,
      contactId,
      source: 'openai_realtime',
      channel: 'web_call',
      locale: 'th-TH',
      startedAt: new Date().toISOString(),
      ...(contactName ? { contactName } : {}),
      summaryStatus: 'unavailable',
      summary: null,
    },
    transcript: createTranscript(),
  };

  try {
    call.realtime = await startRealtime({
      key,
      model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
      sdp: body.sdp,
      onEvent: call.transcript.accept,
      onClose: () => {
        call.closed = true;
        if (call.realtime && !call.saving) {
          finishCall(call, true).catch(() => console.error('Could not save disconnected call', contactId));
        }
      },
    });
  } catch (error) {
    return json(res, 502, { error: error.message });
  }
  calls.set(contactId, call);
  json(res, 201, { contactId, sdp: call.realtime.answer });
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'เปิดเดโมผ่าน localhost' });
  if (req.method === 'POST' && !origins.has(req.headers.origin)) {
    return json(res, 403, { error: 'คำขอมาจากหน้าเว็บอื่น' });
  }

  const path = req.url?.split('?')[0];
  try {
    if (req.method === 'GET' && pages.has(path)) {
      const [filename, kind] = pages.get(path);
      const content = await readFile(new URL('./public/' + filename, import.meta.url));
      res.writeHead(200, { 'Content-Type': kind + '; charset=utf-8' });
      return res.end(content);
    }
    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, { keyConfigured: Boolean(await apiKey()), storage: store.kind });
    }
    if (req.method === 'POST' && path === '/api/calls') return await beginCall(req, res);
    if (req.method === 'GET' && path === '/api/history') {
      const records = await store.list();
      return json(res, 200, [
        ...records.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        { contactId: fixture.contactId, startedAt: fixture.startedAt, contactName: fixture.summary.title, source: 'fixture' },
      ]);
    }

    const [, resource, action, id, subaction] = path?.split('/') ?? [];
    if (resource === 'api' && contactIdPattern.test(id ?? '')) {
      if (req.method === 'GET' && action === 'history' && !subaction) {
        const record = id === fixture.contactId ? fixture : await store.get(id);
        return record ? json(res, 200, record) : json(res, 404, { error: 'ไม่พบประวัติสาย' });
      }
      if (req.method === 'GET' && action === 'evidence' && !subaction) {
        if (!canReadEvidence(req.headers.authorization)) {
          return json(res, 401, { error: 'รหัสเปิดหลักฐานไม่ถูกต้อง' });
        }
        const evidence = id === fixture.contactId ? fixtureEvidence : await evidenceStore.get(id);
        return evidence ? json(res, 200, evidence) : json(res, 404, { error: 'ไม่พบหลักฐานสำหรับสายนี้' });
      }
      if (req.method === 'POST' && action === 'calls' && subaction === 'finish') {
        const call = calls.get(id);
        const record = call ? await finishCall(call, call.closed) : await store.get(id);
        return record ? json(res, 200, record) : json(res, 404, { error: 'ไม่พบสายนี้' });
      }
    }
    return json(res, 404, { error: 'ไม่พบหน้านี้' });
  } catch {
    console.error(req.method, path, 'request failed');
    if (!res.headersSent) json(res, 500, { error: 'อ่านหรือบันทึกประวัติไม่สำเร็จ กรุณาลองอีกครั้ง' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Thai voice demo at http://localhost:${port}/ (history: ${store.kind})`);
});
