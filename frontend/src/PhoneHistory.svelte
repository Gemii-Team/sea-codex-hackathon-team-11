<script>
  let code = $state('');
  let reviewKey = $state('');
  let rows = $state([]);
  let record = $state(null);
  let entries = $state([]);
  let status = $state('');
  let loading = $state(false);

  async function read(path, evidence = false) {
    const headers = { 'X-Voice-Demo-Code': code.trim() };
    if (evidence) headers.Authorization = 'Bearer ' + reviewKey.trim();
    const response = await fetch('/api/v1/phone/' + path, { headers });
    if (!response.ok) {
      throw new Error(({ 401: 'กรุณาตรวจรหัสทีม', 403: 'รหัสผู้ตรวจหลักฐานไม่ถูกต้อง',
        404: 'ไม่พบข้อมูลของสายนี้' })[response.status] ?? 'อ่านประวัติสายไม่สำเร็จ');
    }
    return response.json();
  }

  async function browse(id = '') {
    loading = true;
    record = null;
    entries = [];
    reviewKey = '';
    status = '';
    try {
      if (id) record = await read('history/' + encodeURIComponent(id));
      else rows = await read('history');
    } catch (error) {
      rows = [];
      status = error.message;
    } finally { loading = false; }
  }

  async function reveal() {
    loading = true;
    entries = [];
    status = '';
    try {
      entries = (await read('evidence/' + encodeURIComponent(record.contactId), true)).entries ?? [];
    } catch (error) { status = error.message; }
    finally { loading = false; reviewKey = ''; }
  }

  const sources = { fixture: 'ตัวอย่าง', openai_realtime: 'สายฝึก OpenAI', connect: 'Amazon Connect' };
  const kinds = { reference: 'เลขอ้างอิง', link: 'ลิงก์', callback_number: 'เบอร์ติดต่อ', payment_destination: 'ช่องทางรับเงิน' };
  const fmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short' });
</script>

<header class="page-title"><div><h1>ประวัติสายฝึก</h1><p>ทบทวนข้ออ้างของผู้โทรและคำถามของ Agent</p></div></header>
<section class="card">
  <form onsubmit={(event) => { event.preventDefault(); browse(); }}>
    <label>รหัสทีม<input type="password" bind:value={code} required autocomplete="off" /></label>
    <button class="button primary" disabled={loading || !code.trim()}>เปิดประวัติสาย</button>
  </form>
  {#if rows.length}
    <ul>{#each rows as row (row.contactId)}
      <li><button class="agent-link" disabled={loading} onclick={() => browse(row.contactId)}>
        {row.contactName || sources[row.source] || 'สายฝึก'} · {fmt.format(new Date(row.startedAt))}
      </button></li>
    {/each}</ul>
  {/if}
  <p role="status">{loading ? 'กำลังโหลด…' : status}</p>
</section>
{#if record}
  <section class="card">
    <h2>{record.summary?.title || 'บทสนทนา'}</h2>
    <p class="muted">{sources[record.source]} · {record.contactId}</p>
    {#if record.summary?.text}<p>{record.summary.text}</p>{/if}
    {#each record.turns as turn (turn.id)}
      <div class="message"><small>{turn.speaker === 'caller' ? 'ผู้โทร' : 'Agent'}</small><p>{turn.text}</p></div>
    {/each}
    {#if record.transcriptStatus !== 'complete'}<p class="muted">{record.turns.length ? 'มีข้อความถอดเสียงบางส่วน' : 'ยังไม่มีข้อความถอดเสียง'}</p>{/if}
    {#if record.evidenceCount > 0}
      <h3>ข้อมูลที่ผู้โทรกล่าวอ้าง ({record.evidenceCount})</h3>
      <label>รหัสผู้ตรวจหลักฐาน<input type="password" bind:value={reviewKey} autocomplete="off" /></label>
      <button class="button secondary" disabled={loading || !reviewKey.trim()} onclick={reveal}>เปิดหลักฐาน</button>
      {#each entries as entry}
        <p>{kinds[entry.kind] || entry.kind} · {entry.value} <small>({entry.turnId})</small></p>
      {/each}
    {/if}
  </section>
{/if}
