<script>
  import { onMount } from 'svelte';

  let reading = $state(null);
  let error = $state('');
  let loading = $state(false);

  async function refresh() {
    loading = true;
    error = '';
    try {
      const response = await fetch('/api/v1/status', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Status request failed');
      reading = await response.json();
    } catch {
      reading = null;
      error = 'The status endpoint is unavailable.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(() => {
      if (!loading) refresh();
    }, 15000);
    return () => clearInterval(timer);
  });
</script>

<main>
  <h1>สถานะระบบ</h1>
  <section aria-labelledby="health">
    <div class="heading">
      <h2 id="health">Control plane health</h2>
      <button onclick={refresh} disabled={loading}>Refresh</button>
    </div>
    <div aria-live="polite">
      {#if error}
        <p class="problem">{error}</p>
      {:else if reading}
        <p class:problem={!reading.available}>
          API {reading.available ? 'operational' : 'unreachable'}
        </p>
        <small>Checked <time datetime={reading.checkedAt}>{new Date(reading.checkedAt).toLocaleTimeString()}</time></small>
      {:else}
        <p>Checking API health…</p>
      {/if}
    </div>
  </section>
</main>

<style>
  main { max-width: 56rem; margin: 0 auto; padding: 0 1.5rem; }
  h1 { font-size: clamp(2rem, 6vw, 4rem); letter-spacing: -.04em; }
  section { border: 1px solid #34485d; border-radius: 1rem; padding: 1.5rem; background: #152335; color: #edf6ff; }
  .heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; }
  h2 { margin: 0; font-size: 1.2rem; }
  p { color: #99e8c3; }
  .problem { color: #ffb8a8; }
  small { color: #b8c8da; }
  button { color: inherit; background: #253c54; border: 1px solid #526b83; border-radius: .5rem; padding: .55rem 1rem; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
</style>
