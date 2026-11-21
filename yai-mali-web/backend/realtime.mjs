// OpenAI Realtime (GA) call provider for the Yai Mali voice demo. No dependencies.
//
// The browser sends its WebRTC SDP offer and a scenario; this module relays the offer to
// POST https://api.openai.com/v1/realtime/calls (multipart `sdp` + `session`) with the server
// key, returns the SDP answer plus the upstream call id, and hangs the call up server-side
// (POST /v1/realtime/calls/{id}/hangup) when it hits the time bound, the cutoff, or shutdown.
//
// Errors thrown here are VoiceError: numeric `.status` and a safe machine `.code`. The messages
// never contain provider response bodies, headers or the key.
//
// Slot and quota state is persisted in `${stateDir}/voice-state.json` (single replica, writable
// volume) so the 25-call quota and an in-flight call survive a restart or redeploy:
//   { version: 1, count, active: null | { reservedAt, id: string|null, endsAt: number|null } }
// `count` is never refunded: a submission that may have reached OpenAI is spent. A reservation
// whose outcome is uncertain (network error, 5xx, missing id) is kept, never renewed, and only
// released after the maximum call length plus a grace period has passed.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { voiceInstructions } from './persona.mjs';

export const OPENAI_BASE = 'https://api.openai.com';
export const MODEL = 'gpt-realtime-2.1-mini';
export const VOICE = 'marin';
export const MAX_CALL_MS = 3 * 60 * 1000;
export const CALL_LIMIT = 25;
// No new call starts within this long before the mandatory cutoff.
export const NO_NEW_CALL_MS = 4 * 60 * 1000;
// Known calls are hung up this long before the cutoff.
export const HANGUP_BEFORE_CUTOFF_MS = 2 * 60 * 1000;
// Extra wait before an uncertain reservation is released.
export const UNCERTAIN_GRACE_MS = 60 * 1000;
export const HANGUP_RETRY_MS = 15 * 1000;
export const MAX_SDP_BYTES = 20 * 1024;
const MAX_ANSWER_BYTES = 32 * 1024;
const HANGUP_ATTEMPTS = 3;
const STATE_FILE = 'voice-state.json';

// OpenAI GA call ids come from the Location header of the create response
// (/v1/realtime/calls/rtc_...). Webhook/SIP forms use call_.... Both are accepted.
const CALL_ID = /^(?:rtc|call)_[A-Za-z0-9_-]{4,128}$/;
export const isValidCallId = (id) => typeof id === 'string' && CALL_ID.test(id);

export class VoiceError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'VoiceError';
    this.status = status;
    this.code = code;
  }
}

// Caller speech is transcribed (Thai) so the page can show it; Yai's own speech arrives as
// `response.output_audio_transcript.done` on the same data channel.
export const TRANSCRIPTION_MODEL = 'gpt-transcribe';

function loadState(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, count: 0, active: null };
    throw new Error(`voice state unreadable (${error.code ?? 'error'})`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error('voice state is not valid JSON');
  }
  const a = state?.active;
  const activeOk =
    a === null ||
    (a && typeof a === 'object' &&
      Number.isFinite(a.reservedAt) &&
      (a.id === null || isValidCallId(a.id)) &&
      (a.endsAt === null || Number.isFinite(a.endsAt)));
  if (state?.version !== 1 || !Number.isInteger(state.count) || state.count < 0 || !activeOk) {
    throw new Error('voice state has an unexpected shape');
  }
  return { version: 1, count: state.count, active: a };
}

function saveState(file, state) {
  const tmp = `${file}.next`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function createVoiceProvider({
  apiKey,
  cutoffAt,
  stateDir,
  fetchImpl = fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  requestTimeoutMs = 10_000,
  retryDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  if (!Number.isFinite(cutoffAt)) throw new Error('cutoffAt must be a Unix epoch in milliseconds');
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('stateDir is required');
  mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, STATE_FILE);
  const state = loadState(stateFile);
  let closed = false;
  let timer = null;
  let hangingUp = null; // shared in-flight hangup promise

  const persist = () => saveState(stateFile, state);
  const unref = (t) => { t?.unref?.(); return t; };
  const cancelTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };

  function release() {
    cancelTimer();
    state.active = null;
    try { persist(); } catch { log('voice: could not persist slot release'); }
  }

  function schedule(at, fn) {
    cancelTimer();
    timer = unref(setTimer(() => { timer = null; return fn(); }, Math.max(0, at - now())));
  }

  const authHeaders = () => ({ Authorization: `Bearer ${apiKey}` });

  // Returns true when OpenAI no longer holds the call (2xx or 404), false otherwise.
  async function hangupOnce(id) {
    try {
      const res = await fetchImpl(`${OPENAI_BASE}/v1/realtime/calls/${id}/hangup`, {
        method: 'POST',
        headers: authHeaders(),
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await res.body?.cancel?.().catch(() => {});
      const accepted = (res.status >= 200 && res.status < 300) || res.status === 404;
      if (!accepted) log(`voice: openai hangup HTTP ${res.status} request-id=${safeRequestId(res)}`);
      return accepted;
    } catch {
      return false;
    }
  }

  // Bounded retries for one call; releases the slot only on confirmation.
  function hangupKnown(id) {
    if (hangingUp) return hangingUp;
    hangingUp = (async () => {
      try {
        for (let attempt = 0; attempt < HANGUP_ATTEMPTS; attempt += 1) {
          if (state.active?.id !== id) return true; // already released
          if (await hangupOnce(id)) {
            if (state.active?.id === id) release();
            return true;
          }
          if (attempt < HANGUP_ATTEMPTS - 1) await retryDelay(1000);
        }
        return false;
      } finally {
        hangingUp = null;
      }
    })();
    return hangingUp;
  }

  // Timer-driven path: hang up, and keep retrying later while the process lives.
  function armHangup(id, at) {
    schedule(at, async () => {
      if (closed || state.active?.id !== id) return;
      const done = await hangupKnown(id);
      if (!done && !closed && state.active?.id === id) {
        log('voice: hangup not confirmed, will retry');
        armHangup(id, now() + HANGUP_RETRY_MS);
      }
    });
  }

  function armUncertainRelease() {
    const at = state.active.reservedAt + MAX_CALL_MS + UNCERTAIN_GRACE_MS;
    schedule(at, () => { if (!closed && state.active && state.active.id === null) release(); });
  }

  // Recovery after a restart: hang up a known call now, or wait out an unknown one.
  if (state.active) {
    if (state.active.id) armHangup(state.active.id, now());
    else armUncertainRelease();
  }

  async function start(sdp, { scenario } = {}) {
    if (closed) throw new VoiceError(503, 'shutting_down');
    if (!apiKey) throw new VoiceError(503, 'not_configured');
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || Buffer.byteLength(sdp) > MAX_SDP_BYTES) {
      throw new VoiceError(400, 'invalid_offer');
    }
    const t0 = now();
    if (t0 >= cutoffAt - NO_NEW_CALL_MS) throw new VoiceError(403, 'voice_closed');

    // Everything from the checks to the reservation is synchronous: one slot, no await gap.
    if (state.active) throw new VoiceError(429, 'busy');
    if (state.count >= CALL_LIMIT) throw new VoiceError(429, 'quota_exhausted');
    state.count += 1;
    state.active = { reservedAt: t0, id: null, endsAt: null };
    try {
      persist();
    } catch {
      state.count -= 1;
      state.active = null;
      throw new VoiceError(503, 'state_unavailable');
    }
    armUncertainRelease();

    const form = new FormData();
    form.append('sdp', sdp);
    form.append('session', JSON.stringify({
      type: 'realtime',
      model: MODEL,
      instructions: voiceInstructions(scenario),
      max_output_tokens: 400,
      audio: {
        input: { transcription: { model: TRANSCRIPTION_MODEL, language: 'th' } },
        output: { voice: VOICE },
      },
    }));

    let res;
    try {
      res = await fetchImpl(`${OPENAI_BASE}/v1/realtime/calls`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      // The call may exist upstream: keep the reservation (released after the bound, never renewed).
      throw new VoiceError(502, 'upstream_unavailable');
    }

    if (res.status < 200 || res.status >= 300) {
      log(`voice: openai create HTTP ${res.status} request-id=${safeRequestId(res)}`);
      await res.body?.cancel?.().catch(() => {});
      if (res.status >= 500) throw new VoiceError(502, 'upstream_error'); // uncertain: keep slot
      release(); // definite rejection: free the slot, the submission still counts
      throw new VoiceError(502, 'upstream_rejected');
    }

    const id = parseCallId(res.headers.get('location'));
    if (!id) {
      await res.body?.cancel?.().catch(() => {});
      throw new VoiceError(502, 'upstream_no_call_id'); // uncertain: keep slot
    }

    const endsAt = Math.min(now() + MAX_CALL_MS, cutoffAt - HANGUP_BEFORE_CUTOFF_MS);
    state.active = { reservedAt: t0, id, endsAt };
    let durable = true;
    try { persist(); } catch { durable = false; }
    if (!durable) {
      // Fail closed: without a durable id a restart could not recover this call, so the browser
      // never receives the answer. Hang up now; on failure keep the id in memory and retry.
      log('voice: could not persist call id; hanging up');
      await res.body?.cancel?.().catch(() => {});
      cancelTimer();
      if (!(await hangupKnown(id)) && !closed && state.active?.id === id) armHangup(id, now() + HANGUP_RETRY_MS);
      throw new VoiceError(503, 'state_unavailable');
    }

    if (closed) {
      // Shutdown raced the start: the call exists, so close it now.
      await res.body?.cancel?.().catch(() => {});
      cancelTimer();
      await hangupKnown(id);
      throw new VoiceError(503, 'shutting_down');
    }
    armHangup(id, endsAt);

    let answer;
    try {
      answer = await readLimited(res, MAX_ANSWER_BYTES);
    } catch {
      answer = null;
    }
    if (!answer || !answer.startsWith('v=0')) {
      cancelTimer();
      await hangupKnown(id);
      if (state.active?.id === id) armHangup(id, now() + HANGUP_RETRY_MS);
      throw new VoiceError(502, 'upstream_bad_answer');
    }
    return { id, sdp: answer };
  }

  async function hangup(id) {
    if (!isValidCallId(id)) throw new VoiceError(400, 'invalid_call_id');
    if (!state.active || state.active.id !== id) throw new VoiceError(404, 'unknown_call');
    cancelTimer();
    const done = await hangupKnown(id);
    if (!done) {
      if (!closed && state.active?.id === id) armHangup(id, now() + HANGUP_RETRY_MS);
      throw new VoiceError(502, 'hangup_failed');
    }
  }

  // Resolves { hungUp, uncertain }. hungUp=false: a known call could not be confirmed closed
  // (an expiry CLI should exit nonzero). uncertain=true: an id-less reservation exists whose
  // upstream call cannot be named; it is only waited out, never hung up.
  async function shutdown() {
    closed = true;
    cancelTimer();
    const id = state.active?.id;
    const hungUp = id ? await hangupKnown(id) : true;
    return { hungUp, uncertain: state.active !== null && state.active.id === null };
  }

  function status() {
    return { configured: Boolean(apiKey), used: state.count, limit: CALL_LIMIT, busy: state.active !== null, open: !closed && now() < cutoffAt - NO_NEW_CALL_MS };
  }

  return { start, hangup, shutdown, status };
}

// Only the path segment after /v1/realtime/calls/ is trusted; the Location host is never fetched.
function parseCallId(location) {
  if (typeof location !== 'string' || location === '' || location.length > 300) return null;
  let url;
  try {
    url = new URL(location, OPENAI_BASE);
  } catch {
    return null;
  }
  const m = /^\/v1\/realtime\/calls\/([^/]+)\/?$/.exec(url.pathname);
  return m && isValidCallId(m[1]) ? m[1] : null;
}

async function readLimited(res, limit) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return Buffer.byteLength(text) <= limit ? text : null;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Only the status and a request id reduced to [A-Za-z0-9_-] (max 64) are ever logged.
function safeRequestId(res) {
  const raw = res.headers?.get?.('x-request-id') ?? '';
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || '-';
}
