// Typed-chat provider for Yai Mali: one OpenAI Responses API call per reply. No dependencies.
//
// The server key lives only in this module's closure and the Authorization header. The browser
// chooses neither the model nor the instructions (those come from ./persona.mjs).
//
// Errors are ChatError: numeric `.status` and a safe machine `.code` (not_configured,
// rate_limited, quota_exhausted, state_unavailable, upstream_failed). Messages and logs never
// carry prompts, replies, provider response bodies or the key; only an HTTP status and a
// sanitised x-request-id are logged.
//
// Process-wide limits, in addition to the same-origin check: 30 requests per rolling minute and
// 4 in flight, plus a TOTAL cap of CHAT_LIMIT replies for the life of the deployment. The total is
// persisted in `${stateDir}/chat-state.json` ({ version: 1, count }, written atomically) so it
// survives restarts. A request is counted when it is sent upstream; only a definite rejection
// (non-2xx) is refunded, because a timed-out or unreadable call may still have been billed. A
// request refused by any limit never reaches OpenAI.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { chatInstructions } from './persona.mjs';

export const RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const CHAT_MODEL = 'gpt-5.4-mini';
export const MAX_OUTPUT_TOKENS = 400;
export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 60 * 1000;
export const MAX_IN_FLIGHT = 4;
export const CHAT_LIMIT = 2000; // total replies for the life of the deployment
const STATE_FILE = 'chat-state.json';
const MAX_RESPONSE_CHARS = 1024 * 1024;

export class ChatError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'ChatError';
    this.status = status;
    this.code = code;
  }
}

function loadState(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, count: 0 };
    throw new Error(`chat state unreadable (${error.code ?? 'error'})`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error('chat state is not valid JSON');
  }
  if (state?.version !== 1 || !Number.isInteger(state.count) || state.count < 0) {
    throw new Error('chat state has an unexpected shape');
  }
  return { version: 1, count: state.count };
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

export function createChatProvider({
  apiKey,
  stateDir,
  fetchImpl = fetch,
  log = () => {},
  model = CHAT_MODEL,
  timeoutMs = 20_000,
  now = Date.now,
} = {}) {
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('stateDir is required');
  mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, STATE_FILE);
  const state = loadState(stateFile);
  const stamps = []; // start times of requests inside the rolling window, oldest first
  let inFlight = 0;

  function refund() {
    state.count = Math.max(0, state.count - 1);
    try {
      saveState(stateFile, state);
    } catch {
      log('chat: could not persist count refund'); // memory is lower than the file; the file stays the safer bound
    }
  }

  async function reply(scenario, messages) {
    if (!apiKey) throw new ChatError(503, 'not_configured');
    // The total cap comes first: a request refused for it uses neither the minute budget nor OpenAI.
    if (state.count >= CHAT_LIMIT) throw new ChatError(429, 'quota_exhausted');

    const t = now();
    while (stamps.length > 0 && stamps[0] <= t - RATE_WINDOW_MS) stamps.shift();
    if (inFlight >= MAX_IN_FLIGHT || stamps.length >= RATE_LIMIT) throw new ChatError(429, 'rate_limited');

    // Everything from the checks to the reservation is synchronous: concurrent requests cannot
    // overshoot the cap. The request is counted before it is sent upstream.
    state.count += 1;
    try {
      saveState(stateFile, state);
    } catch {
      state.count -= 1;
      log('chat: could not persist count');
      throw new ChatError(503, 'state_unavailable'); // fail closed: spend must stay bounded
    }
    stamps.push(t);
    inFlight += 1;
    try {
      return await ask(scenario, messages);
    } finally {
      inFlight -= 1;
    }
  }

  async function ask(scenario, messages) {
    const payload = {
      model,
      instructions: chatInstructions(scenario),
      input: messages.map(({ role, text }) => ({ role, content: text })),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      reasoning: { effort: 'low' },
      store: false,
    };

    let res;
    try {
      res = await fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      log(`chat: openai request failed (${error?.name ?? 'Error'})`);
      throw new ChatError(502, 'upstream_failed');
    }

    if (res.status < 200 || res.status >= 300) {
      log(`chat: openai HTTP ${res.status} request-id=${safeRequestId(res)}`);
      await res.body?.cancel?.().catch(() => {});
      refund(); // a definite rejection: OpenAI did no work, so the reply is not spent
      throw new ChatError(502, 'upstream_failed');
    }

    let body;
    try {
      const text = await res.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new Error('too large');
      body = JSON.parse(text);
    } catch {
      log(`chat: openai response unreadable request-id=${safeRequestId(res)}`);
      throw new ChatError(502, 'upstream_failed');
    }

    const text = extractText(body);
    if (!text) {
      log(`chat: openai response had no text request-id=${safeRequestId(res)}`);
      throw new ChatError(502, 'upstream_failed');
    }
    return text;
  }

  return { reply };
}

// Prefers the top-level convenience field, else joins every `output_text` part of the output.
function extractText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim() !== '') return body.output_text.trim();
  if (!Array.isArray(body?.output)) return '';
  const parts = [];
  for (const item of body.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
}

// Only a request id reduced to [A-Za-z0-9_-] (max 64) is ever logged.
function safeRequestId(res) {
  const raw = res.headers?.get?.('x-request-id') ?? '';
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || '-';
}
