<script>
  import { app, actions } from "../lib/store.svelte.js";
  import { amount, roundAt, same, short } from "../lib/format.js";
  import { ZeroAddress } from "ethers";

  const rows = $derived(
    app.games
      .map((g) => ({ ...g, ri: roundAt(g.start, g.skipped, app.now) }))
      .filter((g) => !g.cancelled && (g.settled || g.ri.r > 5))
      .slice(0, 8),
  );
</script>

<div class="stack">
  <div class="block"><h2 class="title">Recent games</h2></div>
  <div class="cols head kicker"><span>Game</span><span>Winner</span><span>Players</span><span>Pot</span><span></span></div>
  {#each rows as g (g.id)}
    <div class="cols">
      <b>#{g.id}</b>
      {#if !g.settled}
        <span class="muted">Awaiting payout</span>
      {:else if g.winner === ZeroAddress}
        <span class="muted">Refunded</span>
      {:else if same(g.winner, app.account)}
        <span class="you">You · {g.winnerWins} wins</span>
      {:else}
        <span class="mono">{short(g.winner)} <span class="muted">· {g.winnerWins} wins</span></span>
      {/if}
      <span>{g.count}</span>
      <span>{amount(g.pot, app.studDec, 0)}</span>
      <span class="end act">
        {#if !g.settled}
          <button class="btn" disabled={!app.account || !app.chainOk || app.busy} onclick={() => actions.settle(g.id)}>Settle</button>
        {/if}
      </span>
    </div>
  {:else}
    <div class="empty">No finished games yet.</div>
  {/each}
</div>

<style>
  .you { color: var(--accent); font-weight: 600; }
</style>
