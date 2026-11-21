import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const number = String.raw`(\+?\p{Nd}(?:[ .-]?\p{Nd}){5,14})(?![ .-]?\p{Nd})`;
const separator = String.raw`\s*[:：]?\s*(?:คือ\s*)?`;
const labels = [
  ['payment_destination', new RegExp(String.raw`(?:เลขบัญชี(?:ปลายทาง|ผู้รับโอน)?|บัญชีปลายทาง|(?:เลข|เบอร์)พร้อมเพย์)${separator}${number}`, 'gu')],
  ['callback_number', new RegExp(String.raw`(?:เบอร์(?:โทร)?ติดต่อ|เบอร์โทรกลับ|โทรกลับ(?:ได้)?ที่(?:เบอร์)?)${separator}${number}`, 'gu')],
  ['reference', new RegExp(String.raw`(?:เลข(?:ที่)?อ้างอิง|เลขเคส)${separator}([A-Za-z0-9][A-Za-z0-9-]{2,39})(?![A-Za-z0-9-])`, 'giu')],
];
const link = /https?:\/\/[^\s<>"']+/gi;
const secretLabel = /^(?:OTP|PIN|PASSWORD)(?:-|$)/i;
const secretQuery = /^(?:access_token|auth|code|credential|key|otp|password|pin|secret|session|token)$/i;

export function extractEvidence(text, turnId) {
  const evidence = [];
  for (const [kind, pattern] of labels) {
    for (const [, value] of text.matchAll(pattern)) {
      if (!secretLabel.test(value)) evidence.push({ kind, value, turnId });
    }
  }

  for (const [match] of text.matchAll(link)) {
    const value = match.replace(/[),.!?;\]}]+$/g, '');
    let url;
    try { url = new URL(value); } catch { continue; }
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => secretQuery.test(key))) continue;
    evidence.push({ kind: 'link', value, turnId });
  }

  return evidence;
}

export function maskEvidence(text) {
  let masked = text.replace(link, '[ลิงก์ถูกปิดบัง]');
  for (const { value } of extractEvidence(text)) {
    masked = masked.replaceAll(value, '[ข้อมูลหลักฐานถูกปิดบัง]');
  }
  return masked;
}

export async function createEvidenceAccess(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, 'evidence-key');
  try {
    await writeFile(filename, randomBytes(24).toString('base64url') + '\n', {
      flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const key = (await readFile(filename, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32}$/.test(key)) throw new Error('Invalid local evidence key');
  const expected = Buffer.from('Bearer ' + key);
  return (authorization) => {
    const actual = Buffer.from(authorization ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}
