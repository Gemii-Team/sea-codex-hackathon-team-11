// Direct OpenAI Realtime voice page. Mic is requested only on "Start call".
// No keys here: the server exchanges the SDP offer with OpenAI.
const MAX_CALL_MS = 180_000;
const ICE_WAIT_MS = 3_000;
const START_TIMEOUT_MS = 30_000;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

const $ = (id) => document.getElementById(id);
const startBtn = $('start');
const endBtn = $('end');
const speakerBtn = $('speaker');
const statusEl = $('status');
const detailEl = $('detail');
const audio = $('remote');

let session = null; // the single active attempt

function setStatus(state, text, detail = '') {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
  detailEl.textContent = detail;
  detailEl.hidden = !detail;
}

function busy(on) {
  startBtn.disabled = on;
  endBtn.disabled = !on;
}

function hangup(callId, keepalive = false) {
  if (!callId || !CALL_ID.test(callId)) return Promise.resolve(false);
  return fetch(`/api/voice/calls/${encodeURIComponent(callId)}/hangup`, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive,
  }).then((r) => r.status === 204, () => false);
}

function release(s) {
  clearTimeout(s.timer);
  clearTimeout(s.startTimer);
  try { s.channel?.close(); } catch {}
  try { s.pc?.close(); } catch {}
  s.stream?.getTracks().forEach((t) => t.stop());
  audio.srcObject = null;
  speakerBtn.hidden = true;
}

// Ends the session once: releases devices, hangs up upstream if a call exists.
async function end(s, state, text, detail = '') {
  if (s.ended) return;
  s.ended = true;
  if (session === s) session = null;
  release(s);
  busy(false);
  setStatus(state, text, detail);
  if (s.callId) {
    const ok = await hangup(s.callId);
    if (!ok && !session && statusEl.dataset.state !== 'error') {
      setStatus(state, text, 'Your microphone is off. The server could not confirm hang-up yet.');
    }
  }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function micMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission was denied. Allow the microphone in your browser and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or unavailable. Close other apps using it and try again.';
    default:
      return 'Could not open the microphone.';
  }
}

const START_ERRORS = {
  401: 'Sign-in is required to start a call.',
  403: 'This request was not allowed.',
  busy: 'Another call is active or being closed. Try again in a minute.',
  quota_exhausted: 'The demo has used its 25 call attempts.',
  voice_closed: 'The demo window has closed. No new calls can start.',
  429: 'Call limit reached for this demo.',
  503: 'The voice demo is unavailable right now or the demo window has closed.',
};

function playRemote() {
  audio.play().then(() => { speakerBtn.hidden = true; }, () => { speakerBtn.hidden = false; });
}

async function start() {
  if (session) return;
  const s = { ended: false, callId: '' };
  session = s;
  busy(true);
  setStatus('connecting', 'Connecting… allow the microphone when asked.');

  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw Object.assign(new Error('unsupported'), { unsupported: true });
    }
    s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (s.ended) return release(s);

    const pc = (s.pc = new RTCPeerConnection());
    for (const track of s.stream.getAudioTracks()) {
      pc.addTrack(track, s.stream);
      track.onended = () => end(s, 'error', 'Microphone disconnected.', 'The call was ended because the microphone stopped.');
    }
    pc.ontrack = (e) => { audio.srcObject = e.streams[0] ?? new MediaStream([e.track]); playRemote(); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        end(s, s.opened ? 'ended' : 'error', s.opened ? 'Call ended: connection lost.' : 'Connection failed.',
          s.opened ? '' : 'Check your network and try again.');
      }
    };

    const channel = (s.channel = pc.createDataChannel('oai-events'));
    channel.onopen = () => {
      if (s.ended) return;
      s.opened = true;
      clearTimeout(s.startTimer);
      setStatus('live', 'Live — speak Thai now. Up to 3 minutes.');
      channel.send(JSON.stringify({ type: 'response.create' }));
    };
    channel.onclose = () => { if (s.opened) end(s, 'ended', 'Call ended.'); };
    channel.onmessage = ({ data }) => {
      try {
        if (JSON.parse(data).type === 'error') end(s, 'error', 'OpenAI reported an error.', 'The call was ended.');
      } catch {}
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    if (s.ended) return release(s);

    s.timer = setTimeout(() => end(s, 'ended', 'Call ended: 3-minute limit reached.'), MAX_CALL_MS);
    s.startTimer = setTimeout(
      () => { if (!s.opened) end(s, 'error', 'Timed out connecting.', 'Press Start call to try again.'); },
      START_TIMEOUT_MS,
    );

    // Single paid start request; never retried. Not aborted on cancel so the
    // call id can still be hung up when the response arrives.
    const res = await fetch('/api/voice/calls', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) {
      const code = (await res.json().catch(() => ({}))).error;
      throw Object.assign(new Error('start'), { http: res.status, code });
    }
    const id = res.headers.get('X-Voice-Call-ID') || '';
    const answer = await res.text();
    if (CALL_ID.test(id)) s.callId = id;
    if (s.ended) { await hangup(s.callId); return; }
    if (!s.callId || !answer.startsWith('v=0')) throw new Error('bad-answer');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    if (!s.opened) setStatus('connecting', 'Connecting audio…');
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

startBtn.addEventListener('click', start);
endBtn.addEventListener('click', () => {
  const s = session;
  if (!s) return;
  setStatus('connecting', 'Ending call…');
  end(s, 'ended', s.opened || s.callId ? 'Call ended.' : 'Call cancelled.');
});
speakerBtn.addEventListener('click', playRemote);

// pagehide (not visibilitychange: switching tabs must not hang up).
window.addEventListener('pagehide', () => {
  const s = session;
  if (!s || s.ended) return;
  s.ended = true;
  session = null;
  busy(false);
  setStatus('ended', 'Call ended.');
  release(s);
  void hangup(s.callId, true);
});
