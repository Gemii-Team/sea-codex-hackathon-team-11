<script>
  import { onMount } from 'svelte';

  let status = $state('loading');

  async function check() {
    status = 'loading';
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const config = await response.json();
      status = typeof config.keyConfigured === 'boolean' ? 'ready' : 'unavailable';
    } catch {
      status = 'unavailable';
    }
  }

  onMount(() => { void check(); });
</script>

{#if status === 'ready'}
  <iframe src="/phone-demo/" title="โทรหายายมะลิและดูประวัติการสนทนา" allow="microphone"></iframe>
{:else}
  <section class="card">
    <p role="status">{status === 'loading'
      ? 'กำลังเชื่อมกับระบบโทร…'
      : 'เปิดเซิร์ฟเวอร์ Infra-Phone ที่ localhost:8783 แล้วลองเชื่อมใหม่'}</p>
    {#if status === 'unavailable'}
      <button type="button" class="button secondary" onclick={check}>ลองเชื่อมใหม่</button>
    {/if}
  </section>
{/if}

<style>
  iframe {
    display: block;
    width: 100%;
    height: max(690px, calc(100vh - 150px));
    border: 1px solid #ddd5c8;
    border-radius: 18px;
    background: #edf2f7;
  }
</style>
