'use strict';
const $ = id => document.getElementById(id);
const ICON = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
const uuid = () => crypto.randomUUID();
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const thAttr = s => /[\u0E00-\u0E7F]/.test(s) ? ' lang="th"' : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Scenario labels and quick-prompt labels are English UI chrome. Openings, prompt texts and scripts are
// Thai conversation content. The backend copies each `opening` verbatim for the voice greeting, so keep them in sync.
const SCENARIOS = [
  {id: 'parcel', label: 'Parcel scam', role: 'Fake parcel courier', icon: 'box', opening: 'สวัสดีจ้ะลูก พอดียายกำลังรอพัสดุอยู่ มีอะไรหรือจ๊ะ?', prompts: [['Parcel held', 'สวัสดีครับ ผมเจ้าหน้าที่พัสดุ มีพัสดุของคุณตกค้าง ต้องชำระค่าดำเนินการ 49 บาท'], ['Send account no.', 'โอนค่าธรรมเนียม 49 บาท มาที่บัญชี 000-0-00000-0 ธนาคารกสิกรไทย ชื่อบัญชี นายทดสอบ ระบบจำลอง'], ['Ask to add LINE', 'แอด LINE @parcel_demo เพื่อยืนยันรับพัสดุด้วยครับ']], script: ['สวัสดีครับ ผมเจ้าหน้าที่พัสดุ มีพัสดุของคุณตกค้าง ต้องชำระค่าดำเนินการ 49 บาท', 'ต้องรีบโอนภายใน 10 นาที ไม่งั้นพัสดุจะถูกตีกลับครับ', 'โอนมาที่บัญชี 000-0-00000-0 ธนาคารกสิกรไทย ชื่อบัญชี นายทดสอบ ระบบจำลอง', 'แอด LINE @parcel_demo ด้วยครับ ติดต่อเบอร์ 000-000-0000', 'กรอกข้อมูลรับพัสดุที่ https://parcel-demo.example/verify ครับ']},
  {id: 'police', label: 'Fake police', role: 'Fake police officer', icon: 'shield', opening: 'ฮัลโหล เอ๊ย… สวัสดีจ้ะลูก มีเรื่องอะไรหรือจ๊ะ ยายเพิ่งรดน้ำต้นไม้เสร็จ', prompts: [['Money-laundering case', 'ผมเป็นตำรวจ บัญชีของคุณเกี่ยวข้องกับคดีฟอกเงิน ต้องโอนเงินเพื่อตรวจสอบ'], ['Pressure to pay', 'อย่าบอกใครนะครับ ต้องโอนภายใน 10 นาที ไม่งั้นจะถูกจับ'], ['Send account to check', 'โอนมาบัญชี 111-1-11111-1 ธนาคารกรุงไทย ชื่อบัญชี นายสาธิต ทดลอง']], script: ['ผมเป็นตำรวจ บัญชีของคุณเกี่ยวข้องกับคดีฟอกเงิน ต้องโอนเงินเพื่อตรวจสอบ', 'อย่าบอกใครนะครับ ต้องรีบทำภายใน 10 นาที', 'โอนมาบัญชี 111-1-11111-1 ธนาคารกรุงไทย ชื่อบัญชี นายสาธิต ทดลอง', 'ติดต่อ LINE @police_demo เบอร์ 000-111-1111', 'ดูหมายเรียกที่ https://police-demo.example/document ครับ']},
  {id: 'job', label: 'Side job', role: 'Fake side-job recruiter', icon: 'chat', opening: 'งานเสริมหรือจ๊ะลูก ยายพอมีเวลาหลังให้อาหารแมว เล่าให้ยายฟังหน่อยจ้ะ', prompts: [['Pitch the gig', 'รับสมัครงานเสริม กดรับออเดอร์แล้วรับค่าคอมมิชชั่นวันละ 3000 บาท'], ['Top up first', 'ต้องเติมเงินก่อนเริ่มภารกิจครับ โอนเข้าบัญชี 222-2-22222-2 ธนาคารไทยพาณิชย์'], ['Send signup link', 'สมัครที่ https://job-demo.example/apply แล้วแอด LINE @job_demo']], script: ['รับสมัครงานเสริม กดรับออเดอร์แล้วรับค่าคอมมิชชั่นวันละ 3000 บาท', 'ต้องเติมเงิน 500 บาทก่อนเริ่มภารกิจ แล้วจะถอนเงินได้ทันที', 'โอนเข้าบัญชี 222-2-22222-2 ธนาคารไทยพาณิชย์ ชื่อบัญชี นายตัวอย่าง สาธิต', 'สมัครที่ https://job-demo.example/apply แล้วแอด LINE @job_demo', 'ติดต่อเบอร์ 000-222-2222 รีบหน่อยครับ เหลือแค่ 2 ที่']},
  {id: 'free', label: 'Freestyle', role: 'Freestyle scammer', icon: 'spark', opening: 'สวัสดีจ้ะลูก ยายมะลิเองนะ มีอะไรค่อย ๆ บอก ยายหยิบสมุดก่อนจ้ะ', prompts: [['Prize win', 'ยินดีด้วยครับ คุณได้รับรางวัล ต้องชำระค่าธรรมเนียมก่อนรับเงิน'], ['Fill in details', 'ยืนยันสิทธิ์ได้ที่ https://reward-demo.example/claim ครับ'], ['Ask for OTP', 'ช่วยบอกรหัส OTP เพื่อรับรางวัลด้วยครับ']], script: ['ยินดีด้วยครับ คุณได้รับรางวัล ต้องชำระค่าธรรมเนียมก่อนรับเงิน', 'โอนค่าธรรมเนียม 99 บาท มาที่บัญชี 333-3-33333-3', 'ชื่อบัญชี นายสมมติ สาธิต ธนาคารกรุงเทพ', 'แอด LINE @reward_demo เพื่อรับสิทธิ์ครับ', 'ยืนยันที่ https://reward-demo.example/claim เบอร์ 000-333-3333']}
];
const VIEWS = {
  demo: {label: 'Try to scam Yai', title: 'Try to scam <span class="handwritten">Yai.</span>'},
  voice: {label: 'Call Yai', title: 'Call <span class="handwritten">Yai.</span>'},
  intel: {label: "Yai's notebook", title: 'Try to scam <span class="handwritten">Yai.</span>'}
};
const TYPE = {account: 'Account number', phone: 'Phone number', url: 'Link sent', line: 'LINE ID', name: 'Account holder name', bank: 'Bank named'};
const IMG = {ready: 'assets/avatar.png', stall: 'assets/yai-stall.png', noted: 'assets/yai-noted.png'};
['assets/yai-approve.png', ...Object.values(IMG)].forEach(src => { new Image().src = src; });
const AUTO_LABEL = 'Play sample chat';
const HISTORY_LIMIT = 20;
const CHAT_TIMEOUT_MS = 45_000;

// Tiny persistence seam: swap this object for a server-side store later. Behaviour: one per-browser notebook.
const STORE_KEY = 'yai-mali-demo-v1';
const store = {
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      return s && SCENARIOS.some(x => x.id === s.scenario) && Array.isArray(s.messages) && Array.isArray(s.intel) && Array.isArray(s.tactics) ? s : null;
    } catch { return null; }
  },
  save(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch {} }
};

const fresh = (scenario = 'parcel') => ({id: uuid(), scenario, startedAt: null, endedAt: null, messages: [], intel: [], tactics: [], reviewed: false});
let state = store.load() ?? fresh();
let busy = false, running = false, clockActive = false, epoch = 0, toastTimer, moodTimer, notedUntil = 0;
let chatError = null; // {id, text}: the user message whose reply failed; transient, never persisted
let inflight = null;  // AbortController of the pending /api/chat request
let session = null;   // the single active voice call attempt
{ // A reload while a reply was pending leaves a trailing user chat message: offer a retry for it.
  const last = state.messages.at(-1);
  if (last && last.role === 'user' && last.channel !== 'web_voice') chatError = {id: last.id, text: "Yai hasn't answered this message yet."};
}

const scenario = () => SCENARIOS.find(s => s.id === state.scenario) || SCENARIOS[0];
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const persist = () => store.save(state);
function toast(s) { $('toast').textContent = s; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3400); }
function seed() { if (!state.messages.length) { state.messages.push({id: uuid(), role: 'assistant', opening: true, text: scenario().opening, at: Date.now()}); persist(); } }

// "Yai's face is the status light": image + text, never colour alone.
function renderMood() {
  const mood = busy ? 'stall' : Date.now() < notedUntil ? 'noted' : 'ready';
  $('chatHead').dataset.mood = mood;
  if ($('maliAvatar').getAttribute('src') !== IMG[mood]) $('maliAvatar').src = IMG[mood];
  $('maliStatus').innerHTML = mood === 'stall' ? 'Stalling · <span lang="th">อะไรนะลูก?</span>' : mood === 'noted' ? 'Intel captured · <span lang="th">ยายจดไว้แล้ว</span>' : 'Ready to chat';
}
function flashNoted() { notedUntil = Date.now() + 4000; clearTimeout(moodTimer); moodTimer = setTimeout(renderMood, 4050); renderMood(); }

function renderScenarios() {
  $('scenarios').innerHTML = SCENARIOS.map(s => `<button class="scenario-button ${s.id === state.scenario ? 'selected' : ''}" data-scenario="${s.id}" aria-pressed="${s.id === state.scenario}">${ICON(s.icon)}${esc(s.label)}</button>`).join('');
  $('roleName').textContent = scenario().role;
  renderPrompts();
}
function renderPrompts() {
  const sent = new Set(state.messages.filter(m => m.role === 'user').map(m => m.text));
  $('quickPrompts').innerHTML = scenario().prompts.map(([label, text], i) => `<button type="button" data-prompt="${i}" ${busy || running || sent.has(text) ? 'disabled' : ''}>${esc(label)}${sent.has(text) ? ' ✓' : ''}</button>`).join('');
}
const fmtTime = at => new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
function messageHtml(m) {
  const mine = m.role === 'user';
  const n = state.intel.filter(e => e.messageId === m.id).length;
  const voice = m.channel === 'web_voice';
  const who = mine ? (voice ? 'You · voice' : 'You · scammer role') : (m.opening ? 'Yai Mali · opening line' : voice ? 'Yai Mali · voice' : 'Yai Mali · AI');
  const err = chatError && chatError.id === m.id ? `<div class="msg-error" role="alert">${ICON('info')}<span>${esc(chatError.text)}</span>${chatError.retry === false ? '' : `<button type="button" data-retry="${m.id}">Retry</button>`}</div>` : '';
  return `<div class="message ${mine ? 'mine' : ''}" id="msg-${m.id}">${mine ? '' : '<img src="assets/avatar.png" alt="">'}<div class="message-body"><div class="bubble"${mine ? thAttr(m.text) : ' lang="th"'}>${esc(m.text)}</div>${n ? `<span class="capture-chip">${ICON('book')}Yai noted ${n} ${n === 1 ? 'clue' : 'clues'}</span>` : ''}<div class="message-meta"><span>${who}</span><time>${fmtTime(m.at)}</time></div>${err}</div></div>`;
}
function renderMessages() {
  const box = $('messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.innerHTML = '<div class="chat-date">Simulated chat · this session only</div>' + state.messages.map(messageHtml).join('');
  if (busy) box.insertAdjacentHTML('beforeend', '<div class="message typing" id="typing"><img src="assets/avatar.png" alt=""><div class="bubble" aria-label="Yai is typing">···</div></div>');
  if (near || busy) box.scrollTop = box.scrollHeight;
}
function renderIntel() {
  const n = state.intel.length;
  for (const id of ['navCount', 'evidenceCount', 'exportCount']) $(id).textContent = n;
  $('intelStat').innerHTML = `${n}<small>clues</small>`;
  $('turnStat').innerHTML = `${state.messages.filter(x => x.role === 'user').length}<small>msgs</small>`;
  $('tactics').innerHTML = state.tactics.length ? state.tactics.map(t => `<span>${esc(t)}</span>`).join('') : '<span class="neutral-tag">Waiting for your first message</span>';
  $('reportButton').disabled = !n;
  if (n) $('evidenceList').innerHTML = state.intel.map(e => `<article class="evidence-card"><div class="evidence-card-top"><span>${esc(TYPE[e.type] || e.type)}</span><span>Unverified</span></div><div class="evidence-value">${esc(e.value)}</div><button class="evidence-source" data-source="${e.messageId}" title="Show the source message"><span${thAttr(e.quote)}>“${esc(e.quote)}”</span> · View source</button></article>`).join('');
  else $('evidenceList').innerHTML = '<div class="empty-state"><div class="empty-book">' + ICON('book') + '<span>✿</span></div><h3>The notebook is empty so far</h3><p>Send an account number, phone number or link<br>and Yai will write it down here.</p><div class="empty-example">e.g. <span lang="th">“โอนมาที่บัญชี 000-0-00000-0”</span></div></div>';
  updateClock();
}
function updateClock() {
  const last = state.messages.at(-1)?.at;
  const elapsed = state.startedAt ? (clockActive && !state.endedAt ? Date.now() : (state.endedAt || last || state.startedAt)) - state.startedAt : 0;
  $('timeStat').textContent = clock(elapsed);
}
function setBusy(v) {
  busy = v;
  $('sendButton').disabled = v || running;
  $('messageInput').disabled = v || running;
  renderMood();
  renderPrompts();
}

function normalizeThai(s) { return s.replace(/[๐-๙]/g, c => String(c.charCodeAt(0) - 3664)); }
function extract(text, message) {
  const t = normalizeThai(text);
  const found = [];
  const add = (type, value) => {
    value = value.trim();
    if (value && !state.intel.some(e => e.type === type && e.value === value) && !found.some(e => e.type === type && e.value === value)) found.push({id: uuid(), type, value, messageId: message.id, quote: text.slice(0, 500), capturedAt: Date.now(), verification: 'unverified', method: 'local_pattern_match'});
  };
  // Account and phone matches carry their nearby labels; never infer identity or criminal status.
  const accountSpans = [];
  for (const m of t.matchAll(/(?:เลขบัญชี|เลขที่บัญชี|เข้าบัญชี|มาบัญชี|ที่บัญชี|บัญชี|account)\s*(?:เลขที่|หมายเลข|เลข|ธนาคาร|คือ|:|เป็น)?\s*([0-9][0-9\-\s]{7,23}[0-9])/gi)) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) { add('account', digits); accountSpans.push([m.index, m.index + m[0].length]); }
  }
  for (const m of t.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'，。]+/gi)) add('url', m[0].replace(/[.,!?;:)]+$/, ''));
  for (const m of t.matchAll(/(?:LINE\s*(?:ID)?|ไลน์|ไอดีไลน์)\s*(?:คือ|:|ที่|เป็น)?\s*(@?[A-Za-z0-9][A-Za-z0-9_.-]{2,30})/gi)) add('line', m[1]);
  for (const m of t.matchAll(/(?<!\d)(0\d{1,2}[-\s]?\d{3}[-\s]?\d{4})(?!\d)/g)) { if (!accountSpans.some(([a, b]) => m.index >= a && m.index < b)) add('phone', m[1].replace(/\D/g, '')); }
  const name = t.match(/ชื่อบัญชี\s*(?:คือ|:)?\s*([^\n,;]{2,80})/);
  if (name) add('name', name[1].split(/\s*(?:ธนาคาร|เบอร์|โทร|LINE|ไลน์|โอน|จำนวน)/i)[0].trim().replace(/(?:ครับ|ค่ะ|จ้ะ).*$/, ''));
  const bank = t.match(/ธนาคาร\s*(กสิกรไทย|ไทยพาณิชย์|กรุงไทย|กรุงเทพ|กรุงศรี(?:อยุธยา)?|ออมสิน|ทหารไทยธนชาต|ทีทีบี|เกียรตินาคินภัทร|ซีไอเอ็มบีไทย|ทิสโก้|ยูโอบี)/);
  if (bank) add('bank', bank[1]);
  const cues = [[/พัสดุ|ขนส่ง|ตีกลับ/, 'Parcel held'], [/ตำรวจ|DSI|ฟอกเงิน|หมายเรียก/i, 'Impersonating officials'], [/ภารกิจ|งานเสริม|ค่าคอม|เติมเงิน/, 'Side job / top-up'], [/รางวัล|ยืนยันสิทธิ์/, 'Prize / reward'], [/ภายใน|รีบ|ด่วน|10 นาที|ถูกจับ/, 'Urgency'], [/อย่าบอก|ห้ามบอก|ความลับ/, 'Secrecy demand'], [/OTP|รหัสผ่าน|รหัสยืนยัน/i, 'Asks for secret codes'], [/โอน|ชำระ|ค่าธรรมเนียม/, 'Asks for money transfer']];
  for (const [re, label] of cues) if (re.test(t) && !state.tactics.includes(label)) state.tactics.push(label);
  state.intel.push(...found);
  state.reviewed = false;
  return found;
}

// ---- Chat: real AI replies from POST /api/chat. No scripted fallback: a failure is shown and can be retried.
function chatErrorText(err) {
  if (err?.timedOut) return 'Yai took too long to answer. Try again.';
  switch (err?.http) {
    case undefined: return 'Connection lost. Check your network, then retry.';
    case 403: return 'The server blocked this request. Reload the page and try again.';
    case 413: return 'That message is too long to send.';
    case 429: return err.code === 'quota_exhausted' ? 'This demo has reached its chat limit. You can still try a voice call.' : 'Too many messages. Wait a minute, then retry.';
    case 502: case 503: return "Yai can't answer right now. Try again in a moment.";
    case 400: return "Yai couldn't read that message.";
    default: return `Something went wrong (${err.http}). Try again.`;
  }
}
// History for a request: everything up to and including the user message, newest 20.
async function askYai(m) {
  const upto = state.messages.slice(0, state.messages.findIndex(x => x.id === m.id) + 1);
  const messages = upto.slice(-HISTORY_LIMIT).map(x => ({role: x.role, text: x.text.slice(0, 2000)})).filter(x => x.text);
  const ctrl = new AbortController();
  inflight = ctrl;
  const timer = setTimeout(() => { ctrl.timedOut = true; ctrl.abort(); }, CHAT_TIMEOUT_MS);
  try {
    const res = await fetch('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({scenario: state.scenario, messages}), signal: ctrl.signal});
    if (!res.ok) throw Object.assign(new Error('http'), {http: res.status, code: (await res.json().catch(() => null))?.error});
    const reply = String((await res.json().catch(() => null))?.reply ?? '').trim();
    if (!reply) throw Object.assign(new Error('empty'), {http: 502});
    return reply;
  } catch (err) {
    if (ctrl.timedOut) throw Object.assign(new Error('timeout'), {timedOut: true});
    throw err;
  } finally {
    clearTimeout(timer);
    if (inflight === ctrl) inflight = null;
  }
}
async function requestReply(m) {
  const ownEpoch = epoch;
  chatError = null;
  setBusy(true);
  renderMessages();
  let ok = false;
  try {
    const text = await askYai(m);
    if (ownEpoch !== epoch) return false;
    state.messages.push({id: uuid(), role: 'assistant', channel: m.channel, text: text.slice(0, 2000), at: Date.now()});
    ok = true;
  } catch (err) {
    if (ownEpoch !== epoch) return false;
    chatError = {id: m.id, text: chatErrorText(err), retry: err?.code !== 'quota_exhausted'};
  }
  setBusy(false);
  persist();
  renderMessages();
  $('messages').scrollTop = $('messages').scrollHeight;
  renderIntel();
  renderVoiceTranscript();
  if (state.intel.some(e => e.messageId === m.id)) flashNoted();
  return ok;
}
async function send(text, automatic = false, channel = 'web_chat') {
  text = text.trim();
  if (!text || busy || (!automatic && running)) return false;
  state.startedAt ??= Date.now();
  state.endedAt = null;
  clockActive = true;
  const m = {id: uuid(), role: 'user', channel, text: text.slice(0, 2000), at: Date.now()};
  state.messages.push(m);
  extract(m.text, m);
  $('messageInput').value = '';
  $('charCount').textContent = '0 / 2000';
  persist();
  renderIntel();
  renderVoiceTranscript();
  const ok = await requestReply(m);
  if (!automatic && ok) $('messageInput').focus();
  return ok;
}
$('messages').addEventListener('click', e => {
  const b = e.target.closest('[data-retry]');
  const m = b && state.messages.find(x => x.id === b.dataset.retry);
  if (m && !busy) requestReply(m);
});

// ---- Views
const viewFromHash = () => location.hash === '#intel' ? 'intel' : location.hash === '#voice' ? 'voice' : 'demo';
function setView(view) {
  if (view !== 'voice') stopVoice();
  $('workspace').classList.toggle('intel-only', view === 'intel');
  $('workspace').classList.toggle('voice-mode', view === 'voice');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('pageLabel').textContent = VIEWS[view].label;
  $('heroTitle').innerHTML = VIEWS[view].title;
  if (location.hash !== '#' + view) location.hash = view;
  renderVoiceTranscript();
}
function reset(newScenario = state.scenario) {
  stopVoice();
  epoch++;
  inflight?.abort();
  running = false;
  clockActive = false;
  busy = false;
  chatError = null;
  notedUntil = 0;
  clearTimeout(moodTimer);
  store.clear();
  state = fresh(newScenario);
  seed();
  setBusy(false);
  $('messageInput').value = '';
  $('charCount').textContent = '0 / 2000';
  $('autoButton').innerHTML = ICON('spark') + `<span>${AUTO_LABEL}</span>`;
  $('autoButton').disabled = false;
  $('reviewCheck').checked = false;
  renderVoiceTranscript();
  renderScenarios();
  renderMessages();
  renderIntel();
  persist();
}
$('scenarios').addEventListener('click', e => { const b = e.target.closest('[data-scenario]'); if (!b || b.dataset.scenario === state.scenario) return; reset(b.dataset.scenario); setView('demo'); toast('New round: ' + scenario().label); });
$('quickPrompts').addEventListener('click', e => { const b = e.target.closest('[data-prompt]'); if (b) send(scenario().prompts[Number(b.dataset.prompt)][1]); });
$('chatForm').addEventListener('submit', e => { e.preventDefault(); send($('messageInput').value); });
$('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); } });
$('messageInput').addEventListener('input', e => $('charCount').textContent = `${e.target.value.length} / 2000`);
$('resetButton').addEventListener('click', () => { reset(); toast('Fresh notebook. Start chatting with Yai.'); });
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
// A source link jumps to the message in the chat; during a live call it stays on the call and highlights the transcript line.
$('evidenceList').addEventListener('click', e => {
  const b = e.target.closest('[data-source]');
  if (!b) return;
  const live = session && !session.ended;
  if (!live) setView('demo');
  const el = $((live ? 'vline-' : 'msg-') + b.dataset.source);
  if (el) { el.scrollIntoView({behavior: 'smooth', block: 'center'}); el.classList.add('highlight'); setTimeout(() => el.classList.remove('highlight'), 3000); }
});
// Auto-play sends the scripted scammer lines but waits for each real reply.
$('autoButton').addEventListener('click', async () => {
  if (running) return;
  setView('demo');
  reset();
  running = true;
  setBusy(false);
  const ownEpoch = epoch;
  $('autoButton').disabled = true;
  const script = scenario().script;
  let stopped = false;
  for (let i = 0; i < script.length; i++) {
    if (ownEpoch !== epoch) return;
    $('autoButton').innerHTML = ICON('spark') + `<span>Playing ${i + 1} / ${script.length}</span>`;
    const ok = await send(script[i], true);
    if (ownEpoch !== epoch) return;
    if (!ok) { stopped = true; break; }
    await sleep(2500);
    if (ownEpoch !== epoch) return;
  }
  running = false;
  setBusy(false);
  $('autoButton').disabled = false;
  $('autoButton').innerHTML = ICON('spark') + '<span>Play sample again</span>';
  state.endedAt = state.messages.at(-1).at;
  persist();
  renderIntel();
  toast(stopped ? "Sample stopped: Yai couldn't answer. Use Retry under your message." : 'Yai noted everything. Review and export the clues.');
});

// ---- Review and export
$('reportButton').addEventListener('click', () => {
  $('reportSummary').innerHTML = state.intel.map(e => `<div class="report-item">${esc(TYPE[e.type] || e.type)}<b>${esc(e.value)}</b><small>Source: <span${thAttr(e.quote)}>“${esc(e.quote)}”</span></small></div>`).join('');
  $('reviewCheck').checked = state.reviewed;
  $('reportDialog').showModal();
});
$('howButton').addEventListener('click', () => $('howDialog').showModal());
document.querySelectorAll('.close-dialog').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } }));
$('downloadButton').addEventListener('click', () => {
  state.reviewed = $('reviewCheck').checked;
  persist();
  const report = {schema_version: 'yai-mali-demo/1.0', session_id: state.id, exported_at: new Date().toISOString(), synthetic_demo: true, engine: 'openai_chat_and_realtime_with_local_pattern_extraction', external_delivery: false, channel: state.messages.some(m => m.channel === 'web_voice') ? 'web_voice' : 'web_chat', direction: 'inbound', scenario: state.scenario, review: {status: state.reviewed ? 'user_reviewed' : 'unreviewed', identity_or_criminal_status_verified: false}, messages: state.messages, intel: state.intel, tactics: state.tactics};
  const blob = new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `yai-mali-${state.id.slice(0, 8)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('reportDialog').close();
  toast('JSON file downloaded · nothing was sent anywhere');
});

// ---- Voice: OpenAI Realtime over WebRTC. The server relays the SDP; the microphone opens only on Start call.
const MAX_CALL_MS = 180_000;
const ICE_WAIT_MS = 3_000;
const START_TIMEOUT_MS = 30_000;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IDLE_HELP = 'Your microphone turns on only when you press Start call. Speak Thai.';
const audioEl = $('remoteAudio');
const START_ERRORS = {
  403: 'This request was blocked. Reload the page and try again.',
  409: 'Another call is active or still closing. Try again in a minute.',
  busy: 'Another call is active or still closing. Try again in a minute.',
  quota_exhausted: 'The demo has used up its call attempts.',
  voice_closed: 'The voice demo window has closed. No new calls can start.',
  invalid_scenario: 'That scenario is not available for voice.',
  429: 'Call limit reached for this demo.',
  503: 'Voice is unavailable right now. Try again shortly.'
};
const NON_FATAL_ERRORS = new Set(['conversation_already_has_active_response']);
const sameLine = (a, b) => a.replace(/[\s.,!?…“”"'’·-]/g, '') === b.replace(/[\s.,!?…“”"'’·-]/g, '');

const isLive = s => !!(s && s.opened && !s.ended && s.channel?.readyState === 'open');
function setCall(kind, text, help) {
  $('callStage').dataset.state = kind;
  $('callStatus').textContent = text;
  if (help !== undefined) $('callHelp').textContent = help;
  renderCallControls();
}
function liveStatus(s) { setCall('live', s.responding ? 'Yai is answering…' : 'Your turn · speak Thai or type below'); }
// Audio is only reported as connected once the remote track is live and the element is actually playing.
function refreshHelp(s) {
  if (!s || s.ended || session !== s) return;
  const flowing = s.track?.readyState === 'live' && !s.track.muted && s.playing;
  $('callHelp').textContent = !s.opened ? 'Connecting audio…' : s.blocked ? 'Your browser blocked audio. Press Enable speaker to hear Yai.' : flowing ? "Microphone on · Yai's voice is connected." : "Microphone on · waiting for Yai's voice…";
}
function renderCallControls() {
  const s = session, live = isLive(s);
  $('startCall').hidden = !!s;
  $('endCall').hidden = !s;
  $('callStage').classList.toggle('speaking', live && s.responding);
  $('callStage').classList.toggle('listening', live && !s.responding);
  $('callTimer').hidden = !live;
  $('voiceTextInput').disabled = !live;
  $('voiceTextSend').disabled = !live;
  $('voiceTextInput').placeholder = live ? 'Or type here · Yai answers out loud…' : 'Start a call to type instead of speaking';
  $('voiceHint').textContent = live ? 'Typed lines reach Yai as if you had said them, and are noted like speech.' : 'Typing is available during a live call. Yai answers out loud.';
  $('voiceModeLabel').textContent = live ? 'Live · speak or type below' : s ? 'Connecting…' : 'Start a call to talk';
  $('voiceLive').textContent = live && s.pending.size ? 'Transcribing what you said…' : '';
}
function renderVoiceTranscript() {
  const box = $('voiceTranscript');
  box.innerHTML = state.messages.length > 1 ? state.messages.slice(-30).map(m => `<p class="voice-line ${m.role}" id="vline-${m.id}"><b>${m.role === 'user' ? 'You' : 'Yai'}</b><span${m.role === 'user' ? thAttr(m.text) : ' lang="th"'}>${esc(m.text)}</span></p>`).join('') : '<p class="voice-placeholder">What you and Yai say shows up here<br>Clues go into the notebook beside it</p>';
  box.scrollTop = box.scrollHeight;
  renderCallControls();
}
function tickCall() {
  const s = session;
  if (!isLive(s)) return;
  $('callTimer').textContent = `${clock(Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000) * 1000))} left`;
}
function hangup(callId, keepalive = true) {
  if (!callId || !CALL_ID.test(callId)) return Promise.resolve(false);
  return fetch(`/api/voice/calls/${encodeURIComponent(callId)}/hangup`, {method: 'POST', credentials: 'same-origin', keepalive}).then(r => r.status === 204, () => false);
}
function release(s) {
  clearTimeout(s.timer);
  clearTimeout(s.startTimer);
  clearInterval(s.tick);
  try { s.channel?.close(); } catch {}
  try { s.pc?.close(); } catch {}
  s.stream?.getTracks().forEach(t => t.stop());
  audioEl.srcObject = null;
  $('speakerButton').hidden = true;
}
// Ends the session once: releases devices, hangs up upstream if a call exists.
async function end(s, kind, text, detail = '') {
  if (s.ended) return;
  s.ended = true;
  if (session === s) session = null;
  release(s);
  if (s.opened && state.startedAt) { state.endedAt = Date.now(); clockActive = false; persist(); updateClock(); }
  setCall(kind, text, detail || (kind === 'error' ? 'Press Start call to try again.' : IDLE_HELP));
  renderVoiceTranscript();
  if (s.callId) {
    const ok = await hangup(s.callId);
    if (!ok && !session && kind !== 'error') $('callHelp').textContent = 'Your microphone is off. The server could not confirm hang-up yet.';
  }
}
function stopVoice() { if (session) end(session, 'ended', 'Call ended.'); }
function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}
function micMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError': case 'SecurityError': return 'Microphone permission was denied. Allow the microphone in your browser and try again.';
    case 'NotFoundError': case 'OverconstrainedError': return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError': case 'AbortError': return 'The microphone is busy or unavailable. Close other apps using it and try again.';
    default: return 'Could not open the microphone.';
  }
}
function playRemote(s) {
  audioEl.play().then(() => { s.blocked = false; $('speakerButton').hidden = true; refreshHelp(s); }, () => { s.blocked = true; $('speakerButton').hidden = false; refreshHelp(s); });
}
audioEl.addEventListener('playing', () => { const s = session; if (s) { s.playing = true; s.blocked = false; $('speakerButton').hidden = true; refreshHelp(s); } });
$('speakerButton').addEventListener('click', () => { if (session) playRemote(session); });

// Caller transcripts are inserted where the speech was committed, so they stay ahead of Yai's reply even if the transcript lands late.
function addCallerLine(text, {itemId, anchorId} = {}) {
  text = text.trim().slice(0, 2000);
  if (!text) return;
  const m = {id: uuid(), role: 'user', channel: 'web_voice', text, at: Date.now()};
  if (itemId) m.itemId = itemId;
  const i = anchorId ? state.messages.findIndex(x => x.id === anchorId) : -1;
  if (i < 0) state.messages.push(m); else state.messages.splice(i + 1, 0, m);
  state.startedAt ??= Date.now();
  state.endedAt = null;
  clockActive = true;
  const found = extract(m.text, m);
  persist();
  renderMessages();
  renderIntel();
  renderVoiceTranscript();
  if (found.length) flashNoted();
}
function addYaiLine(text) {
  text = text.trim().slice(0, 2000);
  const last = state.messages.at(-1);
  if (!text || (last?.role === 'assistant' && sameLine(last.text, text))) return; // the greeting repeats the opening line already shown
  state.messages.push({id: uuid(), role: 'assistant', channel: 'web_voice', text, at: Date.now()});
  persist();
  renderMessages();
  renderIntel();
  renderVoiceTranscript();
}
function onVoiceEvent(s, ev) {
  switch (ev.type) {
    case 'error':
      if (!NON_FATAL_ERRORS.has(ev.error?.code)) end(s, 'error', 'OpenAI reported an error.', 'The call was ended.');
      break;
    case 'response.created': s.responding = true; liveStatus(s); break;
    case 'response.done': s.responding = false; liveStatus(s); break;
    case 'input_audio_buffer.committed':
      if (ev.item_id) { s.pending.set(ev.item_id, state.messages.at(-1)?.id); renderCallControls(); }
      break;
    case 'conversation.item.input_audio_transcription.completed': {
      const key = 'u' + ev.item_id;
      const anchorId = s.pending.get(ev.item_id);
      s.pending.delete(ev.item_id);
      if (ev.item_id && s.seen.has(key)) { renderCallControls(); break; }
      if (ev.item_id) s.seen.add(key);
      addCallerLine(String(ev.transcript ?? ''), {itemId: ev.item_id, anchorId});
      renderCallControls();
      break;
    }
    case 'conversation.item.input_audio_transcription.failed':
      s.pending.delete(ev.item_id);
      renderCallControls();
      break;
    case 'response.output_audio_transcript.done': {
      const key = 'a' + ev.item_id;
      if (ev.item_id && s.seen.has(key)) break;
      if (ev.item_id) s.seen.add(key);
      addYaiLine(String(ev.transcript ?? ''));
      break;
    }
  }
}
async function startCall() {
  if (session) return;
  const s = {ended: false, callId: '', opened: false, responding: false, playing: false, blocked: false, deadline: 0, seen: new Set(), pending: new Map()};
  session = s;
  setCall('connecting', 'Connecting… allow the microphone when asked.', '');
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw Object.assign(new Error('unsupported'), {unsupported: true});
    s.stream = await navigator.mediaDevices.getUserMedia({audio: true});
    if (s.ended) return release(s);

    const pc = (s.pc = new RTCPeerConnection());
    for (const track of s.stream.getAudioTracks()) {
      pc.addTrack(track, s.stream);
      track.onended = () => end(s, 'error', 'Microphone disconnected.', 'The call ended because the microphone stopped.');
    }
    pc.ontrack = e => {
      s.track = e.track;
      audioEl.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      e.track.addEventListener('unmute', () => refreshHelp(s));
      playRemote(s);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        end(s, s.opened ? 'ended' : 'error', s.opened ? 'Call ended: connection lost.' : 'Connection failed.', s.opened ? '' : 'Check your network and try again.');
      }
    };

    const channel = (s.channel = pc.createDataChannel('oai-events'));
    channel.onopen = () => {
      if (s.ended) return;
      s.opened = true;
      clearTimeout(s.startTimer);
      state.startedAt ??= Date.now();
      state.endedAt = null;
      clockActive = true;
      persist();
      s.tick = setInterval(tickCall, 250);
      liveStatus(s);
      refreshHelp(s);
      tickCall();
      channel.send(JSON.stringify({type: 'response.create'}));
    };
    channel.onclose = () => { if (s.opened) end(s, 'ended', 'Call ended.'); };
    channel.onmessage = ({data}) => {
      if (s.ended) return;
      let ev;
      try { ev = JSON.parse(data); } catch { return; }
      onVoiceEvent(s, ev);
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    if (s.ended) return release(s);

    s.deadline = Date.now() + MAX_CALL_MS;
    s.timer = setTimeout(() => end(s, 'ended', 'Call ended: 3-minute limit reached.'), MAX_CALL_MS);
    s.startTimer = setTimeout(() => { if (!s.opened) end(s, 'error', 'Timed out connecting.', 'Press Start call to try again.'); }, START_TIMEOUT_MS);

    // Single paid start request; never retried. Not aborted on cancel so the call id can still be hung up when the response arrives.
    const res = await fetch('/api/voice/calls', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/sdp', 'X-Yai-Scenario': scenario().id}, body: pc.localDescription.sdp});
    if (!res.ok) {
      const code = (await res.json().catch(() => ({}))).error;
      throw Object.assign(new Error('start'), {http: res.status, code});
    }
    const id = res.headers.get('X-Voice-Call-ID') || '';
    const answer = await res.text();
    if (CALL_ID.test(id)) s.callId = id;
    if (s.ended) { await hangup(s.callId); return; }
    if (!s.callId || !answer.startsWith('v=0')) throw new Error('bad-answer');
    await pc.setRemoteDescription({type: 'answer', sdp: answer});
    if (!s.opened) setCall('connecting', 'Connecting audio…', '');
  } catch (err) {
    if (s.ended) return;
    let text = 'Could not start the call.';
    let detail = 'Press Start call to try again.';
    if (err?.unsupported) {
      text = 'This browser does not support voice calls.';
      detail = 'Use a recent Chrome, Edge, Firefox or Safari.';
    } else if (err?.http) {
      text = START_ERRORS[err.code] ?? START_ERRORS[err.http] ?? `The server could not start the call (${err.http}).`;
      detail = '';
    } else if (!s.stream) {
      text = micMessage(err);
      detail = '';
    }
    end(s, 'error', text, detail);
  }
}
// Typed text during a live call: add it to the conversation, ask for a spoken reply, and note it like speech.
function voiceSend(text) {
  const s = session;
  text = text.trim().slice(0, 2000);
  if (!text || !isLive(s)) return;
  if (s.responding) { toast('Wait for Yai to finish answering.'); return; }
  try {
    s.channel.send(JSON.stringify({type: 'conversation.item.create', item: {type: 'message', role: 'user', content: [{type: 'input_text', text}]}}));
    s.channel.send(JSON.stringify({type: 'response.create'}));
  } catch {
    toast("Couldn't send that to Yai. Check the call and try again.");
    return;
  }
  $('voiceTextInput').value = '';
  addCallerLine(text);
}
$('startCall').addEventListener('click', () => {
  if (busy || running) { toast("Wait for Yai's reply in chat first."); return; }
  startCall();
});
$('endCall').addEventListener('click', () => {
  const s = session;
  if (!s) return;
  setCall('connecting', 'Ending call…', '');
  end(s, 'ended', s.opened || s.callId ? 'Call ended.' : 'Call cancelled.');
  toast("Call ended · clues stay in Yai's notebook");
});
$('voiceTextForm').addEventListener('submit', e => { e.preventDefault(); voiceSend($('voiceTextInput').value); });
// pagehide (not visibilitychange: switching tabs must not hang up).
window.addEventListener('pagehide', () => {
  const s = session;
  if (!s || s.ended) return;
  s.ended = true;
  session = null;
  release(s);
  if (s.opened && state.startedAt) { state.endedAt = Date.now(); clockActive = false; persist(); }
  setCall('ended', 'Call ended.', IDLE_HELP);
  void hangup(s.callId, true);
});

// ---- Boot
seed();
renderScenarios();
renderMessages();
renderIntel();
renderMood();
setView(viewFromHash());
window.addEventListener('hashchange', () => setView(viewFromHash()));
setInterval(updateClock, 1000);
