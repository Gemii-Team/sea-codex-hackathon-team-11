const elements = Object.fromEntries([
  'storage', 'contact-name', 'start', 'finish', 'call-status', 'remote', 'refresh',
  'history-status', 'history-list', 'detail', 'evidence-dialog', 'evidence-close',
  'evidence-form', 'evidence-key', 'evidence-submit', 'evidence-status', 'evidence-list',
].map((id) => [id, document.getElementById(id)]));
const card = document.querySelector('.call-card');
const displayDate = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});
const transcriptLabels = {
  complete: 'ถอดเสียงครบสองฝั่ง',
  partial: 'ถอดเสียงได้บางส่วน',
  unavailable: 'ยังไม่มีข้อความถอดเสียง',
};
const evidenceLabels = {
  payment_destination: 'บัญชีปลายทางที่ระบุ',
  callback_number: 'เบอร์โทรกลับที่ระบุ',
  reference: 'เลขอ้างอิงที่ระบุ',
  link: 'ลิงก์ที่ระบุ',
};

let selectedId;
let active;
let ready = false;
let records = [];
let evidenceContactId;
let evidenceRequest;

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'เกิดข้อผิดพลาด');
  return body;
}

function formattedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : displayDate.format(date);
}

function renderList() {
  elements['history-list'].replaceChildren(...records.map((record) => {
    const item = make('li');
    const button = make('button', null, 'record');
    button.type = 'button';
    button.setAttribute('aria-current', String(selectedId === record.contactId));
    const name = record.contactName || 'สาย ' + record.contactId.slice(0, 11);
    const meta = (record.source === 'fixture' ? 'ตัวอย่าง · ' : '') + formattedDate(record.startedAt);
    button.append(make('span', name, 'record-name'), make('span', meta, 'record-meta'));
    button.addEventListener('click', () => { void selectRecord(record.contactId); });
    item.append(button);
    return item;
  }));
}

function showRecord(record) {
  elements.detail.setAttribute('aria-busy', 'false');
  const header = make('header', null, 'detail-header');
  const sources = { openai_realtime: 'OpenAI Realtime', connect: 'Amazon Connect', fixture: 'บทสนทนาตัวอย่าง' };
  const title = record.contactName ?? record.summary?.title ?? 'รายละเอียดสาย';
  header.append(
    make('span', sources[record.source] ?? 'บทสนทนา', 'detail-label'),
    make('h3', title),
    make('p', formattedDate(record.startedAt) + ' · ' + transcriptLabels[record.transcriptStatus], 'detail-meta'),
    make('p', 'Contact ID ' + record.contactId, 'detail-meta'),
  );
  if (record.evidenceCount > 0) {
    const button = make('button', 'เปิดหลักฐานฉบับเต็ม (' + record.evidenceCount + ')', 'quiet evidence-trigger');
    button.type = 'button';
    button.addEventListener('click', () => {
      evidenceContactId = record.contactId;
      elements['evidence-dialog'].showModal();
    });
    header.append(button);
  }
  const summary = make('section', null, 'summary');
  summary.append(make('h4', 'สรุปการสนทนา'));
  const summaryText = record.summary?.text || (record.summaryStatus === 'failed' ? 'สร้างสรุปไม่สำเร็จ' : 'ยังไม่มีสรุปสำหรับสายนี้');
  summary.append(make('p', summaryText));
  const turns = make('ol', null, 'turns');
  for (const turn of record.turns) {
    const item = make('li', null, 'turn ' + turn.speaker);
    item.append(make('span', turn.speaker === 'caller' ? 'ผู้โทร' : 'พลอย', 'speaker'), make('p', turn.text));
    turns.append(item);
  }
  elements.detail.replaceChildren(header, summary, turns);
}

async function selectRecord(id) {
  selectedId = id;
  renderList();
  elements.detail.setAttribute('aria-busy', 'true');
  try {
    const record = await request('/api/history/' + encodeURIComponent(id));
    if (selectedId !== id) return;
    const row = records.find(({ contactId }) => contactId === id);
    if (row) {
      row.contactName = record.contactName ?? row.contactName;
      row.startedAt = record.startedAt;
    }
    renderList();
    showRecord(record);
  } catch (error) {
    if (selectedId !== id) return;
    elements.detail.setAttribute('aria-busy', 'false');
    elements.detail.replaceChildren(make('p', error.message, 'secondary'));
  }
}

async function refreshHistory(preferred = selectedId) {
  elements.refresh.disabled = true;
  elements['history-status'].textContent = 'กำลังโหลด…';
  try {
    records = await request('/api/history');
    elements['history-status'].textContent = '';
    const id = records.some(({ contactId }) => contactId === preferred) ? preferred : records[0]?.contactId;
    if (id) await selectRecord(id);
  } catch (error) {
    elements['history-status'].textContent = error.message;
    elements.detail.setAttribute('aria-busy', 'false');
  } finally {
    elements.refresh.disabled = false;
  }
}

async function refreshConfig() {
  try {
    const status = await request('/api/status');
    ready = status.keyConfigured;
    elements.storage.textContent = status.storage === 's3' ? 'ประวัติใน Amazon S3' : 'ประวัติบนเครื่องนี้';
    if (!active) {
      elements.start.disabled = !ready;
      elements['call-status'].textContent = ready ? 'พร้อมเริ่มสาย · ใช้ข้อมูลสมมติในการทดสอบ' : 'เพิ่ม OPENAI_API_KEY ในไฟล์ .env เพื่อเริ่มสาย';
    }
  } catch {
    if (!active) elements['call-status'].textContent = 'ตรวจการตั้งค่าไม่สำเร็จ';
  }
}

function releaseMedia(call) {
  call.mic?.getTracks().forEach((track) => track.stop());
  call.peer?.close();
  elements.remote.srcObject = null;
  card.dataset.active = 'false';
}

function resetCall() {
  active = null;
  elements.finish.hidden = true;
  elements.finish.disabled = false;
  elements.finish.textContent = 'วางสาย';
  elements.start.hidden = false;
  elements.start.disabled = !ready;
  elements['contact-name'].disabled = false;
}

async function finishCall() {
  const call = active;
  if (!call?.id || call.finishing) return;
  call.finishing = true;
  elements.finish.disabled = true;
  elements['call-status'].textContent = 'กำลังบันทึกบทสนทนา…';
  call.mic?.getAudioTracks().forEach((track) => { track.enabled = false; });
  try {
    const record = await request('/api/calls/' + call.id + '/finish', { method: 'POST' });
    releaseMedia(call);
    resetCall();
    elements['call-status'].textContent = 'วางสายและบันทึกประวัติแล้ว';
    await refreshHistory(record.contactId);
    if (selectedId !== record.contactId) {
      records.unshift(record);
      selectedId = record.contactId;
      renderList();
      showRecord(record);
    }
  } catch (error) {
    releaseMedia(call);
    call.finishing = false;
    elements.finish.disabled = false;
    elements.finish.textContent = 'ลองบันทึกอีกครั้ง';
    elements['call-status'].textContent = error.message;
  }
}

function waitForIce(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, 2500);
    function done() {
      clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === 'complete') done();
    }
    peer.addEventListener('icegatheringstatechange', changed);
  });
}

async function startCall() {
  if (active || !ready) return;
  const call = {};
  active = call;
  elements.start.disabled = true;
  elements['contact-name'].disabled = true;
  elements['call-status'].textContent = 'กำลังเปิดไมโครโฟน…';

  try {
    call.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
    elements['call-status'].textContent = 'กำลังเชื่อมต่อสาย…';
    const peer = new RTCPeerConnection();
    call.peer = peer;
    for (const track of call.mic.getAudioTracks()) peer.addTrack(track, call.mic);
    peer.addEventListener('track', ({ streams, track }) => {
      elements.remote.srcObject = streams[0] ?? new MediaStream([track]);
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed') void finishCall();
    });
    const events = peer.createDataChannel('oai-events');
    events.addEventListener('open', () => {
      events.send(JSON.stringify({
        type: 'response.create',
        response: { instructions: 'ทักทายเป็นภาษาไทย บอกว่าพลอยเป็นผู้ช่วยอัตโนมัติและมีการถอดเสียง แล้วถามว่าติดต่อเรื่องอะไร' },
      }));
      card.dataset.active = 'true';
      elements['call-status'].textContent = 'กำลังสนทนา · พูดผ่านไมโครโฟนได้เลย';
    });
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer);
    const result = await request('/api/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: peer.localDescription.sdp, contactName: elements['contact-name'].value.trim() }),
    });
    call.id = result.contactId;
    await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    elements.start.hidden = true;
    elements.finish.hidden = false;
  } catch (error) {
    releaseMedia(call);
    if (call.id) {
      void fetch('/api/calls/' + call.id + '/finish', { method: 'POST', keepalive: true }).catch(() => {});
    }
    resetCall();
    elements['call-status'].textContent = error.name === 'NotAllowedError'
      ? 'อนุญาตให้เว็บใช้ไมโครโฟน แล้วลองเริ่มสายอีกครั้ง'
      : error.message;
  }
}

elements.start.addEventListener('click', startCall);
elements['evidence-close'].addEventListener('click', () => elements['evidence-dialog'].close());
elements['evidence-dialog'].addEventListener('close', () => {
  evidenceRequest?.abort();
  elements['evidence-form'].reset();
  elements['evidence-form'].hidden = false;
  elements['evidence-submit'].disabled = false;
  elements['evidence-list'].replaceChildren();
  elements['evidence-status'].textContent = '';
});
elements['evidence-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const controller = new AbortController();
  evidenceRequest = controller;
  const key = elements['evidence-key'].value.trim();
  elements['evidence-key'].value = '';
  elements['evidence-submit'].disabled = true;
  elements['evidence-status'].textContent = 'กำลังอ่านหลักฐาน…';
  try {
    const result = await request('/api/evidence/' + encodeURIComponent(evidenceContactId), {
      headers: { Authorization: 'Bearer ' + key },
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    elements['evidence-form'].hidden = true;
    elements['evidence-status'].textContent = 'ค่าตามที่ถอดเสียงจากผู้โทร · รอตรวจสอบ';
    elements['evidence-list'].replaceChildren(...result.entries.flatMap(({ kind, value, turnId }) => {
      const body = make('dd', value);
      body.append(make('small', 'อ้างอิงข้อความ ' + turnId));
      return [make('dt', evidenceLabels[kind]), body];
    }));
  } catch (error) {
    if (!controller.signal.aborted) elements['evidence-status'].textContent = error.message;
  } finally {
    if (!controller.signal.aborted) elements['evidence-submit'].disabled = false;
  }
});
elements.finish.addEventListener('click', finishCall);
elements.refresh.addEventListener('click', () => {
  void refreshConfig();
  void refreshHistory();
});
window.addEventListener('pagehide', () => {
  if (active?.id) void fetch('/api/calls/' + active.id + '/finish', { method: 'POST', keepalive: true }).catch(() => {});
});

void refreshConfig();
void refreshHistory();
