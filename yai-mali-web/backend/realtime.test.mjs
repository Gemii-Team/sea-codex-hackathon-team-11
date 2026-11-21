// Tests for the OpenAI Realtime provider. Run with:
//   node --test yai-mali-web/backend/realtime.test.mjs
// No network: fetch, timers and the clock are fakes, and the key is a fixture.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CALL_LIMIT, HANGUP_BEFORE_CUTOFF_MS, MAX_CALL_MS, NO_NEW_CALL_MS, UNCERTAIN_GRACE_MS,
  createVoiceProvider, isValidCallId,
} from './realtime.mjs';
import { OPENINGS, SCENARIO_HINTS, voiceInstructions } from './persona.mjs';

const KEY = 'sk-test-fixture-not-real';
const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
const ANSWER = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n';
const T0 = 1_000_000_000_000;
const CUTOFF = T0 + 60 * 60 * 1000;

function harness({ cutoffAt = CUTOFF, dir = mkdtempSync(path.join(tmpdir(), 'voice-')), handler } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 1;
  const clock = { t: T0 };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  const provider = () => createVoiceProvider({
    apiKey: KEY, cutoffAt, stateDir: dir, fetchImpl,
    now: () => clock.t,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    retryDelay: async () => {},
  });
  return { calls, timers, clock, dir, make: provider };
}

const created = (id = 'rtc_abc123', answer = ANSWER) => () =>
  new Response(answer, { status: 201, headers: { Location: `/v1/realtime/calls/${id}` } });
const ok = () => new Response(null, { status: 204 });
const isCreate = (url) => url === 'https://api.openai.com/v1/realtime/calls';
const hangups = (calls) => calls.filter((c) => c.url.endsWith('/hangup'));
const state = (dir) => JSON.parse(readFileSync(path.join(dir, 'voice-state.json'), 'utf8'));
const fire = (h) => { const [[id, t]] = [...h.timers]; h.timers.delete(id); return t.fn(); };

describe('start', () => {
  test('relays the offer with the session config and returns answer + id', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
    const p = h.make();
    const out = await p.start(OFFER);
    assert.deepEqual(out, { id: 'rtc_abc123', sdp: ANSWER });
    const [{ url, init }] = h.calls;
    assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.body.get('sdp'), OFFER);
    const session = JSON.parse(init.body.get('session'));
    assert.equal(session.type, 'realtime');
    assert.equal(session.model, 'gpt-realtime-2.1-mini');
    assert.equal(session.max_output_tokens, 400);
    assert.equal(session.audio.output.voice, 'marin');
    assert.match(session.instructions, /Yai Mali/);
    assert.match(session.instructions, /Never give real personal data, OTPs/);
    assert.equal(state(h.dir).active.id, 'rtc_abc123');
    assert.equal(state(h.dir).count, 1);
    await p.shutdown();
  });

  test('session enables Thai input transcription and keeps the marin voice', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
    const p = h.make();
    await p.start(OFFER);
    const session = JSON.parse(h.calls[0].init.body.get('session'));
    assert.deepEqual(session.audio, {
      input: { transcription: { model: 'gpt-transcribe', language: 'th' } },
      output: { voice: 'marin' },
    });
    await p.shutdown();
  });

  test('the scenario picks the persona and its opening line; no or unknown scenario is free', async () => {
    for (const [options, expected] of [
      [{ scenario: 'police' }, 'police'],
      [{ scenario: 'parcel' }, 'parcel'],
      [{ scenario: 'job' }, 'job'],
      [{ scenario: 'free' }, 'free'],
      [{}, 'free'],
      [undefined, 'free'],
      [{ scenario: 'nonsense' }, 'free'],
    ]) {
      const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
      const p = h.make();
      await p.start(OFFER, options);
      const { instructions } = JSON.parse(h.calls[0].init.body.get('session'));
      assert.equal(instructions, voiceInstructions(expected), JSON.stringify(options));
      assert.ok(instructions.includes(OPENINGS[expected]));
      assert.ok(instructions.includes(SCENARIO_HINTS[expected]));
      await p.shutdown();
    }
  });

  test('rejects invalid offers before reserving anything', async () => {
    const h = harness({ handler: created() });
    const p = h.make();
    for (const bad of [undefined, '', 'hello', 'v=0' + 'x'.repeat(21 * 1024)]) {
      await assert.rejects(p.start(bad), { status: 400, code: 'invalid_offer' });
    }
    assert.equal(h.calls.length, 0);
    assert.throws(() => state(h.dir), { code: 'ENOENT' }); // nothing was reserved or persisted
  });

  test('missing key is a safe 503 and spends nothing', async () => {
    const h = harness({ handler: created() });
    const p = createVoiceProvider({ apiKey: '', cutoffAt: CUTOFF, stateDir: h.dir, now: () => T0 });
    await assert.rejects(p.start(OFFER), { status: 503, code: 'not_configured' });
  });

  test('overlapping starts: exactly one gets the slot, before any await', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = harness({ handler: async (url) => { await gate; return created()(url); } });
    const p = h.make();
    const first = p.start(OFFER);
    await assert.rejects(p.start(OFFER), { status: 429, code: 'busy' });
    release();
    assert.equal((await first).id, 'rtc_abc123');
    assert.equal(h.calls.filter((c) => isCreate(c.url)).length, 1);
    assert.equal(state(h.dir).count, 1);
    await p.shutdown();
  });

  test('an upstream Location URL is never fetched; only a valid call id is taken', async () => {
    const h = harness({
      handler: (url) => (isCreate(url)
        ? new Response(ANSWER, { status: 201, headers: { Location: 'https://evil.example/v1/realtime/calls/rtc_good1234' } })
        : ok()),
    });
    const p = h.make();
    const { id } = await p.start(OFFER);
    assert.equal(id, 'rtc_good1234');
    await p.hangup(id);
    assert.deepEqual(h.calls.map((c) => c.url), [
      'https://api.openai.com/v1/realtime/calls',
      'https://api.openai.com/v1/realtime/calls/rtc_good1234/hangup',
    ]);
  });

  test('malformed Location is a 502, keeps the reservation and does not renew', async () => {
    for (const location of [null, '/v1/realtime/calls/../x', '/other/rtc_abc123', '/v1/realtime/calls/not-an-id']) {
      const headers = location ? { Location: location } : {};
      const h = harness({ handler: () => new Response(ANSWER, { status: 201, headers }) });
      const p = h.make();
      await assert.rejects(p.start(OFFER), { status: 502, code: 'upstream_no_call_id' });
      await assert.rejects(p.start(OFFER), { status: 429, code: 'busy' });
      assert.equal(state(h.dir).active.id, null);
      assert.equal(h.calls.length, 1);
    }
  });

  test('definite 4xx rejection frees the slot but the submission still counts', async () => {
    const h = harness({ handler: () => new Response('secret provider body', { status: 400 }) });
    const p = h.make();
    await assert.rejects(p.start(OFFER), (e) => e.status === 502 && e.code === 'upstream_rejected' && !/secret/.test(e.message));
    assert.equal(state(h.dir).active, null);
    assert.equal(state(h.dir).count, 1);
  });

  test('bad answer body hangs the call up and errors', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created('rtc_badans1', 'garbage')() : ok()) });
    const p = h.make();
    await assert.rejects(p.start(OFFER), { status: 502, code: 'upstream_bad_answer' });
    assert.equal(hangups(h.calls).length, 1);
    assert.equal(state(h.dir).active, null);
  });
});

describe('uncertain outcomes', () => {
  for (const [name, handler] of [
    ['network error', () => { throw new TypeError('socket hang up'); }],
    ['5xx', () => new Response('boom', { status: 503 })],
  ]) {
    test(`${name} keeps the reservation until bound + grace, never renewed`, async () => {
      const h = harness({ handler });
      const p = h.make();
      await assert.rejects(p.start(OFFER), { status: 502 });
      assert.equal(state(h.dir).active.id, null);
      await assert.rejects(p.start(OFFER), { status: 429, code: 'busy' });
      assert.equal(h.calls.length, 1);
      // Timer is set for reservedAt + bound + grace; firing it frees the slot.
      const [[, t]] = [...h.timers];
      assert.equal(t.ms, MAX_CALL_MS + UNCERTAIN_GRACE_MS);
      h.clock.t += MAX_CALL_MS + UNCERTAIN_GRACE_MS;
      fire(h);
      assert.equal(state(h.dir).active, null);
      assert.equal(state(h.dir).count, 1); // not refunded
    });
  }

  test('a restart keeps an id-less reservation (no hangup is possible)', async () => {
    const h = harness({ handler: () => { throw new Error('net'); } });
    await assert.rejects(h.make().start(OFFER), { status: 502 });
    const again = h.make();
    await assert.rejects(again.start(OFFER), { status: 429, code: 'busy' });
    assert.deepEqual(await again.shutdown(), { hungUp: true, uncertain: true });
  });
});

describe('quota, cutoff and bounds', () => {
  test('25 submissions persist across restarts, then 429', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
    for (let i = 0; i < CALL_LIMIT; i += 1) {
      const p = h.make(); // fresh process each time
      const { id } = await p.start(OFFER);
      await p.hangup(id);
      await p.shutdown();
    }
    const p = h.make();
    await assert.rejects(p.start(OFFER), { status: 429, code: 'quota_exhausted' });
    assert.equal(state(h.dir).count, CALL_LIMIT);
  });

  test('no new call within 4 minutes of the cutoff', async () => {
    const h = harness({ handler: created() });
    const p = h.make();
    h.clock.t = CUTOFF - NO_NEW_CALL_MS;
    await assert.rejects(p.start(OFFER), { status: 403, code: 'voice_closed' });
    assert.equal(h.calls.length, 0);
    assert.equal(p.status().open, false);
    h.clock.t = CUTOFF - NO_NEW_CALL_MS - 1;
    assert.equal(p.status().open, true);
  });

  test('call is hung up after 3 minutes by a timer', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
    const p = h.make();
    await p.start(OFFER);
    const [[, t]] = [...h.timers];
    assert.equal(t.ms, MAX_CALL_MS);
    h.clock.t += MAX_CALL_MS;
    await fire(h);
    assert.equal(hangups(h.calls).length, 1);
    assert.equal(state(h.dir).active, null);
    assert.equal(h.timers.size, 0);
  });

  test('a call started just before the no-new-call window is hung up well before the cutoff', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
    const p = h.make();
    h.clock.t = CUTOFF - NO_NEW_CALL_MS - 1;
    await p.start(OFFER);
    const [[, t]] = [...h.timers];
    assert.equal(t.ms, NO_NEW_CALL_MS + 1 - HANGUP_BEFORE_CUTOFF_MS);
    assert.ok(state(h.dir).active.endsAt <= CUTOFF - HANGUP_BEFORE_CUTOFF_MS);
  });

  test('failed hangup keeps the slot and re-arms a retry instead of releasing', async () => {
    let fail = true;
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : fail ? new Response(null, { status: 500 }) : ok()) });
    const p = h.make();
    await p.start(OFFER);
    await fire(h);
    assert.equal(hangups(h.calls).length, 3); // bounded attempts
    assert.equal(state(h.dir).active.id, 'rtc_abc123');
    assert.equal(h.timers.size, 1);
    fail = false;
    await fire(h);
    assert.equal(state(h.dir).active, null);
    assert.equal(h.timers.size, 0);
  });
});

describe('hangup', () => {
  test('only the current known call can be hung up; 404 from upstream counts as closed', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : new Response(null, { status: 404 })) });
    const p = h.make();
    await assert.rejects(p.hangup('rtc_abc123'), { status: 404, code: 'unknown_call' });
    await assert.rejects(p.hangup('../etc'), { status: 400, code: 'invalid_call_id' });
    await p.start(OFFER);
    await assert.rejects(p.hangup('rtc_other999'), { status: 404, code: 'unknown_call' });
    await p.hangup('rtc_abc123');
    assert.equal(state(h.dir).active, null);
    assert.equal(h.timers.size, 0);
    await assert.rejects(p.hangup('rtc_abc123'), { status: 404 });
    const [req] = hangups(h.calls);
    assert.equal(req.init.method, 'POST');
    assert.equal(req.init.redirect, 'error');
    assert.equal(req.init.body, undefined);
    assert.equal(req.init.headers.Authorization, `Bearer ${KEY}`);
  });

  test('upstream hangup failure is a safe 502 and keeps the call known', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : new Response('provider detail', { status: 500 })) });
    const p = h.make();
    await p.start(OFFER);
    await assert.rejects(p.hangup('rtc_abc123'), (e) => e.status === 502 && e.code === 'hangup_failed' && !/detail/.test(e.message));
    assert.equal(state(h.dir).active.id, 'rtc_abc123');
    assert.equal(h.timers.size, 1);
  });

  test('call id syntax', () => {
    for (const good of ['rtc_abc123', 'call_AbC-123_x']) assert.ok(isValidCallId(good), good);
    for (const bad of ['', 'rtc_', 'rtc_a', 'abc_123456', 'rtc_a/b', 'rtc_ab cd', 'rtc_' + 'a'.repeat(200), null, 5]) {
      assert.ok(!isValidCallId(bad), String(bad));
    }
  });
});

describe('restart and shutdown', () => {
  test('a restart schedules an immediate hangup for the persisted known call', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
    await h.make().start(OFFER);
    h.timers.clear();
    const p = h.make();
    const [[, t]] = [...h.timers];
    assert.equal(t.ms, 0);
    await assert.rejects(p.start(OFFER), { status: 429, code: 'busy' });
    await fire(h);
    assert.equal(hangups(h.calls).length, 1);
    assert.equal(state(h.dir).active, null);
  });

  test('shutdown hangs up the known call, clears timers and reports the outcome', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : ok()) });
    const p = h.make();
    await p.start(OFFER);
    assert.deepEqual(await p.shutdown(), { hungUp: true, uncertain: false });
    assert.equal(hangups(h.calls).length, 1);
    assert.equal(h.timers.size, 0);
    await assert.rejects(p.start(OFFER), { status: 503, code: 'shutting_down' });
  });

  test('shutdown reports an unconfirmed hangup, and keeps the call recorded for recovery', async () => {
    const h = harness({ handler: (url) => (isCreate(url) ? created()() : new Response(null, { status: 500 })) });
    const p = h.make();
    await p.start(OFFER);
    assert.deepEqual(await p.shutdown(), { hungUp: false, uncertain: false });
    assert.equal(state(h.dir).active.id, 'rtc_abc123');
  });

  test('recovery-only use (no start): create + shutdown hangs up a leftover call', async () => {
    const h = harness({ handler: ok });
    writeFileSync(path.join(h.dir, 'voice-state.json'),
      JSON.stringify({ version: 1, count: 3, active: { reservedAt: T0, id: 'rtc_left0ver', endsAt: T0 + 1 } }));
    const p = h.make();
    assert.deepEqual(await p.shutdown(), { hungUp: true, uncertain: false });
    assert.equal(hangups(h.calls)[0].url, 'https://api.openai.com/v1/realtime/calls/rtc_left0ver/hangup');
    assert.equal(h.calls.filter((c) => isCreate(c.url)).length, 0);
  });

  test('shutdown racing an in-flight start hangs the new call up and fails the start', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = harness({ handler: async (url) => { if (isCreate(url)) { await gate; return created()(); } return ok(); } });
    const p = h.make();
    const starting = p.start(OFFER);
    const down = p.shutdown(); // nothing known yet
    release();
    await assert.rejects(starting, { status: 503, code: 'shutting_down' });
    await down;
    assert.equal(hangups(h.calls).length, 1);
    assert.equal(state(h.dir).active, null);
    assert.equal(h.timers.size, 0);
  });

  test('corrupt state fails closed at construction', () => {
    const h = harness({ handler: ok });
    writeFileSync(path.join(h.dir, 'voice-state.json'), '{"version":1,"count":-1,"active":null}');
    assert.throws(() => h.make(), /unexpected shape/);
    writeFileSync(path.join(h.dir, 'voice-state.json'), 'nope');
    assert.throws(() => h.make(), /not valid JSON/);
  });

  test('bad cutoff is rejected', () => {
    assert.throws(() => createVoiceProvider({ apiKey: KEY, cutoffAt: 'soon', stateDir: tmpdir() }), /cutoffAt/);
  });
});

describe('fail closed and diagnostics', () => {
  test('unpersistable call id: no SDP is delivered, the call is hung up immediately', async () => {
    const h = harness({
      handler: (url) => {
        if (!isCreate(url)) return ok();
        mkdirSync(path.join(h.dir, 'voice-state.json.next')); // makes the next persist fail
        return created()();
      },
    });
    const p = h.make();
    await assert.rejects(p.start(OFFER), { status: 503, code: 'state_unavailable' });
    assert.equal(hangups(h.calls).length, 1);
    assert.equal(h.timers.size, 0);
  });

  test('unpersistable call id with a failing hangup keeps it in memory and retries', async () => {
    let hangupOk = false;
    const h = harness({
      handler: (url) => {
        if (!isCreate(url)) return hangupOk ? ok() : new Response(null, { status: 500 });
        mkdirSync(path.join(h.dir, 'voice-state.json.next'));
        return created()();
      },
    });
    const p = h.make();
    await assert.rejects(p.start(OFFER), { status: 503, code: 'state_unavailable' });
    assert.equal(hangups(h.calls).length, 3);
    await assert.rejects(p.start(OFFER), { status: 429, code: 'busy' });
    assert.equal(h.timers.size, 1);
    hangupOk = true;
    await fire(h);
    await p.start(OFFER).catch((e) => assert.notEqual(e.code, 'busy'));
  });

  test('non-2xx logs only the status and a sanitized request id', async () => {
    const logs = [];
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-'));
    const p = createVoiceProvider({
      apiKey: KEY, cutoffAt: CUTOFF, stateDir: dir, now: () => T0, log: (m) => logs.push(m),
      fetchImpl: async () => new Response('provider body with sk-secret', { status: 400, headers: { 'x-request-id': 'req_ab-12 <script>' } }),
    });
    await assert.rejects(p.start(OFFER), { code: 'upstream_rejected' });
    assert.deepEqual(logs, ['voice: openai create HTTP 400 request-id=req_ab-12script']);
  });
});
