import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscript } from './transcript.mjs';

test('orders transcript items even when the caller transcription is delayed', () => {
  const transcript = createTranscript();
  transcript.accept({ type: 'conversation.item.added', item: { id: 'caller', type: 'message', role: 'user' } });
  transcript.accept({ type: 'conversation.item.added', item: { id: 'bot', type: 'message', role: 'assistant' } });
  transcript.accept({ type: 'response.output_audio_transcript.done', item_id: 'bot', transcript: 'สวัสดีค่ะ' });
  transcript.accept({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'caller',
    transcript: 'ขอรหัส ๑๒๓๔ หรืออีเมล demo@example.com',
  });

  assert.deepEqual(transcript.snapshot(), {
    turns: [
      { id: 'caller', speaker: 'caller', text: 'ขอรหัส [ตัวเลขถูกปิดบัง] หรืออีเมล [อีเมลถูกปิดบัง]' },
      { id: 'bot', speaker: 'bot', text: 'สวัสดีค่ะ' },
    ],
    transcriptStatus: 'complete',
  });
});

test('marks an interrupted response partial and omits the unverified transcript', () => {
  const transcript = createTranscript();
  transcript.accept({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'caller', transcript: 'สวัสดีครับ' });
  transcript.accept({ type: 'conversation.item.truncated', item_id: 'bot' });
  transcript.accept({ type: 'response.output_audio_transcript.done', item_id: 'bot', transcript: 'สวัสดีค่ะ' });

  assert.deepEqual(transcript.snapshot(), {
    turns: [{ id: 'caller', speaker: 'caller', text: 'สวัสดีครับ' }],
    transcriptStatus: 'partial',
  });
});

test('keeps full evidence from the caller separate from the masked history', () => {
  const transcript = createTranscript();
  transcript.accept({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'caller',
    transcript: 'เลขบัญชีปลายทาง 000-000-0000 เลขอ้างอิง DEMO-CASE-482957 เบอร์โทรกลับ 000-111-2222 ลิงก์ https://example.invalid/demo รหัสผ่านคือ DemoSecret',
  });
  transcript.accept({
    type: 'response.output_audio_transcript.done', item_id: 'bot',
    transcript: 'เลขอ้างอิง DEMO-PLOY-001 ค่ะ',
  });

  assert.deepEqual(transcript.evidence(), [
    { kind: 'payment_destination', value: '000-000-0000', turnId: 'caller' },
    { kind: 'callback_number', value: '000-111-2222', turnId: 'caller' },
    { kind: 'reference', value: 'DEMO-CASE-482957', turnId: 'caller' },
    { kind: 'link', value: 'https://example.invalid/demo', turnId: 'caller' },
  ]);
  assert.doesNotMatch(JSON.stringify(transcript.snapshot()), /000-000-0000|000-111-2222|DEMO-CASE-482957|example.invalid|DemoSecret/);
});

test('excludes credentials and links carrying credentials from evidence', () => {
  const transcript = createTranscript();
  transcript.accept({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'caller',
    transcript: 'OTP 482957 รหัสผ่าน: DemoSecret เลขอ้างอิง OTP-123456 https://example.invalid/auth?token=mock-token',
  });

  assert.deepEqual(transcript.evidence(), []);
  assert.doesNotMatch(transcript.snapshot().turns[0].text, /482957|DemoSecret|123456|mock-token/);
});
