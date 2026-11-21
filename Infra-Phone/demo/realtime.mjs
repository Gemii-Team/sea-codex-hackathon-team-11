const endpoint = 'https://api.openai.com/v1/realtime/calls';

const instructions = `คุณคือพลอย ผู้ช่วยอัตโนมัติที่เล่นเป็นคุณป้าสมมติวัย 68 ปีในสายทดสอบภาษาไทย
ทักทายว่าเป็นผู้ช่วยอัตโนมัติและสายนี้มีการถอดเสียง แล้วถามว่าติดต่อเรื่องอะไร
พูดช้าและชัดด้วยน้ำเสียงอบอุ่น ใช้คำง่าย ๆ ลงท้ายด้วยค่ะหรือคะ ถามทีละเรื่อง เช่น “พลอยใช้มือถือไม่ค่อยคล่อง ช่วยอธิบายช้า ๆ ได้ไหมคะ”
ตัวละครไม่มีข้อมูลของคนจริง หากต้องใช้ข้อมูลตัวอย่าง ให้ใช้ชื่อพลอย อายุ 68 ปี หรือเลขอ้างอิงทดสอบ DEMO-PLOY-001 เท่านั้น
ถามได้ว่าติดต่อจากหน่วยงานใดและต้องการให้ทำอะไร เมื่อผู้โทรระบุข้อมูลเกี่ยวกับเหตุเอง ให้ฟังและหลีกเลี่ยงการอ่านตัวเลขหรือลิงก์กลับเต็ม ๆ
ห้ามขอ ยืนยัน หรือแจ้ง OTP, PIN, รหัสผ่าน, เลขบัตร, เบอร์โทร หรือเลขบัญชีของพลอย ห้ามอ้างว่าเป็นบุคคลหรือหน่วยงานจริง
ถ้ามีคนขอข้อมูลอ่อนไหว ชวนทำธุรกรรม หรือให้เปิดลิงก์ ให้ปฏิเสธอย่างสุภาพและแนะนำให้ตรวจสอบผ่านช่องทางทางการ`;

export async function startRealtime({ key, model, sdp, onEvent, onClose }) {
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify({
    type: 'realtime',
    model,
    instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'th' },
        turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
      },
      output: { voice: 'marin' },
    },
  }));

  const headers = { Authorization: 'Bearer ' + key };
  const response = await fetch(endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(18_000) });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const code = problem.error?.code;
    const message = response.status === 401 ? 'OpenAI ไม่รับ API key นี้'
      : code === 'insufficient_quota' ? 'บัญชี OpenAI มีเครดิตไม่พอสำหรับเริ่มสาย'
      : 'OpenAI เปิดสายไม่สำเร็จ กรุณาตรวจสิทธิ์โมเดลและเครดิต';
    throw new Error(message);
  }

  const id = response.headers.get('location')?.split('/').pop();
  if (!id || !/^rtc_[A-Za-z0-9_-]+$/.test(id)) throw new Error('OpenAI ไม่ได้ส่ง Call ID กลับมา');
  const answer = await response.text();
  const hangUp = () => fetch(`${endpoint}/${id}/hangup`, {
    method: 'POST', headers, signal: AbortSignal.timeout(6000),
  }).then((result) => result.ok || result.status === 404);

  try {
    const close = await observeRealtime({ key, id, onEvent, onClose });
    return { answer, hangUp, close };
  } catch (error) {
    await hangUp().catch(() => {});
    throw error;
  }
}

export async function observeRealtime({ key, id, onEvent, onClose }) {
  const headers = { Authorization: 'Bearer ' + key };
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${id}`, { headers });
  socket.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') onEvent(JSON.parse(data));
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('รอช่องบันทึกบทสนทนานานเกินไป')), 7500);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('เปิดช่องบันทึกบทสนทนาไม่สำเร็จ'));
      }, { once: true });
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  socket.addEventListener('close', onClose, { once: true });

  return () => socket.close();
}
