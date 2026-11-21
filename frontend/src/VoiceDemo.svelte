<script>
  import { onDestroy } from 'svelte';

  let { agent } = $props();
  let code = $state('');
  let status = $state('idle');
  let notice = $state('');
  let summary = $state('');
  let consent = $state(false);
  let recordingStatus = $state('');
  let savedRecording = $state.raw(null);
  let saving = $state(false);
  let audio;
  let call;

  function disconnect() {
    if (!call) return;
    const current = call;
    call = undefined;
    clearTimeout(current.timer);
    current.abort.abort();
    current.peer.close();
    if (current.recorder?.state === 'recording') {
      saving = true;
      current.recorder.stop();
    }
    void current.audioContext?.close();
    current.stream?.getTracks().forEach((track) => track.stop());
    if (audio) audio.srcObject = null;
    status = 'idle';
  }
  onDestroy(disconnect);

  async function saveRecording(current) {
    if (!current.recording || !current.chunks.length) {
      saving = false;
      recordingStatus = 'ไม่มีข้อมูลเสียงให้บันทึก';
      return;
    }
    saving = true;
    recordingStatus = 'กำลังบันทึกไฟล์เสียง';
    try {
      const response = await fetch(current.recording.url, {
        method: 'PUT',
        headers: { ...current.recording.headers, 'Content-Type': 'audio/webm' },
        body: new Blob(current.chunks, { type: 'audio/webm' })
      });
      if (!response.ok && response.status !== 409) throw new Error();
      savedRecording = current.recording;
      recordingStatus = 'บันทึกไฟล์เสียงบนเซิร์ฟเวอร์แล้ว';
    } catch {
      recordingStatus = 'บันทึกไฟล์เสียงไม่สำเร็จ';
    } finally {
      saving = false;
    }
  }

  async function downloadRecording() {
    try {
      const response = await fetch(savedRecording.url, { headers: savedRecording.headers });
      if (!response.ok) throw new Error();
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = savedRecording.url.split('/').pop() + '.webm';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      recordingStatus = 'ดาวน์โหลดไฟล์เสียงไม่สำเร็จ';
    }
  }

  function send(channel, event) {
    channel.send(JSON.stringify(event));
  }

  async function start() {
    if (call || saving || !consent || !code.trim()) return;
    if (!window.MediaRecorder?.isTypeSupported('audio/webm;codecs=opus')) {
      notice = 'เบราว์เซอร์นี้บันทึกเสียง WebM ไม่ได้ กรุณาใช้ Chrome หรือ Edge';
      return;
    }
    notice = '';
    summary = '';
    recordingStatus = '';
    savedRecording = null;
    status = 'starting';
    const profile = {
      Name: agent.name, Persona: agent.persona, Objective: agent.objective,
      Greeting: agent.greeting, Instructions: agent.instructions,
      Question: agent.openingQuestion, Tone: agent.tone, Voice: agent.openAIVoice
    };
    let current;
    try {
      const peer = new RTCPeerConnection();
      current = { peer, abort: new AbortController() };
      call = current;
      const audioContext = new AudioContext();
      current.audioContext = audioContext;
      const destination = audioContext.createMediaStreamDestination();
      const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
      current.recorder = recorder;
      current.chunks = [];
      recorder.ondataavailable = ({ data }) => { if (data.size) current.chunks.push(data); };
      recorder.onstop = () => { void saveRecording(current); };
      await audioContext.resume();
      if (call !== current) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (call !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      audioContext.createMediaStreamSource(stream).connect(destination);
      for (const track of stream.getTracks()) peer.addTrack(track, stream);

      peer.ontrack = ({ track }) => {
        const remote = new MediaStream([track]);
        audio.srcObject = remote;
        audioContext.createMediaStreamSource(remote).connect(destination);
      };
      peer.onconnectionstatechange = () => {
        if (call === current && ['failed', 'closed'].includes(peer.connectionState)) {
          notice = 'สายเสียงสิ้นสุดแล้ว';
          disconnect();
        }
      };
      const channel = peer.createDataChannel('oai-events');
      current.channel = channel;
      channel.onopen = () => {
        if (call !== current) return;
        current.recorder.start();
        status = 'live';
        send(channel, { type: 'response.create', response: { instructions: 'กล่าวคำทักทายตามโปรไฟล์ แล้วรอให้ผู้โทรพูด' } });
      };
      channel.onmessage = ({ data }) => {
        if (call !== current) return;
        const event = JSON.parse(data);
        if (event.type === 'response.done' && event.response.metadata?.purpose === 'demo-summary') {
          const result = event.response.output.flatMap((item) => item.content ?? [])
            .map((part) => part.text ?? '').join('').trim();
          summary = result;
          notice = result ? 'จบสายแล้ว' : 'สรุปบทสนทนาไม่สำเร็จ';
          disconnect();
        }
        if (event.type === 'error') {
          notice = status === 'summarizing' ? 'สรุปบทสนทนาไม่สำเร็จ' : 'OpenAI ส่งข้อผิดพลาดระหว่างเดโม';
          disconnect();
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      current.timer = setTimeout(() => {
        if (call !== current) return;
        notice = 'หมดเวลาเดโม';
        disconnect();
      }, 180_000);
      const response = await fetch('/api/v1/voice/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Voice-Demo-Code': code.trim() },
        body: JSON.stringify({ ...profile, SDP: offer.sdp }),
        signal: current.abort.signal
      });
      if (!response.ok) {
        const message = {
          401: 'รหัสเข้าทดสอบไม่ถูกต้อง',
          429: 'มีสายเดโมอยู่หรือใช้โควตาครบแล้ว',
          503: 'ยังไม่ได้เปิดเดโมเสียงบนเซิร์ฟเวอร์'
        }[response.status];
        throw new Error(message ?? 'เริ่มสาย OpenAI ไม่สำเร็จ');
      }
      current.recording = {
        url: '/api/v1/voice/recordings/' + encodeURIComponent(response.headers.get('X-Voice-Call-ID')),
        headers: {
          'X-Voice-Demo-Code': code.trim(),
          'X-Voice-Recording-Token': response.headers.get('X-Voice-Recording-Token')
        }
      };
      await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (error) {
      if (current && call !== current) return;
      notice = error.name === 'NotAllowedError' ? 'กรุณาอนุญาตการใช้ไมโครโฟน' : error.message;
      disconnect();
      status = 'idle';
    }
  }

  function finish() {
    if (status !== 'live' || call.channel.readyState !== 'open') return;
    status = 'summarizing';
    call.stream.getAudioTracks().forEach((track) => { track.enabled = false; });
    send(call.channel, {
      type: 'response.create',
      response: {
        conversation: 'none',
        metadata: { purpose: 'demo-summary' },
        output_modalities: ['text'],
        instructions: 'สรุปบทสนทนาเป็นภาษาไทยจากคำพูดจริงของผู้โทรเท่านั้น ระบุบริษัทที่อ้าง ยอดและเลขอ้างอิงพร้อมข้อความสั้น ๆ ที่ได้ยิน ข้อมูลใดไม่มีให้ระบุว่าไม่แจ้ง ห้ามเติมข้อมูลสมมติหรือแสดงความลับ'
      }
    });
  }
</script>

<section class="card voice-demo" aria-labelledby="voice-demo-title">
  <h2 id="voice-demo-title">คุยสดกับ OpenAI</h2>
  <label>เสียง OpenAI<select bind:value={agent.openAIVoice} disabled={status !== 'idle'}>
    <option value="marin">Marin</option>
    <option value="cedar">Cedar</option>
    <option value="coral">Coral</option>
  </select></label>
  <label>รหัสเข้าทดสอบ<input type="password" autocomplete="off" bind:value={code} disabled={status !== 'idle'} /></label>
  <label class="recording-consent"><input type="checkbox" bind:checked={consent} disabled={status !== 'idle'} /> ทุกคนในสายทดสอบยินยอมให้บันทึกเสียง</label>
  <div class="preview-actions">
    {#if status === 'idle'}
      <button type="button" class="button primary" disabled={!code.trim() || !consent || saving} onclick={start}>เปิดไมค์และเริ่มคุย</button>
    {:else}
      {#if status === 'live'}
        <button type="button" class="button primary" onclick={finish}>จบสายและสรุป</button>
      {/if}
      <button type="button" class="button secondary" onclick={disconnect}>ตัดสาย</button>
    {/if}
  </div>
  <audio bind:this={audio} autoplay></audio>
  <p class="muted" role="status">{({ starting: 'กำลังเชื่อมต่อ', live: 'กำลังคุย · จำกัด 3 นาที', summarizing: 'กำลังสรุปบทสนทนา' })[status] ?? notice}</p>
  {#if recordingStatus}<p class="muted" role="status">{recordingStatus}</p>{/if}
  {#if savedRecording}
    <button type="button" class="button secondary" onclick={downloadRecording}>ดาวน์โหลดไฟล์เสียง</button>
  {/if}
  {#if summary}
    <h3>สรุปบทสนทนา</h3>
    <p class="voice-summary">{summary}</p>
  {/if}
</section>
