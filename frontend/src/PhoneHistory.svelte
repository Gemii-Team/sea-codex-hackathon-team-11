<script>
  import { onMount } from 'svelte';
  import { tabCalls } from './callHistory.js';

  let { localPhoneDemo = false } = $props();
  let rows = $state([]);
  let record = $state(null);
  let status = $state('');
  let loading = $state(false);

  onMount(async () => {
    if (!localPhoneDemo) {
      rows = tabCalls();
      return;
    }
    loading = true;
    try {
      const response = await fetch('/api/history', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      rows = (await response.json()).filter((row) => row.source !== 'fixture');
    } catch {
      status = 'อ่านประวัติจากเซิร์ฟเวอร์ Infra-Phone ไม่สำเร็จ';
    } finally { loading = false; }
  });

  async function browse(contactId, token) {
    loading = true;
    record = null;
    status = '';
    try {
      const base = localPhoneDemo ? '/api/history/' : '/api/v1/phone/history/';
      const res = await fetch(base + encodeURIComponent(contactId), {
        headers: token ? { 'X-Voice-Recording-Token': token } : {}
      });
      if (!res.ok) throw new Error(res.status === 404 ? 'ยังไม่พบประวัติสายนี้' : 'อ่านประวัติสายไม่สำเร็จ');
      record = await res.json();
    } catch (error) {
      status = error.message;
    } finally { loading = false; }
  }

  const sources = { fixture: 'ตัวอย่าง', openai_realtime: 'สายฝึก OpenAI', connect: 'Amazon Connect' };
  const fmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short' });
</script>

<header class="page-title"><div><h1>ประวัติสายฝึก</h1><p>ทบทวนข้ออ้างของผู้โทรและคำถามของ Agent</p></div></header>
<section class="card">
  <h2>{localPhoneDemo ? 'สายที่บันทึกไว้' : 'สายที่ฝึกในแท็บนี้'}</h2>
  {#if rows.length}
    <ul>{#each rows as row (row.contactId)}
      <li><button class="agent-link" disabled={loading} onclick={() => browse(row.contactId, row.token)}>
        {row.contactName || 'สายฝึก'} · {fmt.format(new Date(row.startedAt))}
      </button></li>
    {/each}</ul>
  {:else}
    <p>{localPhoneDemo ? 'เมื่อวางสาย ประวัติจะปรากฏที่นี่' : 'เมื่อจบสายที่ฝึกในแท็บนี้ คุณจะเปิดอ่านบทสนทนาได้ที่นี่'}</p>
  {/if}
  <button type="button" class="button secondary" disabled={loading} onclick={() => browse('demo-otp-request')}>ดูตัวอย่างประวัติสาย</button>
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
      <p class="muted">รายละเอียดหลักฐานสงวนไว้สำหรับผู้ตรวจ</p>
    {/if}
  </section>
{/if}
