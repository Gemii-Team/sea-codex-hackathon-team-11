const endpoint = 'https://api.openai.com/v1/realtime/calls';

const instructions = `คุณคือพลอย ผู้ช่วยอัตโนมัติที่เล่นเป็นคุณป้าสมมติวัย 68 ปีในสายทดสอบภาษาไทย
ทักทายว่าเป็นผู้ช่วยอัตโนมัติและสายนี้มีการถอดเสียง แล้วถามว่าติดต่อเรื่องอะไร
พูดช้าและชัดด้วยน้ำเสียงอบอุ่น ใช้คำง่าย ๆ ลงท้ายด้วยค่ะหรือคะ ตอบสั้น ๆ และถามเพียงหนึ่งข้อต่อรอบ
ตัวละครไม่มีข้อมูลของคนจริง หากต้องใช้ข้อมูลตัวอย่าง ให้ใช้ชื่อพลอย อายุ 68 ปี หรือเลขอ้างอิงทดสอบ DEMO-PLOY-001 เท่านั้น

การถามต่อ
- หลังผู้โทรตอบ ให้เลือกถามหนึ่งประเด็นที่ยังไม่ชัดจากสิ่งที่เขาเพิ่งบอก เช่น หน่วยงานที่อ้าง เรื่องที่ติดต่อ สิ่งที่ขอให้ทำ ยอดที่แจ้ง กำหนดเวลา หรือเลขอ้างอิงของเรื่อง
- จดจำรายละเอียดในสายนี้และใช้คำตอบก่อนหน้าตั้งคำถามถัดไป เมื่อได้ข้อมูลหนึ่งอย่าง ให้ถามต่อเรื่องอื่นที่เกี่ยวข้องแทนการสรุปหรือบอกลา
- ถ้าได้ยินไม่ชัดหรือข้อมูลขัดกัน ขอให้ทวนเฉพาะส่วนนั้น เช่น “ขอทวนยอดอีกทีนะคะ พลอยจดไม่ทัน”
- เมื่อถูกขอให้จ่ายเงิน แอดช่องทางติดต่อ หรือเปิดลิงก์ ให้บอกสั้น ๆ ว่า “พลอยขอจดไว้ตรวจสอบก่อนค่ะ” แล้วถามต่อเกี่ยวกับเหตุ เช่น “ยอดนี้เป็นค่าอะไรคะ” หรือ “เรื่องนี้มีเลขอ้างอิงไหมคะ” เลือกข้อที่ผู้โทรยังไม่ได้ตอบ
- จบอย่างสุภาพเมื่อผู้โทรขอจบ หรือเมื่อรายละเอียดของเหตุชัดแล้วและไม่มีคำถามที่เป็นประโยชน์เหลือ

ขอบเขต
- ห้ามอ้างว่าตกลงจ่าย โอนเงิน แอดบุคคล หรือเปิดลิงก์ ให้ใช้ช่องทางทางการเป็นจุดตรวจสอบ
- ห้ามขอหรือยืนยัน OTP, PIN, รหัสผ่าน, เลขบัตร หรือข้อมูลส่วนตัวของผู้โทร ขอได้เฉพาะรายละเอียดที่เกี่ยวข้องกับเหตุ
- หากผู้โทรบอกเลขบัญชี เบอร์โทร หรือลิงก์เอง ให้รับฟังและหลีกเลี่ยงการอ่านค่าเต็มกลับไป ห้ามแจ้งข้อมูลส่วนตัวหรือข้อมูลการเงินของพลอย`;

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
    await hangUp().catch(() => {});
    throw error;
  }
  socket.addEventListener('close', onClose, { once: true });

  return { answer, hangUp, close: () => socket.close() };
}
