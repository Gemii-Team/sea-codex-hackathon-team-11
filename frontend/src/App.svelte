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
      if (!Array.isArray(saved)) return [];
      const drafts = new Map();
      for (const entry of saved) {
        if (typeof entry?.id !== 'string' || !entry.id.trim()) continue;
        const draft = { ...emptyAgent };
        for (const key of Object.keys(emptyAgent)) {
          if (typeof entry[key] === 'string') draft[key] = entry[key];
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
  const dateFormat = new Intl.DateTimeFormat('th-TH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  const hasConnectDetails = (saved) => [saved.region, saved.instance, saved.flow, saved.number]
    .every((value) => value?.trim());
  let configured = $derived(agents.filter(hasConnectDetails).length);
  let tested = $derived(agents.filter((saved) => saved.lastTest).length);
  let visibleAgents = $derived(agents.filter((saved) => [saved.name, saved.business, saved.number]
    .some((value) => value?.toLowerCase().includes(search.trim().toLowerCase()))));

  function edit(saved = emptyAgent) {
    agent = { ...emptyAgent, ...saved };
    scenario = 'message';
    tried = false;
    feedback = '';
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
          {#if agents.length}
            <label>ค้นหา Agent<input type="search" placeholder="ชื่อ ธุรกิจ หรือเบอร์รับสาย" bind:value={search} /></label>
          {/if}
        </div>
        {#if agents.length === 0}
          <p class="empty-list">ยังไม่มี Agent ที่บันทึกไว้ เริ่มจากสร้าง Agent และลองบทสนทนาจำลองได้เลย</p>
        {:else if visibleAgents.length === 0}
          <p class="empty-list" role="status">ไม่พบ Agent ที่ตรงกับการค้นหา</p>
        {:else}
          <div class="agent-table">
            <table aria-label="รายชื่อ Agents">
              <thead><tr><th scope="col">Agent</th><th scope="col">Amazon Connect</th><th scope="col">ทดสอบล่าสุด</th><th scope="col">แก้ไขล่าสุด</th></tr></thead>
              <tbody>
                {#each visibleAgents as saved (saved.id)}
                  <tr>
                    <td><button class="agent-link" onclick={() => edit(saved)}>{saved.name}</button><small>{saved.business || '—'}</small></td>
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
          <button class="button secondary" onclick={runPreview}>ลองบทสนทนา</button>
          {#if tried}<p class="muted">บันทึกร่างเพื่อเก็บผลทดสอบในหน้าติดตาม Agents</p>{/if}
        </aside>
      </div>
    </main>
  {/if}
</div>
