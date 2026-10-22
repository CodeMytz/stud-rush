<script>
  import { app, actions, EXPLORER } from "../lib/store.svelte.js";
  import { amount, clock, feePts, pct, pts, roundAt, same, short, ROUND_S } from "../lib/format.js";

  const MAX = 16;
  const g = $derived(app.games.find((x) => x.id === app.activeId));
  const ri = $derived(g ? roundAt(g.start, g.skipped, app.now) : null);
  const d = $derived(app.detail && g && app.detail.id === g.id ? app.detail : null);
  const deals = $derived(d && ri && ri.r >= 1 && ri.r <= 5 ? d.deals[ri.r - 1] : null);
  const myPick = $derived(d && ri && ri.r >= 1 && ri.r <= 5 ? d.picks[ri.r - 1] : 0);
  const open = $derived(!!ri && ri.r >= 1 && ri.r <= 5);
  const canPick = $derived(open && !myPick && !app.busy && app.chainOk);
  const isHost = $derived(!!g && same(g.creator, app.account));
  const canAct = $derived(!app.busy && app.chainOk);
  let showPlayers = $state(false);

  const title = $derived(
    !ri ? "" : ri.r === 0 ? "Waiting for players" : ri.r <= 5 ? `Round ${ri.r} of 5` : g.settled ? "Finished" : "Game over",
  );
  const iWon = $derived(!!g && g.settled && same(g.winner, app.account));

  function tile(r) {
    if (!d || !ri) return ["—", ""];
    if (ri.r > r + 1) return d.winners[r] && same(d.winners[r], app.account) ? ["Won", "won"] : d.picks[r] ? ["Lost", "lost"] : ["Missed", "lost"];
    if (ri.r === r + 1) return d.picks[r] ? ["Locked", "locked"] : ["Open", "open"];
    return ["—", ""];
  }
</script>

{#if g && ri}
  <div class="stack">
    <section class="game">
      <header class="head">
        <div class="who">
          <span class="kicker">Game #{g.id}</span>
          <h3 class="title">{title}</h3>
        </div>
        <div class="stats">
          <div class="stat"><span class="kicker">Pot</span><b class="mono">{amount(g.pot, app.studDec, 0)} STUD</b></div>
          {#if d && ri.r >= 1}<div class="stat"><span class="kicker">Score</span><b class="mono">{pts(d.total)}</b></div>{/if}
          {#if open}<div class="timer mono" class:low={ri.left <= 10}>{clock(ri.left)}</div>{/if}
        </div>
      </header>
      <div class="bar">{#if open}<div class="fill" style:width={Math.round((ri.left / ri.total) * 100) + "%"}></div>{/if}</div>

      <div class="body">
        {#if ri.r === 0}
          <div class="waiting">
            <div class="count mono"><b>{g.count}</b><span>/ {MAX}</span></div>
            <p class="muted">
              {#if g.count < 2}At least 2 players are needed to start. Waiting for someone to join…
              {:else if isHost}{g.count} players are in. Start when you are ready.
              {:else}Waiting for the host to start the game…{/if}
            </p>
          </div>
          <div class="actions">
            {#if isHost}
              <button class="btn" disabled={!canAct} onclick={() => actions.cancel(g.id)}>Cancel game</button>
              <button class="btn primary" disabled={!canAct || g.count < 2} onclick={() => actions.begin(g.id)}>Start game</button>
            {:else}
              <button class="btn" disabled={!canAct} onclick={() => actions.leave(g.id)}>Leave game</button>
            {/if}
          </div>
        {:else if ri.r <= 5}
          <div class="deals">
            {#each [0, 1, 2, 3] as i}
              {@const deal = deals?.[i]}
              <button class="deal" class:mine={myPick === i + 1} disabled={!canPick || !deal} onclick={() => actions.pick(g.id, i)}>
                <span class="kicker">{"ABCD"[i]}{myPick === i + 1 ? " · Your pick" : ""}</span>
                <span class="rate mono">{deal ? pct(deal.rate) : "—"}</span>
                <span class="line"><span class="muted">Periods</span><b class="mono">{deal ? deal.periods : "—"}</b></span>
                <span class="line"><span class="muted">Fee</span><b class="mono">{deal ? feePts(deal.feeBps) : "—"}</b></span>
              </button>
            {/each}
          </div>
          <div class="status">
            <span class="muted">
              {#if myPick}Pick locked. The next round starts when everyone has picked or time runs out.
              {:else}Pick one deal. The round ends early once every player has picked.{/if}
            </span>
            <span class="mono muted">{d?.made ?? 0}/{g.count} picked</span>
          </div>
        {:else if !g.settled}
          <div class="status">
            <span class="muted">All rounds are done. Anyone can settle and pay the winner.</span>
            <button class="btn primary" disabled={app.busy || !app.chainOk} onclick={() => actions.settle(g.id)}>Settle game</button>
          </div>
        {:else}
          <div class="status result" class:won={iWon}>
            <span>
              {#if iWon}You won <b>{amount(g.pot, app.studDec, 0)} STUD</b>
              {:else if g.winner === "0x0000000000000000000000000000000000000000"}No winner. Entry fees refunded.
              {:else}Winner <b class="mono">{short(g.winner)}</b> · {amount(g.pot, app.studDec, 0)} STUD{/if}
            </span>
            <button class="btn" onclick={() => actions.close(g.id)}>Close</button>
          </div>
        {/if}
      </div>

      {#if ri.r >= 1}
        <footer class="track">
          {#each ROUND_S as _, r}
            {@const t = tile(r)}
            <div class="tile {t[1]}" class:now={ri.r === r + 1}><span class="kicker">R{r + 1}</span><b>{t[0]}</b></div>
          {/each}
        </footer>
      {/if}
    </section>

    <details class="players" bind:open={showPlayers}>
      <summary>
        <span class="kicker">Players</span>
        <span class="mono muted">{g.count}/{MAX}</span>
        <span class="chev" aria-hidden="true">▾</span>
      </summary>
      <ul>
        {#each d?.players ?? [] as p, i (p)}
          <li>
            <a class="mono" href="{EXPLORER}/address/{p}" target="_blank" rel="noopener noreferrer">{short(p)}</a>
            {#if same(p, g.creator)}<span class="tag">Host</span>{/if}
            {#if same(p, app.account)}<span class="tag me">You</span>{/if}
            {#if open}<span class="state" class:done={d?.picked?.[i]}>{d?.picked?.[i] ? "Picked" : "Waiting"}</span>{/if}
          </li>
        {:else}
          <li class="muted">Loading…</li>
        {/each}
      </ul>
    </details>
  </div>
{/if}

<style>
  .game { background: var(--panel); display: grid; min-width: 0; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px var(--pad); flex-wrap: wrap; }
  .who { display: flex; flex-direction: column; gap: 0; }
  .who .title { font-size: 18px; }
  .stats { display: flex; align-items: center; gap: 24px; }
  .stat { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.25; }
  .stat b { font-size: 15px; }
  .timer { font-size: 30px; font-weight: 700; line-height: 1; min-width: 72px; text-align: right; }
  .timer.low { color: var(--warn); }

  .bar { height: 3px; background: var(--panel-hi); }
  .fill { height: 100%; background: var(--accent); transition: width 1s linear; }

  .body { padding: var(--pad); display: grid; gap: 12px; }

  .waiting { display: grid; justify-items: center; gap: 4px; padding: 20px 0 8px; text-align: center; }
  .count { display: flex; align-items: baseline; gap: 8px; }
  .count b { font-size: 44px; line-height: 1; }
  .count span { font-size: 18px; color: var(--muted); }
  .waiting p { margin: 0; }
  .actions { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; }
  .actions .btn { min-width: 132px; height: 36px; }

  .deals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .deal {
    display: flex; flex-direction: column; gap: 4px; align-items: stretch; text-align: left;
    padding: 12px 14px 14px; border: 0; background: var(--panel-hi); cursor: pointer; min-width: 0;
    box-shadow: inset 0 0 0 1px var(--seam);
  }
  .deal:hover:not(:disabled) { background: var(--accent-soft); }
  .deal:disabled { cursor: default; }
  .deal.mine { background: var(--accent-soft); box-shadow: inset 0 0 0 2px var(--accent); }
  .rate { font-size: 26px; font-weight: 700; line-height: 1.2; margin-bottom: 4px; }
  .line { display: flex; justify-content: space-between; gap: 8px; }

  .status { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .status > span:first-child { min-width: 0; }
  .result.won { box-shadow: inset 3px 0 0 var(--accent); padding-left: 12px; }

  .track { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; background: var(--seam); border-top: 1px solid var(--seam); }
  .tile { background: var(--panel); min-height: 48px; padding: 4px var(--pad); display: flex; flex-direction: column; justify-content: center; }
  .tile.now { box-shadow: inset 0 -2px 0 var(--accent); }
  .tile.won b { color: var(--accent); }
  .tile.lost b { color: var(--muted); }
  .tile.locked b { color: var(--warn); }

  /* Players dropdown, directly under the game */
  .players { background: var(--panel); min-width: 0; }
  .players summary { display: flex; align-items: center; gap: 10px; min-height: var(--row); padding: 0 var(--pad); cursor: pointer; list-style: none; user-select: none; }
  .players summary::-webkit-details-marker { display: none; }
  .players summary:hover { background: var(--panel-hi); }
  .players summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .chev { margin-left: auto; color: var(--muted); transition: transform 0.15s; }
  .players[open] .chev { transform: rotate(180deg); }
  .players ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--seam); }
  .players li { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 var(--pad); }
  .players li + li { border-top: 1px solid var(--seam); }
  .tag { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; padding: 1px 6px; background: var(--panel-hi); color: var(--muted); }
  .tag.me { background: var(--accent-soft); color: var(--accent); }
  .state { margin-left: auto; color: var(--muted); font-size: 12px; }
  .state.done { color: var(--accent); }

  @media (max-width: 560px) {
    .deals { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tile { padding-inline: 10px; }
    .head { align-items: flex-start; }
    .timer { font-size: 26px; }
    .stats { gap: 16px; }
  }
</style>
