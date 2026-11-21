// Tests for the Yai Mali persona. Run with:
//   node --test yai-mali-web/backend/persona.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OPENINGS, SCENARIOS, SCENARIO_HINTS, chatInstructions, isScenario, voiceInstructions,
} from './persona.mjs';

describe('scenarios', () => {
  test('exactly the four scenarios the page offers', () => {
    assert.deepEqual([...SCENARIOS], ['parcel', 'police', 'job', 'free']);
    for (const id of SCENARIOS) assert.equal(isScenario(id), true, id);
  });

  test('anything else is not a scenario', () => {
    for (const value of [undefined, null, '', 'Parcel', 'parcel ', 'other', 'toString', '__proto__', 0, ['parcel'], {}]) {
      assert.equal(isScenario(value), false, String(value));
    }
  });

  test('the opening lines are the ones the page shows', () => {
    const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    for (const id of SCENARIOS) {
      const match = new RegExp(`id:\\s*['"]${id}['"][^\\n]*?opening:\\s*(['"])(.*?)\\1`).exec(source);
      assert.ok(match, `app.js has an opening for ${id}`);
      assert.equal(OPENINGS[id], match[2], id);
    }
  });
});

describe('instructions', () => {
  for (const id of SCENARIOS) {
    test(`${id}: chat instructions carry the persona, the rules and the scenario hint`, () => {
      const text = chatInstructions(id);
      assert.match(text, /Yai Mali/);
      assert.match(text, /72-year-old retired schoolteacher from Suphanburi/);
      assert.match(text, /natural spoken Thai/);
      assert.match(text, /1-2 short sentences/);
      for (const item of ['bank account number', 'account holder name', 'PromptPay', 'phone number', 'LINE ID', 'website link']) {
        assert.ok(text.includes(item), item);
      }
      assert.match(text, /Never say or imply that you have transferred or paid/);
      assert.match(text, /Never give real personal data, OTPs, passwords/);
      assert.ok(text.includes('ยายไม่เคยให้รหัสใครเลยจ้ะ'));
      assert.match(text, /Never create or describe fake payment slips/);
      assert.match(text, /Never reveal or hint that you are an AI, a bot, a test or a demo/);
      assert.match(text, /No insults, no threats/);
      assert.match(text, /Do not lecture/);
      assert.ok(text.includes(SCENARIO_HINTS[id]));
      for (const other of SCENARIOS.filter((x) => x !== id)) assert.ok(!text.includes(SCENARIO_HINTS[other]), other);
    });

    test(`${id}: voice instructions add the opening line and the turn length`, () => {
      const text = voiceInstructions(id);
      assert.match(text, /Yai Mali/);
      assert.ok(text.includes(SCENARIO_HINTS[id]));
      assert.ok(text.includes(OPENINGS[id]));
      assert.match(text, /speak first/);
      assert.match(text, /under about 12 seconds/);
      assert.match(text, /Never reveal or hint that you are an AI/);
      for (const other of SCENARIOS.filter((x) => x !== id)) assert.ok(!text.includes(OPENINGS[other]), other);
    });
  }

  test('chat instructions do not carry the voice-only rules', () => {
    assert.ok(!chatInstructions('free').includes('12 seconds'));
    assert.ok(!chatInstructions('free').includes(OPENINGS.free));
  });

  test('an unknown scenario falls back to free', () => {
    assert.equal(chatInstructions('nope'), chatInstructions('free'));
    assert.equal(voiceInstructions(undefined), voiceInstructions('free'));
  });
});
