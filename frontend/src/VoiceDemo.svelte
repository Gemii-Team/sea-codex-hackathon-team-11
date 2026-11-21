<script>
  import { onDestroy } from 'svelte';

  let { agent } = $props();
  let code = $state('');
  let status = $state('idle');
  let notice = $state('');
  let summary = $state('');
  let audio;
  let call;

  function disconnect() {
    if (!call) return;
    const current = call;
    call = undefined;
    clearTimeout(current.timer);
    current.abort.abort();
    current.peer.close();
    current.stream?.getTracks().forEach((track) => track.stop());
    audio.srcObject = null;
    status = 'idle';
  }
  onDestroy(disconnect);

  function send(channel, event) {
    channel.send(JSON.stringify(event));
  }

  async function start() {
    if (call || !code.trim()) return;
    notice = '';
    summary = '';
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (call !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      peer.ontrack = ({ streams }) => { audio.srcObject = streams[0]; };
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
  <div class="preview-actions">
    {#if status === 'idle'}
      <button type="button" class="button primary" disabled={!code.trim()} onclick={start}>เปิดไมค์และเริ่มคุย</button>
    {:else}
      {#if status === 'live'}
        <button type="button" class="button primary" onclick={finish}>จบสายและสรุป</button>
      {/if}
      <button type="button" class="button secondary" onclick={disconnect}>ตัดสาย</button>
    {/if}
  </div>
  <audio bind:this={audio} autoplay></audio>
  <p class="muted" role="status">{({ starting: 'กำลังเชื่อมต่อ', live: 'กำลังคุย · จำกัด 3 นาที', summarizing: 'กำลังสรุปบทสนทนา' })[status] ?? notice}</p>
  {#if summary}
    <h3>สรุปบทสนทนา</h3>
    <p class="voice-summary">{summary}</p>
  {/if}
</section>
