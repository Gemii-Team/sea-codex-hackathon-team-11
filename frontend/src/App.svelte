<script>
  import { onMount } from 'svelte';
  import Health from './Health.svelte';
  import VoiceDemo from './VoiceDemo.svelte';
  import './portal.css';

  const storageKey = 'wirachit.voice-agents.v1';
  const scenarios = {
    message: { label: 'ฝากข้อความ', caller: 'ขอฝากข้อความให้ติดต่อกลับได้ไหมครับ', reply: 'ได้เลยค่ะ ขอทราบชื่อของคุณก่อนนะคะ' },
    support: { label: 'สอบถามบริการ', caller: 'ขอสอบถามเรื่องบริการหน่อยครับ', reply: 'ยินดีค่ะ คุณสนใจสอบถามเรื่องอะไรคะ' },
    mule: { label: 'AI Mule · สอบถามรายการ', caller: 'คุณมีค่าจัดส่งค้างอยู่ครับ' }
  };
  const muleFollowUps = {
    'เป็นกันเอง': 'ขอรายละเอียดไว้ตรวจสอบหน่อยนะคะ',
    'สุภาพเป็นทางการ': 'รบกวนแจ้งรายละเอียดเพื่อใช้ตรวจสอบด้วยค่ะ',
    'กระชับ': 'ขอรายละเอียดรายการค่ะ'
  };
  const muleEvidence = [
    { label: 'บริษัทที่ผู้โทรอ้าง', value: 'Demo Express', quote: 'โทรจาก Demo Express ครับ' },
    { label: 'ยอดที่แจ้ง', value: '49 บาท', quote: 'ยอด 49 บาทครับ' },
    { label: 'เลขอ้างอิง', value: 'DEMO-042', quote: 'เลขอ้างอิง DEMO-042 ครับ' }
  ];
  const emptyAgent = {
    id: '', name: 'ผู้ช่วยรับสาย', business: 'Wirachit', tone: 'เป็นกันเอง',
    greeting: 'สวัสดีค่ะ นี่คือผู้ช่วย AI ของ Wirachit ค่ะ มีอะไรให้ช่วยไหมคะ',
    instructions: 'ถามชื่อและเรื่องที่ติดต่อ จากนั้นทวนเบอร์โทรกลับทีละหลัก',
    region: 'ap-southeast-1', instance: '', flow: '', number: '',
    persona: 'ผู้ช่วยรับสายที่ถามทีละข้อเพื่อบันทึกข้อมูลสำหรับตรวจสอบ',
    objective: 'เก็บชื่อบริษัทที่ผู้โทรอ้าง ยอดที่แจ้ง และเลขอ้างอิง',
    openingQuestion: 'ติดต่อจากบริษัทไหนคะ',
    voiceURI: '', openAIVoice: 'marin', voiceRate: 1, voicePitch: 1
  };

  function loadAgents() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(saved)) return [];
      const drafts = new Map();
      for (const entry of saved) {
        if (typeof entry?.id !== 'string' || !entry.id.trim()) continue;
        const draft = { ...emptyAgent };
        for (const key of Object.keys(emptyAgent)) {
          if (typeof entry[key] === 'string') draft[key] = entry[key];
        }
        for (const key of ['voiceRate', 'voicePitch']) {
          draft[key] = Number.isFinite(entry[key]) && entry[key] >= 0.7 && entry[key] <= 1.3
            ? entry[key]
            : emptyAgent[key];
        }
        if (isTimestamp(entry.updatedAt)) draft.updatedAt = entry.updatedAt;
        if (Object.hasOwn(scenarios, entry.lastTest?.scenario) && isTimestamp(entry.lastTest.at)) {
          draft.lastTest = entry.lastTest;
        }
        drafts.set(draft.id, draft);
      }
      return [...drafts.values()];
    } catch {
      return [];
    }
  }

  function isTimestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
  }

  let agents = $state(loadAgents());
  let agent = $state({ ...emptyAgent });
  let page = $state('monitor');
  let scenario = $state('message');
  let tried = $state(false);
  let feedback = $state('');
  let search = $state('');
  let thaiVoices = $state.raw([]);
  let voiceStatus = $state('');
  const speech = window.speechSynthesis;
  function refreshVoices() {
    const voices = speech?.getVoices() ?? [];
    thaiVoices = [...new Map(
      voices.filter((voice) => voice.voiceURI && /^th(?:[-_]|$)/i.test(voice.lang))
        .map((voice) => [voice.voiceURI, voice])
    ).values()];
  }
  refreshVoices();
  onMount(() => {
    speech?.addEventListener('voiceschanged', refreshVoices);
    return () => {
      speech?.removeEventListener('voiceschanged', refreshVoices);
      speech?.cancel();
    };
  });
  let previewTurns = $derived(scenario === 'mule' ? [
    { role: 'agent', text: [muleFollowUps[agent.tone], agent.openingQuestion.trim() || emptyAgent.openingQuestion].join(' ') },
    { role: 'caller', text: muleEvidence[0].quote },
    { role: 'agent', text: 'ยอดที่แจ้งมาเท่าไรคะ' },
    { role: 'caller', text: muleEvidence[1].quote },
    { role: 'agent', text: 'ขอเลขอ้างอิงรายการด้วยค่ะ' },
    { role: 'caller', text: muleEvidence[2].quote }
  ] : [{ role: 'agent', text: scenarios[scenario].reply }]);

  function speakPreview() {
    refreshVoices();
    const voice = agent.voiceURI
      ? thaiVoices.find((item) => item.voiceURI === agent.voiceURI)
      : thaiVoices[0];
    if (!voice) {
      voiceStatus = agent.voiceURI ? 'เสียงที่บันทึกไว้ไม่มีในอุปกรณ์นี้ กรุณาเลือกเสียงอีกครั้ง' : 'อุปกรณ์นี้ยังไม่มีเสียงสังเคราะห์ภาษาไทย';
      return;
    }
    const lines = [agent.greeting, ...(tried ? previewTurns.filter(({ role }) => role === 'agent').map(({ text }) => text) : [])];
    speech.cancel();
    const utterance = new SpeechSynthesisUtterance(lines.filter(Boolean).join(' '));
    utterance.lang = voice.lang;
    utterance.voice = voice;
    utterance.rate = agent.voiceRate;
    utterance.pitch = agent.voicePitch;
    voiceStatus = 'กำลังเล่นเสียงภาษาไทย';
    utterance.onend = () => { voiceStatus = 'เล่นเสียงจบแล้ว'; };
    utterance.onerror = ({ error }) => {
      if (error !== 'canceled' && error !== 'interrupted') voiceStatus = 'เล่นเสียงภาษาไทยไม่สำเร็จ';
    };
    speech.speak(utterance);
  }
  let connectFilter = $state('all');
  const dateFormat = new Intl.DateTimeFormat('th-TH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  const hasConnectDetails = (saved) => [saved.region, saved.instance, saved.flow, saved.number]
    .every((value) => value?.trim());
  let configured = $derived(agents.filter(hasConnectDetails).length);
  let tested = $derived(agents.filter((saved) => saved.lastTest).length);
  let query = $derived(search.trim().toLowerCase());
  let visibleAgents = $derived(agents.filter((saved) =>
    (connectFilter === 'all' || hasConnectDetails(saved) === (connectFilter === 'configured')) &&
    [saved.name, saved.business, saved.number].some((value) => value.toLowerCase().includes(query))
  ).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));

  function edit(saved = emptyAgent) {
    speech?.cancel();
    agent = { ...emptyAgent, ...saved };
    scenario = 'message';
    tried = false;
    feedback = '';
    voiceStatus = '';
    page = 'editor';
  }

  function save(event) {
    event.preventDefault();
    if (!agent.name.trim() || !agent.greeting.trim()) {
      feedback = 'กรุณากรอกชื่อและคำทักทาย';
      return;
    }
    const draft = {
      ...$state.snapshot(agent), id: agent.id || crypto.randomUUID(),
      name: agent.name.trim(), updatedAt: new Date().toISOString()
    };
    const next = agents.some(({ id }) => id === draft.id)
      ? agents.map((saved) => saved.id === draft.id ? draft : saved)
      : [...agents, draft];
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      agents = next;
      agent = { ...draft };
      feedback = 'บันทึกร่างในเบราว์เซอร์นี้แล้ว';
    } catch {
      feedback = 'บันทึกร่างไม่ได้ กรุณาตรวจการตั้งค่าพื้นที่จัดเก็บของเบราว์เซอร์';
    }
  }

  function runPreview() {
    tried = true;
    agent.lastTest = { scenario, at: new Date().toISOString() };
  }
</script>

<svelte:window onfocus={refreshVoices} />

<div class="shell">
  <aside class="rail">
    <a class="brand" href="./"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span>Wirachit<small>Voice workspace</small></span></a>
    <nav aria-label="เมนูหลัก">
      <button class={{ active: page === 'monitor' }} aria-current={page === 'monitor' ? 'page' : undefined} onclick={() => page = 'monitor'}><span class="nav-icon" aria-hidden="true">◈</span>ติดตาม Agents</button>
      <button class={{ active: page === 'editor' }} aria-current={page === 'editor' ? 'page' : undefined} onclick={() => edit()}><span class="nav-icon" aria-hidden="true">＋</span>สร้าง Agent</button>
      <button class={{ active: page === 'health' }} aria-current={page === 'health' ? 'page' : undefined} onclick={() => page = 'health'}><span class="nav-icon" aria-hidden="true">◉</span>สถานะระบบ</button>
    </nav>
  </aside>

  {#if page === 'health'}
    <div class="content system-health"><Health /></div>
  {:else if page === 'monitor'}
    <main class="content" lang="th">
      <div class="breadcrumb">Call Center <span aria-hidden="true">/</span> <strong>AI Agents</strong></div>
      <header class="page-title">
        <div><h1>Agent Studio</h1><p>สร้างและติดตามผู้ช่วยรับสายภาษาไทย</p></div>
        <button class="button primary" onclick={() => edit()}>＋ สร้าง Agent</button>
      </header>

      <dl class="agent-metrics" aria-label="สรุป Agents">
        <div class="card"><dt>ร่างทั้งหมด</dt><dd>{agents.length}</dd></div>
        <div class="card"><dt>กรอกข้อมูล Connect ครบ</dt><dd>{configured}</dd></div>
        <div class="card"><dt>บันทึกผลทดสอบจำลอง</dt><dd>{tested}</dd></div>
      </dl>

      <section class="card" aria-labelledby="agent-list">
        <div class="list-heading">
          <div><h2 id="agent-list">Agents</h2><p class="muted">ร่างและผลทดสอบที่บันทึกในเบราว์เซอร์นี้</p></div>
        </div>
        {#if agents.length}
          <div class="list-filters">
            <label>ค้นหา Agent<input type="search" placeholder="ชื่อ ธุรกิจ หรือเบอร์รับสาย" bind:value={search} /></label>
            <label>สถานะ Connect
              <select bind:value={connectFilter}>
                <option value="all">ทุกสถานะ</option>
                <option value="configured">กรอกข้อมูลครบ</option>
                <option value="incomplete">ยังกรอกไม่ครบ</option>
              </select>
            </label>
          </div>
        {/if}
        {#if agents.length === 0}
          <p class="empty-list">ยังไม่มี Agent ที่บันทึกไว้ เริ่มจากสร้าง Agent และลองบทสนทนาจำลองได้เลย</p>
        {:else if visibleAgents.length === 0}
          <div class="empty-list">
            <p role="status">ไม่พบ Agent ที่ตรงกับตัวกรอง</p>
            <button class="button secondary" onclick={() => { search = ''; connectFilter = 'all'; }}>ล้างตัวกรอง</button>
          </div>
        {:else}
          <div class="agent-table">
            <table aria-label="รายชื่อ Agents">
              <thead><tr><th scope="col">Agent</th><th scope="col">Amazon Connect</th><th scope="col">ทดสอบล่าสุด</th><th scope="col">แก้ไขล่าสุด</th></tr></thead>
              <tbody>
                {#each visibleAgents as saved (saved.id)}
                  <tr>
                    <td>
                      <div class="agent-identity">
                        <span class="agent-avatar" aria-hidden="true">{Array.from(saved.name)[0] || 'A'}</span>
                        <div><button class="agent-link" onclick={() => edit(saved)}>{saved.name}</button><small>{saved.business || '—'}</small></div>
                      </div>
                    </td>
                    <td><span class={['setup-status', { configured: hasConnectDetails(saved) }]}>{hasConnectDetails(saved) ? 'กรอกข้อมูลครบ' : 'ยังกรอกไม่ครบ'}</span><small>{saved.number || '—'}</small></td>
                    <td>{saved.lastTest ? scenarios[saved.lastTest.scenario]?.label : 'ยังไม่ได้ทดสอบ'}{#if saved.lastTest}<small>{dateFormat.format(new Date(saved.lastTest.at))}</small>{/if}</td>
                    <td>{saved.updatedAt ? dateFormat.format(new Date(saved.updatedAt)) : '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    </main>
  {:else}
    <main class="content" lang="th">
      <div class="breadcrumb">Call Center <span aria-hidden="true">/</span> <strong>AI Agents</strong></div>
      <header class="page-title">
        <div><h1>{agent.id ? 'แก้ไข Agent' : 'สร้าง Agent'}</h1><p>ตั้งค่าผู้ช่วยรับสายภาษาไทยสำหรับ Amazon Connect</p></div>
        <button class="button secondary" onclick={() => page = 'monitor'}>กลับไปรายชื่อ Agents</button>
      </header>

      <div class="columns">
        <form onsubmit={save}>
          <section class="card" aria-labelledby="profile">
            <h2 id="profile">โปรไฟล์ Agent</h2>
            <div class="fields">
              <label>ชื่อ Agent<input required maxlength="80" bind:value={agent.name} /></label>
              <label>ชื่อธุรกิจ<input maxlength="100" bind:value={agent.business} /></label>
            </div>
            <label>น้ำเสียง<select bind:value={agent.tone}><option>เป็นกันเอง</option><option>สุภาพเป็นทางการ</option><option>กระชับ</option></select></label>
            <label>คำทักทาย<textarea required rows="3" maxlength="500" bind:value={agent.greeting}></textarea></label>
            <label>คำสั่งสำหรับ Agent<textarea rows="3" maxlength="2000" bind:value={agent.instructions}></textarea></label>
          </section>

          <section class="card" aria-labelledby="personalization">
            <h2 id="personalization">บุคลิกและเป้าหมาย</h2>
            <p class="muted">บุคลิกและเป้าหมายจะบันทึกในร่าง พรีวิวจะใช้คำถามแรกและน้ำเสียงที่เลือกกับบทจำลอง</p>
            <label>บุคลิกและบทบาท<textarea rows="2" maxlength="500" bind:value={agent.persona}></textarea></label>
            <label>ข้อมูลที่ต้องการเก็บ<textarea rows="2" maxlength="500" bind:value={agent.objective}></textarea></label>
            <label>คำถามแรกในเดโม AI Mule<input maxlength="200" bind:value={agent.openingQuestion} /></label>
          </section>

          <section class="card" aria-labelledby="voice">
            <h2 id="voice">เสียงภาษาไทย</h2>
            <label>เสียงสังเคราะห์จากอุปกรณ์<select bind:value={agent.voiceURI} onfocus={refreshVoices}>
              <option value="">เสียงไทยอัตโนมัติ</option>
              {#if agent.voiceURI && !thaiVoices.some((voice) => voice.voiceURI === agent.voiceURI)}
                <option value={agent.voiceURI}>เสียงที่บันทึกไว้ (ไม่มีในอุปกรณ์นี้)</option>
              {/if}
              {#each thaiVoices as voice (voice.voiceURI)}
                <option value={voice.voiceURI}>{voice.name}</option>
              {/each}
            </select></label>
            <div class="fields">
              <label>ความเร็ว {agent.voiceRate}×<input type="range" min="0.7" max="1.3" step="0.1" bind:value={agent.voiceRate} /></label>
              <label>ระดับเสียงสูง–ต่ำ {agent.voicePitch}<input type="range" min="0.7" max="1.3" step="0.1" bind:value={agent.voicePitch} /></label>
            </div>
          </section>

          <section class="card" aria-labelledby="connect">
            <h2 id="connect">Amazon Connect Customer</h2>
          <p class="muted">ข้อมูลการเชื่อมต่อจะถูกเก็บในร่างนี้</p>
            <div class="fields">
              <label>AWS Region<input placeholder="ap-southeast-1" bind:value={agent.region} /></label>
              <label>Instance ID<input placeholder="Instance UUID" bind:value={agent.instance} /></label>
              <label>Contact Flow ID<input placeholder="Published flow UUID" bind:value={agent.flow} /></label>
              <label>เบอร์รับสาย<input type="tel" placeholder="+66…" bind:value={agent.number} /></label>
            </div>
            <p class="muted">ผูกเบอร์รับสายกับ Contact Flow ที่เผยแพร่ใน Amazon Connect</p>
            <a href="https://docs.aws.amazon.com/connect/latest/adminguide/associate-claimed-ported-phone-number-to-flow.html" target="_blank" rel="noreferrer">คู่มือการผูกเบอร์กับ Contact Flow ↗</a>
          </section>
          <VoiceDemo {agent} />
          <div class="actions"><button class="button primary" type="submit">บันทึกร่าง</button><span role="status">{feedback}</span></div>
        </form>

        <aside class="preview card" aria-labelledby="preview">
          <div class="preview-heading">
            <h2 id="preview">ตัวอย่างบทสนทนา</h2>
            <span class="simulation">ข้อความจำลอง</span>
          </div>
          <div class="dialogue" aria-live="polite">
            <div class="message"><small>{agent.name.trim() || 'AI Agent'}</small><p>{agent.greeting || 'เพิ่มคำทักทายในโปรไฟล์ Agent'}</p></div>
            {#if tried}
              <div class="message caller"><small>ผู้โทร</small><p>{scenarios[scenario].caller}</p></div>
              {#each previewTurns as turn (turn.text + turn.role)}
                <div class={['message', { caller: turn.role === 'caller' }]}>
                  <small>{turn.role === 'caller' ? 'ผู้โทร' : agent.name.trim() || 'AI Agent'}</small><p>{turn.text}</p>
                </div>
              {/each}
            {/if}
          </div>
          <label>สถานการณ์<select bind:value={scenario} onchange={() => tried = false}>
            {#each Object.entries(scenarios) as [key, item] (key)}
              <option value={key}>{item.label}</option>
            {/each}
          </select></label>
          <div class="preview-actions">
            <button class="button secondary" onclick={runPreview}>ลองบทสนทนา</button>
            <button class="button secondary" onclick={speakPreview}>ฟังเสียงภาษาไทย</button>
          </div>
          {#if voiceStatus}<p class="muted" role="status">{voiceStatus}</p>{/if}
          {#if tried && scenario === 'mule'}
            <section class="mule-summary" aria-labelledby="mule-summary">
              <h3 id="mule-summary">ข้อมูลที่ผู้โทรแจ้ง</h3>
              <dl>
                {#each muleEvidence as item (item.label)}
                  <dt>{item.label}</dt>
                  <dd>{item.value}<br /><small>“{item.quote}”</small></dd>
                {/each}
              </dl>
            </section>
          {/if}
          {#if tried}<p class="muted">บันทึกร่างเพื่อเก็บผลทดสอบในหน้าติดตาม Agents</p>{/if}
        </aside>
      </div>
    </main>
  {/if}
</div>
