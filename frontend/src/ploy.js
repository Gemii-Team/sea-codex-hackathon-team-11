export const ployId = 'infra-phone-ploy';
export const ployGreeting = 'สวัสดีค่ะ พลอยเป็นผู้ช่วยอัตโนมัติ สายนี้มีการถอดเสียงค่ะ ติดต่อเรื่องอะไรคะ';

const topics = [
  ['organisation', /(?:จากบริษัท|จากร้าน|โทรจาก|บริษัทชื่อ|ชื่อร้าน)\s*[^\s]{2}/, 'ติดต่อจากหน่วยงานไหนคะ'],
  ['reason', /พัสดุ|ค่าจัดส่ง|ค่าส่ง|ค้างชำระ|คืนเงิน|ตรวจสอบบัญชี|ค่าบริการ/, 'เรื่องนี้เกี่ยวกับอะไรคะ'],
  ['amount', /(?:[\d๐-๙]|เอ็ด|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย|พัน)\s*(?:บาท|สตางค์)/, 'ยอดที่แจ้งเท่าไหร่คะ'],
  ['reference', /(?:เลข|รหัส)(?:อ้างอิง|เคส|รายการ|พัสดุ)\s*(?:คือ|เป็น)?\s*[A-Za-z\d๐-๙]/, 'เรื่องนี้มีเลขอ้างอิงไหมคะ'],
  ['action', /(?:ขอให้|ให้พลอย|ให้คุณ|ช่วยโอน|ช่วยจ่าย|ขอเลข|ชำระ|กดลิงก์|แอดไลน์)/, 'ต้องการให้พลอยทำอะไรคะ'],
  ['deadline', /ภายใน|วันนี้|พรุ่งนี้|ก่อนเที่ยง|ก่อนบ่าย|กำหนดวันที่|ไม่มี(?:กำหนด|เส้นตาย)/, 'มีกำหนดให้ดำเนินการเมื่อไหร่คะ']
];

export function planPloyTurn(words, turns, asked) {
  if (/ขอ(?:จบ|วางสาย)|แค่นี้(?:นะ|ครับ|ค่ะ)|สวัสดี(?:ครับ|ค่ะ).*ลาก่อน|ลาก่อน/.test(words)) {
    return { line: 'ขอบคุณที่แจ้งเรื่องค่ะ สวัสดีค่ะ', end: true };
  }
  if (/อายุเท่าไร|อายุเท่าไหร่|อายุกี่ปี/.test(words)) return { line: 'พลอยอายุหกสิบแปดปีค่ะ' };
  if (/ชื่ออะไร|ชื่อคุณ|ชื่อของคุณ/.test(words)) return { line: 'ชื่อพลอยค่ะ' };
  if (/เลขอ้างอิง(?:ทดสอบ|ของพลอย)/.test(words)) return { line: 'เลขอ้างอิงทดสอบของพลอยคือ DEMO-PLOY-001 ค่ะ' };
  const amounts = text => Array.from(text.matchAll(/([\d๐-๙]+(?:[,.][\d๐-๙]+)*)\s*บาท/g), m => m[1]);
  const earlierAmounts = turns.slice(0, -1).flatMap(amounts);
  if (!asked.has('confirmAmount') && earlierAmounts.length && amounts(words).some(n => !earlierAmounts.includes(n))) {
    asked.add('confirmAmount');
    return { line: 'ขอทวนยอดอีกทีนะคะ พลอยจดไม่ทัน' };
  }
  const paymentRequest = /พร้อมเพย์|เลขบัญชี|เลขบัตร|โอทีพี|OTP|PIN|รหัสผ่าน|เบอร์โทร|ให้โอน|ช่วยโอน|ให้จ่าย|ชำระ|เปิดลิงก์|กดลิงก์|แอด|เพิ่มเพื่อน/i.test(words);
  const preface = paymentRequest ? 'พลอยขอจดไว้ตรวจสอบก่อนค่ะ ' : '';
  if (!paymentRequest && /กลับมา|ตีกลับ/.test(words) && /ร้าน/.test(words) && !asked.has('parcel') && !/พัสดุ|สินค้า/.test(words)) {
    asked.add('parcel');
    return { line: 'อะไรกลับมาที่ร้านนะคะ พลอยได้ยินไม่ชัด' };
  }
  const heard = turns.join(' ');
  const hasMoney = /ค่าส่ง|ค่าจัดส่ง|ค่าบริการ|ชำระ|โอน|เงิน|ยอด|บาท|จ่าย/.test(heard);
  if (!paymentRequest && !/บริษัท|พัสดุ|ร้าน|ตรวจสอบ|ติดต่อ|รายการ|อ้างอิง/.test(heard) && !hasMoney) return {};
  for (const [key, known, question] of topics) {
    if ((key === 'amount' && !hasMoney) || asked.has(key) || known.test(heard)) continue;
    asked.add(key);
    return { line: preface + question };
  }
  return { line: preface + 'พลอยจะตรวจสอบกับหน่วยงานผ่านช่องทางทางการค่ะ ขอบคุณที่แจ้งนะคะ', end: true };
}
