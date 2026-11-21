// Tests for the typed-chat provider. Run with:
//   node --test yai-mali-web/backend/chat.test.mjs
// No network: fetch and the clock are fakes, and the key is a fixture.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHAT_LIMIT, ChatError, createChatProvider } from './chat.mjs';
import { SCENARIO_HINTS, chatInstructions } from './persona.mjs';

const KEY = 'sk-fixture-chat-key-not-a-real-one-0000';
const REPLY = 'ยายจดไว้แล้วจ้ะลูก ขอชื่อบัญชีด้วยนะจ๊ะ';
const MESSAGES = [
  { role: 'assistant', text: 'สวัสดีจ้ะลูก' },
  { role: 'user', text: 'โอนค่าธรรมเนียม 49 บาท มาที่บัญชี 000-0-00000-0' },
];
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const outputText = (text) => ({
  id: 'resp_1',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
  ],
});

function harness(handler = () => json(outputText(REPLY)), options = {}) {
  const calls = [];
  const logs = [];
  const clock = { t: 1_000_000_000_000 };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, init, calls);
  };
  const dir = options.stateDir ?? mkdtempSync(path.join(tmpdir(), 'chat-'));
  const provider = createChatProvider({
    apiKey: KEY, fetchImpl, log: (msg) => logs.push(msg), now: () => clock.t, ...options, stateDir: dir,
  });
  return { provider, calls, logs, clock, dir };
}

describe('reply', () => {
  test('calls the Responses API with model, instructions, input and the key only in Authorization', async () => {
    const h = harness();
    assert.equal(await h.provider.reply('police', MESSAGES), REPLY);
    const [{ url, init, body }] = h.calls;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.instructions, chatInstructions('police'));
    assert.ok(body.instructions.includes(SCENARIO_HINTS.police));
    assert.deepEqual(body.input, [
      { role: 'assistant', content: 'สวัสดีจ้ะลูก' },
      { role: 'user', content: 'โอนค่าธรรมเนียม 49 บาท มาที่บัญชี 000-0-00000-0' },
    ]);
    assert.equal(body.max_output_tokens, 400);
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.equal(body.store, false);
    assert.ok(!init.body.includes(KEY));
    assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type']);
  });

  test('the model is configurable', async () => {
    const h = harness(undefined, { model: 'gpt-test-model' });
    await h.provider.reply('free', MESSAGES);
    assert.equal(h.calls[0].body.model, 'gpt-test-model');
  });

  test('reads the top-level output_text when present', async () => {
    const h = harness(() => json({ output_text: `  ${REPLY}  `, output: [] }));
    assert.equal(await h.provider.reply('free', MESSAGES), REPLY);
  });

  test('joins several output_text parts and skips other parts and items', async () => {
    const h = harness(() => json({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'ยาย' }, { type: 'output_text', text: 'จดแล้วจ้ะ' }] },
      ],
    }));
    assert.equal(await h.provider.reply('free', MESSAGES), 'ยายจดแล้วจ้ะ');
  });

  for (const [name, body] of [
    ['no output', {}],
    ['empty output', { output: [] }],
    ['blank text', outputText('   ')],
    ['only a refusal', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }],
    ['null body', null],
  ]) {
    test(`${name} is upstream_failed`, async () => {
      const h = harness(() => json(body));
      await assert.rejects(h.provider.reply('free', MESSAGES), { status: 502, code: 'upstream_failed' });
    });
  }

  test('non-JSON 200 is upstream_failed', async () => {
    const h = harness(() => new Response('<html>oops</html>', { status: 200 }));
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 502, code: 'upstream_failed' });
  });

  for (const status of [400, 401, 429, 500, 503]) {
    test(`upstream ${status} is upstream_failed; only the status and a request id are logged`, async () => {
      const h = harness(() => json({ error: { message: `secret body ${KEY} ${MESSAGES[1].text}` } }, status, { 'x-request-id': 'req_abc-123' }));
      await assert.rejects(h.provider.reply('free', MESSAGES), (error) => {
        assert.ok(error instanceof ChatError);
        assert.equal(error.status, 502);
        assert.equal(error.code, 'upstream_failed');
        assert.ok(!error.message.includes(KEY));
        return true;
      });
      assert.deepEqual(h.logs, [`chat: openai HTTP ${status} request-id=req_abc-123`]);
    });
  }

  test('a hostile request id is reduced to a safe token before logging', async () => {
    const h = harness(() => json({}, 500, { 'x-request-id': 'req_1"}{ evil' }));
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'upstream_failed' });
    assert.deepEqual(h.logs, ['chat: openai HTTP 500 request-id=req_1evil']);
  });

  test('a network error is upstream_failed and logs nothing but the error name', async () => {
    const h = harness(() => {
      throw Object.assign(new TypeError(`connect failed for ${KEY}`), { cause: KEY });
    });
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 502, code: 'upstream_failed' });
    assert.deepEqual(h.logs, ['chat: openai request failed (TypeError)']);
  });

  test('a timeout is upstream_failed', async () => {
    const h = harness(
      (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
      { timeoutMs: 30 },
    );
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 502, code: 'upstream_failed' });
    assert.deepEqual(h.logs, ['chat: openai request failed (TimeoutError)']);
  });

  test('no key is a 503 not_configured and never calls upstream', async () => {
    const h = harness(undefined, { apiKey: '' });
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 503, code: 'not_configured' });
    assert.equal(h.calls.length, 0);
  });

  test('logs never carry the prompt, the reply or the key', async () => {
    const h = harness();
    await h.provider.reply('free', MESSAGES);
    const bad = harness(() => json({ error: 'x' }, 500));
    await assert.rejects(bad.provider.reply('free', MESSAGES));
    const text = JSON.stringify([...h.logs, ...bad.logs]);
    for (const secret of [KEY, REPLY, MESSAGES[1].text]) assert.ok(!text.includes(secret));
  });
});

describe('limits', () => {
  test('31st request inside a minute is rate_limited and never reaches upstream', async () => {
    const h = harness();
    for (let i = 0; i < 30; i += 1) await h.provider.reply('free', MESSAGES);
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 429, code: 'rate_limited' });
    assert.equal(h.calls.length, 30);
  });

  test('the window rolls: capacity returns as old requests age out', async () => {
    const h = harness();
    for (let i = 0; i < 15; i += 1) await h.provider.reply('free', MESSAGES);
    h.clock.t += 30_000;
    for (let i = 0; i < 15; i += 1) await h.provider.reply('free', MESSAGES);
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'rate_limited' });
    h.clock.t += 30_001; // the first 15 are now older than a minute, the second 15 are not
    for (let i = 0; i < 15; i += 1) await h.provider.reply('free', MESSAGES);
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'rate_limited' });
    h.clock.t += 60_000;
    assert.equal(await h.provider.reply('free', MESSAGES), REPLY);
  });

  test('failed upstream calls still count against the minute', async () => {
    const h = harness(() => json({}, 500));
    for (let i = 0; i < 30; i += 1) await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'upstream_failed' });
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'rate_limited' });
  });

  test('at most 4 in flight: the 5th is refused at once, then a freed slot is reusable', async () => {
    const releases = [];
    const h = harness(() => new Promise((resolve) => releases.push(() => resolve(json(outputText(REPLY))))));
    const running = [0, 1, 2, 3].map(() => h.provider.reply('free', MESSAGES));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 4);
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 429, code: 'rate_limited' });
    assert.equal(h.calls.length, 4);
    releases[0]();
    assert.equal(await running[0], REPLY);
    const fifth = h.provider.reply('free', MESSAGES);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 5);
    for (const release of releases.slice(1)) release();
    assert.deepEqual(await Promise.all([...running.slice(1), fifth]), [REPLY, REPLY, REPLY, REPLY]);
  });

  test('a request refused for being in flight does not use the minute budget', async () => {
    const releases = [];
    let hold = true;
    const h = harness(() => (hold
      ? new Promise((resolve) => releases.push(() => resolve(json(outputText(REPLY)))))
      : json(outputText(REPLY))));
    const running = [0, 1, 2, 3].map(() => h.provider.reply('free', MESSAGES));
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 40; i += 1) await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'rate_limited' });
    hold = false;
    for (const release of releases) release();
    await Promise.all(running);
    // 4 of the 30 are spent, so exactly 26 more fit.
    for (let i = 0; i < 26; i += 1) assert.equal(await h.provider.reply('free', MESSAGES), REPLY);
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'rate_limited' });
    assert.equal(h.calls.length, 30);
  });
});

describe('total cap', () => {
  const stateFile = (dir) => path.join(dir, 'chat-state.json');
  const saved = (dir) => JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  const seed = (dir, count) => writeFileSync(stateFile(dir), JSON.stringify({ version: 1, count }));
  const freshDir = () => mkdtempSync(path.join(tmpdir(), 'chat-'));

  test('the cap is 2000 replies', () => assert.equal(CHAT_LIMIT, 2000));

  test('every request sent upstream is counted in chat-state.json, written atomically and holding nothing else', async () => {
    const h = harness();
    assert.throws(() => saved(h.dir), { code: 'ENOENT' }); // nothing is written before the first request
    for (let i = 1; i <= 3; i += 1) {
      await h.provider.reply('free', MESSAGES);
      assert.deepEqual(saved(h.dir), { version: 1, count: i });
    }
    assert.ok(!existsSync(`${stateFile(h.dir)}.next`));
    assert.ok(!readFileSync(stateFile(h.dir), 'utf8').includes(KEY));
  });

  test('at the cap: 429 quota_exhausted, upstream is not called, and the count stays put', async () => {
    const dir = freshDir();
    seed(dir, CHAT_LIMIT);
    const h = harness(undefined, { stateDir: dir });
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(h.provider.reply('free', MESSAGES), (error) => {
        assert.ok(error instanceof ChatError);
        assert.equal(error.status, 429);
        assert.equal(error.code, 'quota_exhausted');
        return true;
      });
    }
    assert.equal(h.calls.length, 0);
    assert.equal(saved(dir).count, CHAT_LIMIT);
  });

  test('the last reply under the cap succeeds, the next one is quota_exhausted', async () => {
    const dir = freshDir();
    seed(dir, CHAT_LIMIT - 1);
    const h = harness(undefined, { stateDir: dir });
    assert.equal(await h.provider.reply('free', MESSAGES), REPLY);
    assert.equal(saved(dir).count, CHAT_LIMIT);
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 429, code: 'quota_exhausted' });
    assert.equal(h.calls.length, 1);
  });

  test('the count survives a restart: a new provider on the same directory carries on from it', async () => {
    const dir = freshDir();
    const first = harness(undefined, { stateDir: dir });
    for (let i = 0; i < 3; i += 1) await first.provider.reply('free', MESSAGES);
    const second = harness(undefined, { stateDir: dir });
    for (let i = 0; i < 2; i += 1) await second.provider.reply('free', MESSAGES);
    assert.equal(saved(dir).count, 5);
    // Near the cap, the new instance stops at exactly the same place the old one would have.
    seed(dir, CHAT_LIMIT - 1);
    const third = harness(undefined, { stateDir: dir });
    assert.equal(await third.provider.reply('free', MESSAGES), REPLY);
    await assert.rejects(third.provider.reply('free', MESSAGES), { code: 'quota_exhausted' });
    const fourth = harness(undefined, { stateDir: dir });
    await assert.rejects(fourth.provider.reply('free', MESSAGES), { code: 'quota_exhausted' });
    assert.equal(fourth.calls.length, 0);
  });

  test('concurrent requests cannot overshoot the cap: they are counted before they are sent', async () => {
    const dir = freshDir();
    seed(dir, CHAT_LIMIT - 2);
    const releases = [];
    const h = harness(() => new Promise((resolve) => releases.push(() => resolve(json(outputText(REPLY))))), { stateDir: dir });
    const running = [0, 1].map(() => h.provider.reply('free', MESSAGES));
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 429, code: 'quota_exhausted' }); // before either answered
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'quota_exhausted' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.length, 2);
    assert.equal(saved(dir).count, CHAT_LIMIT);
    for (const release of releases) release();
    assert.deepEqual(await Promise.all(running), [REPLY, REPLY]);
    assert.equal(h.calls.length, 2);
  });

  test('the per-minute limit and the total cap are distinct 429s', async () => {
    const h = harness();
    for (let i = 0; i < 30; i += 1) await h.provider.reply('free', MESSAGES);
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 429, code: 'rate_limited' });
    assert.equal(saved(h.dir).count, 30); // a request refused by the minute limit is not counted
    const dir = freshDir();
    seed(dir, CHAT_LIMIT);
    const capped = harness(undefined, { stateDir: dir });
    await assert.rejects(capped.provider.reply('free', MESSAGES), { status: 429, code: 'quota_exhausted' });
  });

  test('a request refused for being in flight is not counted', async () => {
    const releases = [];
    const h = harness(() => new Promise((resolve) => releases.push(() => resolve(json(outputText(REPLY))))));
    const running = [0, 1, 2, 3].map(() => h.provider.reply('free', MESSAGES));
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'rate_limited' });
    assert.equal(saved(h.dir).count, 4);
    for (const release of releases) release();
    await Promise.all(running);
    assert.equal(saved(h.dir).count, 4);
  });

  test('a definite upstream rejection (non-2xx) is refunded', async () => {
    for (const status of [400, 401, 429, 500, 503]) {
      const h = harness(() => json({ error: 'x' }, status));
      await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'upstream_failed' });
      assert.equal(saved(h.dir).count, 0, String(status));
    }
  });

  test('an uncertain failure (timeout, network error, unreadable or empty answer) stays counted: it may have been billed', async () => {
    const cases = [
      ['timeout', (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { timeoutMs: 20 }],
      ['network error', () => { throw new TypeError('connect failed'); }, {}],
      ['unreadable body', () => new Response('<html>', { status: 200 }), {}],
      ['empty answer', () => json({ output: [] }), {}],
    ];
    for (const [name, handler, options] of cases) {
      const h = harness(handler, options);
      await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'upstream_failed' }, name);
      assert.equal(saved(h.dir).count, 1, name);
    }
  });

  test('a missing key is refused before anything is counted', async () => {
    const h = harness(undefined, { apiKey: '' });
    await assert.rejects(h.provider.reply('free', MESSAGES), { code: 'not_configured' });
    assert.throws(() => saved(h.dir), { code: 'ENOENT' });
  });

  test('when the count cannot be saved the request fails closed: 503 state_unavailable, upstream not called', async () => {
    const h = harness();
    mkdirSync(`${stateFile(h.dir)}.next`); // the temporary file cannot be created
    await assert.rejects(h.provider.reply('free', MESSAGES), { status: 503, code: 'state_unavailable' });
    assert.equal(h.calls.length, 0);
    rmdirSync(`${stateFile(h.dir)}.next`);
    assert.equal(await h.provider.reply('free', MESSAGES), REPLY);
    assert.equal(saved(h.dir).count, 1); // the failed attempt was not counted
  });

  test('a state file that cannot be trusted refuses to start; so does a missing directory option', () => {
    for (const content of ['not json', '{}', '{"version":2,"count":1}', '{"version":1,"count":-1}', '{"version":1,"count":1.5}', '{"version":1,"count":"3"}', '[]']) {
      const dir = freshDir();
      writeFileSync(stateFile(dir), content);
      assert.throws(() => createChatProvider({ apiKey: KEY, stateDir: dir }), /chat state/, content);
    }
    assert.throws(() => createChatProvider({ apiKey: KEY }), /stateDir/);
    assert.throws(() => createChatProvider({ apiKey: KEY, stateDir: '' }), /stateDir/);
  });
});
