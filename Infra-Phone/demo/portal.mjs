// Internal companion for Agent Studio. The Go API authenticates the team and
// authorizes calls before forwarding requests. No host port is published.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTranscript } from './transcript.mjs';
import { createEvidenceAccess } from './evidence.mjs';
import { createHistoryStore } from './history.mjs';
import { observeRealtime } from './realtime.mjs';

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
    await store.save({ schemaVersion: 1, source: 'openai_realtime', channel: 'web_call', locale: 'th-TH',
      contactId: call.id, startedAt: call.startedAt, ...snapshot, evidenceCount: entries.length,
      summary: null, summaryStatus: 'unavailable' });
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
