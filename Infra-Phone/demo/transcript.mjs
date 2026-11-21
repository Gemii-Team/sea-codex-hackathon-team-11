import { extractEvidence, maskEvidence } from './evidence.mjs';

export function maskSensitive(text) {
  return maskEvidence(text).trim()
    .replace(/((?:รหัสผ่าน|รหัสโอทีพี|รหัสพิน|\b(?:OTP|PIN|password)\b)\s*(?:คือ\s*|[:：]\s*))[^\s，,;]+/gi, '$1[รหัสถูกปิดบัง]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[อีเมลถูกปิดบัง]')
    .replace(/\p{Nd}(?:[ .-]?\p{Nd}){3,}/gu, '[ตัวเลขถูกปิดบัง]');
}

export function createTranscript() {
  const items = new Map();
  let incomplete = false;

  function ensure(id, speaker) {
    if (!items.has(id)) items.set(id, { id, speaker, text: '' });
    return items.get(id);
  }

  function accept(event) {
    switch (event.type) {
      case 'conversation.item.added':
      case 'conversation.item.created': {
        const { item } = event;
        if (item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
          ensure(item.id, item.role === 'user' ? 'caller' : 'bot');
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = event.transcript ?? '';
        const item = ensure(event.item_id, 'caller');
        item.text = maskSensitive(text);
        item.evidence = extractEvidence(text, event.item_id);
        break;
      }
      case 'response.output_audio_transcript.done':
        ensure(event.item_id, 'bot').text = maskSensitive(event.transcript ?? '');
        break;
      case 'conversation.item.truncated':
        ensure(event.item_id, 'bot').truncated = true;
        incomplete = true;
        break;
      case 'conversation.item.input_audio_transcription.failed':
      case 'error':
        incomplete = true;
        break;
    }
  }

  function snapshot() {
    const entries = [...items.values()];
    const sensitiveValues = evidence().map(({ value }) => value);
    const turns = entries.filter(({ text, truncated }) => text && !truncated)
      .map(({ id, speaker, text }) => ({
        id, speaker, text: sensitiveValues.reduce((result, value) => result.replaceAll(value, '[ข้อมูลหลักฐานถูกปิดบัง]'), text),
      }));
    const covered = turns.length === entries.length && new Set(turns.map(({ speaker }) => speaker)).size === 2;
    return {
      turns,
      transcriptStatus: turns.length === 0 ? 'unavailable' : covered && !incomplete ? 'complete' : 'partial',
    };
  }

  function evidence() {
    return [...items.values()].flatMap((item) => item.evidence ?? []);
  }

  return { accept, snapshot, evidence };
}
