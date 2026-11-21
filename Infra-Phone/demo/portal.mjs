// Internal companion for Agent Studio. The Go API authenticates the team and
// authorizes calls before forwarding requests. No host port is published.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTranscript } from './transcript.mjs';
import { createEvidenceAccess } from './evidence.mjs';
import { createHistoryStore } from './history.mjs';
import { createRealtimeOffer, observeRealtime } from './realtime.mjs';

const directory = '/data';
const config = { directory, bucket: process.env.PHONE_HISTORY_BUCKET, region: process.env.PHONE_HISTORY_REGION || 'ap-southeast-1' };
const store = createHistoryStore(config);
const evidence = createHistoryStore({ ...config, directory: join(directory, 'evidence'), prefix: 'v1/evidence/' });
const canReview = await createEvidenceAccess(directory);
const fixture = JSON.parse(await readFile(new URL('../contracts/conversations/v1/examples/demo-otp-request.json', import.meta.url)));
const fixtureEvidence = JSON.parse(await readFile(new URL('../contracts/conversations/v1/examples/demo-otp-request.evidence.json', import.meta.url)));
const calls = new Map();

function save(call, interrupted) {
  if (call.saving) return call.saving;
  call.saving = (async () => {
    await delay(500);
    const snapshot = call.transcript.snapshot();
    const entries = call.transcript.evidence();
    if (interrupted && snapshot.transcriptStatus === 'complete') snapshot.transcriptStatus = 'partial';
    if (entries.length) await evidence.save({ contactId: call.id, startedAt: call.startedAt, entries });
    const claims = snapshot.turns.filter(turn => turn.speaker === 'caller' &&
      /จาก|บริษัท|ร้าน|ส่ง|พัสดุ|บาท|โอน|บัญชี|อ้างอิง|ค่าบริการ|คืนเงิน|ชำระ|ติดต่อ|รหัส/.test(turn.text));
    const summary = claims.length ? { title: 'สิ่งที่ผู้โทรกล่าวอ้าง',
      text: claims.map(turn => '“' + turn.text + '”').join('\n'), evidenceTurnIds: claims.map(turn => turn.id) } : null;
    await store.save({ schemaVersion: 1, source: 'openai_realtime', channel: 'web_call', locale: 'th-TH',
      contactId: call.id, startedAt: call.startedAt, ...snapshot, evidenceCount: entries.length,
      summary, summaryStatus: summary ? 'ready' : 'unavailable' });
    calls.delete(call.id);
    call.close?.();
  })().catch(error => { call.saving = null; throw error; });
  return call.saving;
}

createServer(async (req, res) => {
  function reply(status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  try {
    if (req.method === 'POST' && req.url === '/offer') {
      const parts = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64 * 1024) return reply(413, {});
        parts.push(chunk);
      }
      const { SDP, ...profile } = JSON.parse(Buffer.concat(parts).toString());
      const offer = await createRealtimeOffer({ key: process.env.OPENAI_API_KEY, model: 'gpt-realtime-2.1-mini',
        transcriptionModel: 'gpt-transcribe', sdp: SDP, profile });
      if (!offer.ok) {
        console.error('OpenAI rejected offer', offer.status, offer.headers.get('x-request-id'));
        await offer.body?.cancel();
        return reply(422, {});
      }
      const location = offer.headers.get('location');
      res.writeHead(201, { 'Content-Type': 'application/sdp', ...(location ? { Location: location } : {}) });
      res.end(await offer.text());
      return;
    }
    if (req.url === '/healthz') return reply(200, { storage: store.kind });
    if (req.method === 'GET' && req.url === '/history') {
      return reply(200, [...(await store.list()).sort((a,b) => b.startedAt.localeCompare(a.startedAt)),
        { contactId: fixture.contactId, startedAt: fixture.startedAt, source: 'fixture' }]);
    }
    const match = /^\/(attach|finish|history|evidence)\/([a-zA-Z0-9_-]{1,128})$/.exec(req.url);
    if (!match) return reply(404, {});
    const [, operation, id] = match;
    if (operation === 'attach' && req.method === 'POST' && id.startsWith('rtc_')) {
      if (calls.has(id)) return reply(409, {});
      const call = { id, startedAt: new Date().toISOString(), transcript: createTranscript() };
      calls.set(id, call);
      try {
        call.close = await observeRealtime({ key: process.env.OPENAI_API_KEY, id,
          onEvent: call.transcript.accept, onClose: () => {
            if (calls.has(id)) save(call, true).catch(() => console.error('History save failed after disconnect'));
          } });
      } catch (error) { calls.delete(id); throw error; }
      return reply(201, {});
    }
    if (operation === 'finish' && req.method === 'POST') {
      const call = calls.get(id);
      if (call) await save(call, false);
      else if (!await store.get(id)) return reply(404, {});
      return reply(200, {});
    }
    if (operation === 'history' && req.method === 'GET') {
      const record = id === fixture.contactId ? fixture : await store.get(id);
      return reply(record ? 200 : 404, record);
    }
    if (operation === 'evidence' && req.method === 'GET') {
      if (!canReview(req.headers.authorization)) return reply(403, {});
      const record = id === fixture.contactId ? fixtureEvidence : await evidence.get(id);
      return reply(record ? 200 : 404, record);
    }
    reply(404, {});
  } catch {
    console.error('Phone history operation failed', req.method);
    reply(502, {});
  }
}).listen(8783, '0.0.0.0');
