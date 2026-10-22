<script>
  import { app, EXPLORER, switchNetwork } from "../lib/store.svelte.js";
  import { short } from "../lib/format.js";

  // One status row: contract state first, then the last transaction.
  const alert = $derived(
    !app.deployed ? { text: "Game contract not deployed yet. Run npm run deploy:sepolia." }
    : app.error ? { text: app.error }
    : app.account && !app.chainOk ? { text: "Wrong network. Switch MetaMask to Ethereum Sepolia.", action: "Switch" }
    : null,
  );
</script>

{#if alert}
  <div class="block between note bad">
    <span>{alert.text}</span>
    {#if alert.action}<button class="btn" onclick={switchNetwork}>{alert.action}</button>{/if}
  </div>
{:else if app.tx}
  <div class="block between note" class:ok={app.tx.state === "ok"} class:bad={app.tx.state === "bad"} class:wait={app.tx.state === "wait"}>
    <span>{app.tx.text}</span>
    {#if app.tx.hash}<a class="mono" href="{EXPLORER}/tx/{app.tx.hash}" target="_blank" rel="noopener noreferrer">{short(app.tx.hash)} ↗</a>{/if}
  </div>
{/if}

<style>
  .note { box-shadow: inset 3px 0 0 var(--muted); }
  .note.ok { box-shadow: inset 3px 0 0 var(--accent); }
  .note.bad { box-shadow: inset 3px 0 0 var(--bad); }
  .note.wait { box-shadow: inset 3px 0 0 var(--warn); }
  span { min-width: 0; overflow-wrap: anywhere; }
</style>
