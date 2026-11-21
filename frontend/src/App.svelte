<script>
  import Health from './Health.svelte';
  import './portal.css';

  const storageKey = 'wirachit.voice-agents.v1';
  const scenarios = {
    message: { label: 'ฝากข้อความ', caller: 'ขอฝากข้อความให้ติดต่อกลับได้ไหมครับ', reply: 'ได้เลยค่ะ ขอทราบชื่อของคุณก่อนนะคะ' },
    support: { label: 'สอบถามบริการ', caller: 'ขอสอบถามเรื่องบริการหน่อยครับ', reply: 'ยินดีค่ะ คุณสนใจสอบถามเรื่องอะไรคะ' }
  };
  const emptyAgent = {
    id: '', name: 'ผู้ช่วยรับสาย', business: 'Wirachit', tone: 'เป็นกันเอง',
    greeting: 'สวัสดีค่ะ นี่คือผู้ช่วย AI ของ Wirachit ค่ะ มีอะไรให้ช่วยไหมคะ',
    instructions: 'ถามชื่อและเรื่องที่ติดต่อ จากนั้นทวนเบอร์โทรกลับทีละหลัก',
    region: 'ap-southeast-1', instance: '', flow: '', number: ''
  };

  function loadAgents() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  let agents = $state(loadAgents());
  let agent = $state({ ...emptyAgent });
  let page = $state('agents');
  let scenario = $state('message');
  let tried = $state(false);
  let feedback = $state('');

  function edit(saved = emptyAgent) {
    agent = { ...saved };
    tried = false;
    feedback = '';
    page = 'agents';
  }

  function save(event) {
    event.preventDefault();
    if (!agent.name.trim() || !agent.greeting.trim()) {
      feedback = 'กรุณากรอกชื่อและคำทักทาย';
      return;
    }
    const draft = { ...$state.snapshot(agent), id: agent.id || crypto.randomUUID(), name: agent.name.trim() };
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
</script>

<div class="shell">
  <aside class="rail">
    <a class="brand" href="./"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span>Wirachit<small>Voice workspace</small></span></a>
    <nav aria-label="เมนูหลัก">
      <button class:active={page === 'agents'} aria-pressed={page === 'agents'} onclick={() => page = 'agents'}><span class="nav-icon" aria-hidden="true">◈</span>AI Agents</button>
      <button class:active={page === 'health'} aria-pressed={page === 'health'} onclick={() => page = 'health'}><span class="nav-icon" aria-hidden="true">◉</span>สถานะระบบ</button>
    </nav>
    {#if agents.length}
      <div class="saved">
        <h2>ร่างที่บันทึก</h2>
        {#each agents as saved (saved.id)}
          <button class:active={page === 'agents' && saved.id === agent.id} aria-pressed={page === 'agents' && saved.id === agent.id} onclick={() => edit(saved)}>{saved.name}</button>
        {/each}
      </div>
    {/if}
  </aside>

  {#if page === 'health'}
    <div class="content system-health"><Health /></div>
  {:else}
    <main class="content" lang="th">
      <div class="breadcrumb">Call Center <span aria-hidden="true">/</span> <strong>AI Agents</strong></div>
      <header class="page-title">
        <div><h1>Agent Studio</h1><p>ตั้งค่าผู้ช่วยรับสายภาษาไทยสำหรับ Amazon Connect</p></div>
        <button class="button secondary" onclick={() => edit()}>＋ สร้าง Agent</button>
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
              <div class="message"><small>{agent.name.trim() || 'AI Agent'}</small><p>{scenarios[scenario].reply}</p></div>
            {/if}
          </div>
          <label>สถานการณ์<select bind:value={scenario} onchange={() => tried = false}>
            {#each Object.entries(scenarios) as [key, item] (key)}
              <option value={key}>{item.label}</option>
            {/each}
          </select></label>
          <button class="button secondary" onclick={() => tried = true}>ลองบทสนทนา</button>
        </aside>
      </div>
    </main>
  {/if}
</div>
