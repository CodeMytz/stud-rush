<script>
  import { app, actions } from "../lib/store.svelte.js";
  import { amount, roundAt, short, same } from "../lib/format.js";
  import Match from "./Match.svelte";

  const MAX = 16;
  const connected = $derived(!!app.account && app.chainOk && app.deployed);
  const active = $derived(app.games.find((g) => g.id === app.activeId));
  // A player can only be in one running game at a time.
  const inPlay = $derived(!!active && !active.settled && roundAt(active.start, active.skipped, app.now).r <= 5);
  const canEnter = $derived(connected && !app.busy && !inPlay);
  const fee = $derived(amount(app.fee, app.studDec, 0));

  const open = $derived(
    app.games
      .map((g) => ({ ...g, ri: roundAt(g.start, g.skipped, app.now) }))
      .filter((g) => !g.settled && g.ri.r <= 5),
  );
</script>

<div class="stack">
  <div class="block between">
    <h2 class="title">Lobby</h2>
    <button class="btn primary" disabled={!canEnter} onclick={actions.create}>Create game · {fee} STUD</button>
  </div>

  <Match />

  <div class="cols head kicker"><span>Game</span><span>Host</span><span>Players</span><span>Pot</span><span></span></div>
  {#each open as g (g.id)}
    <div class="cols">
      <b>#{g.id}</b>
      <span class="mono muted">{same(g.creator, app.account) ? "You" : short(g.creator)}</span>
      <span>{g.count}/{MAX}</span>
      <span>{amount(g.pot, app.studDec, 0)}</span>
      <span class="end act">
        {#if g.joined}
          <span class="muted">Joined</span>
        {:else if g.ri.r === 0}
          <span class="muted">Waiting</span>
          <button class="btn primary" disabled={!canEnter || g.count >= MAX} onclick={() => actions.join(g.id)}>Join · {fee} STUD</button>
        {:else}
          <span class="muted">Live · R{g.ri.r}</span>
        {/if}
      </span>
    </div>
  {:else}
    <div class="empty">No open games. Create one to start.</div>
  {/each}
</div>
