import assert from 'node:assert/strict';
import test from 'node:test';
import { planPloyTurn } from './ploy.js';

test('uses disclosed facts and changes topic after asking', () => {
  const asked = new Set();
  const claim = 'โทรจากบริษัทฟ้าใสค่ะ มียอดค่าจัดส่ง 49 บาทค่ะ';
  assert.match(planPloyTurn(claim, [claim], asked).line, /อ้างอิง/);
  const request = 'ขอเลขพร้อมเพย์ที่ผูกกับมือถือค่ะ';
  const next = planPloyTurn(request, [claim, request], asked);
  assert.match(next.line, /^พลอยขอจดไว้ตรวจสอบก่อนค่ะ/);
  assert.doesNotMatch(next.line, /สอง เจ็ด|2742|อ้างอิง/);
  assert.equal((next.line.match(/คะ/g) ?? []).length, 1);
});

test('clarifies inconsistent amounts and closes when asked', () => {
  const turns = ['ค่าจัดส่ง 49 บาทค่ะ', 'ยอดเป็น 90 บาทค่ะ'];
  assert.match(planPloyTurn(turns[1], turns, new Set()).line, /ทวนยอด/);
  assert.equal(planPloyTurn('ขอวางสายค่ะ', turns, new Set()).end, true);
});
