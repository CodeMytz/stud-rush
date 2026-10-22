<script>
  import { app, connect, BUY_URL } from "../lib/store.svelte.js";
  import { NAME } from "../lib/brand.js";
  import { amount, short } from "../lib/format.js";

  const on = $derived(!!app.account);
  const net = $derived(!on ? "—" : app.chainOk ? "Sepolia" : "Wrong network");
</script>

<div class="stack">
  <div class="block between">
    <div class="brand">
      <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true"><rect width="32" height="32" fill="var(--accent)" /><path d="M6 22 12 15l5 4 9-11" fill="none" stroke="var(--accent-ink)" stroke-width="3" /></svg>
      <h1 class="title">{NAME}</h1>
    </div>
    {#if on}
      <span class="mono muted">{short(app.account)}</span>
    {:else}
      <button class="btn primary" onclick={connect}>Connect wallet</button>
    {/if}
  </div>
  <div class="cells">
    <div class="block cell"><span class="kicker">Network</span><b class:ok={on && app.chainOk} class:bad={on && !app.chainOk}>{net}</b></div>
    <div class="block cell"><div class="cellhead"><span class="kicker">STUD</span><a class="buy" href={BUY_URL} target="_blank" rel="noopener noreferrer">Buy STUD ↗</a></div><b>{on ? amount(app.studBal, app.studDec) : "—"}</b></div>
    <div class="block cell"><span class="kicker">Score</span><b>{on ? amount(app.score, 18, 0) : "—"}</b></div>
  </div>
</div>

<style>
  .brand { display: flex; align-items: center; gap: 10px; }
  .cells { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap); }
  .cell { flex-direction: column; align-items: flex-start; justify-content: center; gap: 0; padding-block: 6px; }
  .cell b { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .cellhead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%; }
  .buy { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .ok { color: var(--accent); }
  .bad { color: var(--bad); }
</style>