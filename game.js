/* Stud Rush game front end. ethers v6 (window.ethers). The page only reads and displays state;
   deal scoring, round winners, timers and the prize are all decided by StudRush.sol. */
(function () {
  "use strict";
  const E = window.ethers;
  const SEPOLIA_HEX = "0xaa36a7";
  const READ_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
  const EXPLORER = "https://sepolia.etherscan.io";
  const POLL_MS = 3000;
  const ROUND_S = [30, 45, 60, 75, 90];
  const REASONS = [
    "No game", "Send exactly 0.001 ETH", "Joining closed", "Already joined", "Game is full", "Join first",
    "Unknown deal", "No round is open", "Already picked this round", "Game still running",
    "Finish the last game first", "Prize pool empty", "Game not over", "Already finished", "STUD transfer failed",
  ];
  const $ = (id) => document.getElementById(id);
  const S = { cfg: null, abi: null, reader: null, writer: null, account: null, chainOk: false, busy: false,
              st: null, skew: 0, tick: null };

  const short = (a) => (a && a !== E.ZeroAddress ? a.slice(0, 6) + "..." + a.slice(-4) : "nobody");
  const pts = (v) => Number(E.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
  const clock = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  const chainNow = () => Math.floor(Date.now() / 1000) + S.skew;
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const hasContract = () => !!(S.cfg && E.isAddress(S.cfg.address || ""));

  function setBanner(msg, err) {
    const b = $("banner");
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg; b.className = "banner" + (err ? " err" : ""); b.hidden = false;
  }
  function setTx(state, msg, hash) {
    $("txCard").hidden = false; $("txCard").className = "card txcard " + state;
    $("txMsg").textContent = msg;
    const l = $("txLink"); l.textContent = "";
    if (hash) { const a = document.createElement("a"); a.href = EXPLORER + "/tx/" + hash; a.target = "_blank"; a.rel = "noopener"; a.textContent = "View transaction on Etherscan"; l.appendChild(a); }
  }
  const rejected = (e) => !!e && (e.code === "ACTION_REJECTED" || e.code === 4001 || (e.info && e.info.error && e.info.error.code === 4001));
  function prettyError(e) {
    if (rejected(e)) return "You rejected the request in MetaMask. Nothing was sent.";
    const text = [e && e.reason, e && e.revert && e.revert.args && e.revert.args[0], e && e.shortMessage,
      e && e.info && e.info.error && e.info.error.message, e && e.message].filter(Boolean).join(" | ");
    const hit = REASONS.find((r) => text.includes(r));
    if (hit) return "The contract rejected it: " + hit + ".";
    if (e && e.code === "INSUFFICIENT_FUNDS") return "Not enough Sepolia ETH for the entry fee plus gas.";
    return (text || String(e)).slice(0, 240);
  }

  // Same integer maths as StudRush.dealValue
  function dealValue(d) {
    const P = 1000n * 10n ** 18n;
    let a = P;
    for (let i = 0; i < Number(d.periods); i++) a = (a * (10000n + BigInt(d.rate))) / 10000n;
    const gross = a - P, fee = (P * BigInt(d.feeBps)) / 10000n;
    return gross > fee ? gross - fee : 0n;
  }

  // ---------- reading ----------
  async function load() {
    S.cfg = await (await fetch("config.json", { cache: "no-store" })).json();
    S.abi = await (await fetch("abi.json", { cache: "no-store" })).json();
    S.reader = new E.Contract(S.cfg.address, S.abi, new E.JsonRpcProvider(READ_RPC, 11155111, { staticNetwork: true }));
    $("links").innerHTML = ` <a target="_blank" rel="noopener" href="${EXPLORER}/address/${S.cfg.address}">Contract</a>` +
      ` <a target="_blank" rel="noopener" href="${EXPLORER}/tx/${S.cfg.deployTx}">Deploy tx</a>` +
      ` <a target="_blank" rel="noopener" href="${EXPLORER}/token/${S.cfg.stud}">STUD token</a>`;
  }

  async function refresh() {
    if (!hasContract()) return;
    try {
      const c = S.reader;
      const blk = await c.runner.provider.getBlock("latest");
      S.skew = blk.timestamp - Math.floor(Date.now() / 1000);
      const id = await c.gameId();
      const st = { id: Number(id), stock: await c.stock(), prize: await c.PRIZE() };
      if (id > 0n) {
        const g = await c.games(id);
        st.game = { start: Number(g.startTime), finished: g.finished, winner: g.winner, winnerWins: Number(g.winnerWins), count: Number(g.playerCount) };
        st.players = await c.getPlayers(id);
        const rw = await c.getRoundWinners(id);
        st.rWin = rw[0]; st.rBest = rw[1];
        st.deals = [];
        // deals are public from the start, but only the open and past rounds are shown
        const cr = Number(await c.currentRound(id));
        st.shown = Math.min(cr, 5);
        for (let r = 0; r < st.shown; r++) st.deals.push(await c.getRoundDeals(id, r));
        st.scores = {};
        for (const p of st.players) st.scores[p] = { tv: await c.totalValue(id, p), picks: await c.getPicks(id, p) };
        if (S.account) st.joined = await c.joined(id, S.account);
        if (st.game.finished) {
          st.wins = {};
          for (const p of st.players) st.wins[p] = Number(await c.wins(id, p));
        }
      }
      S.st = st;
      render();
    } catch (e) { setBanner("Could not read the contract: " + (e.shortMessage || e.message), true); }
  }

  // ---------- rendering ----------
  function roundInfo() { // from local clock (re-synced to chain time on every poll)
    const st = S.st; if (!st || !st.game) return { r: 0, left: 0, total: 0 };
    let t = chainNow() - st.game.start, end = 0;
    if (t < 0) t = 0;
    for (let r = 0; r < 5; r++) { end += ROUND_S[r]; if (t < end) return { r: r + 1, left: end - t, total: ROUND_S[r] }; }
    return { r: 6, left: 0, total: 0 };
  }

  function render() {
    const st = S.st; if (!st) return;
    $("prizeTxt").textContent = pts(st.prize) + " STUD";
    const ri = roundInfo();
    const g = st.game;
    const over = g && ri.r === 6;
    const running = g && !over;
    const connected = S.account && S.chainOk;

    // buttons
    $("startBtn").hidden = !(connected && (st.id === 0 || (g && g.finished)));
    $("joinBtn").hidden = !(connected && running && ri.r <= 1 && !st.joined);
    $("finishBtn").hidden = !(connected && over && !g.finished);
    for (const b of ["startBtn", "joinBtn", "finishBtn"]) $(b).disabled = S.busy;

    // title, timer, message
    let title = "Game", msg = "";
    if (st.id === 0) { title = "No game yet"; msg = connected ? "Start the first game." : "Connect your wallet to play."; }
    else if (running) {
      title = `Game #${st.id}: round ${ri.r} of 5`;
      msg = !connected ? "Connect your wallet to play."
        : !st.joined ? (ri.r <= 1 ? "Join now (entry 0.001 ETH) and pick a deal before the timer runs out." : "Joining is closed for this game. Watch, then start the next game.")
        : mine(ri.r) ? "Pick locked in. Wait for the next round." : "Work out the compound interest and pick the best deal.";
    } else if (over && !g.finished) { title = `Game #${st.id}: over`; msg = "All rounds are done. Anyone can finish the game to pay the winner."; }
    else if (g && g.finished) {
      title = `Game #${st.id}: finished`;
      msg = g.winner === E.ZeroAddress ? "Nobody picked, so no prize was paid."
        : `Winner: ${short(g.winner)}${same(g.winner, S.account) ? " (you!)" : ""} with ${g.winnerWins} round win(s). Prize: ${pts(st.prize)} STUD.`;
    }
    $("stageTitle").textContent = title;
    $("stageMsg").textContent = msg;
    $("timer").textContent = running ? clock(ri.left) : "--:--";
    $("timer").classList.toggle("low", running && ri.left <= 10);
    $("bar").style.width = running ? Math.round((ri.left / ri.total) * 100) + "%" : "0";

    renderDeals(ri, running, connected);
    renderRounds(ri);
    renderPlayers();
  }

  function mine(round) {
    const st = S.st; if (!S.account || !st || !st.scores) return 0;
    const key = Object.keys(st.scores).find((p) => same(p, S.account));
    return key ? Number(st.scores[key].picks[round - 1]) : 0;
  }

  function renderDeals(ri, running, connected) {
    const box = $("deals");
    if (!running || !S.st.deals[ri.r - 1]) { box.hidden = true; return; }
    box.hidden = false; box.textContent = "";
    const deals = S.st.deals[ri.r - 1];
    const picked = mine(ri.r);
    const canPick = connected && S.st.joined && !picked && !S.busy;
    deals.forEach((d, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "deal" + (picked === i + 1 ? " mine" : ""); b.disabled = !canPick;
      b.innerHTML = `<span class="rate">${pct(d.rate)}</span>
        <span class="row"><span>per period</span></span>
        <span class="row"><span>Periods</span><b>${d.periods}</b></span>
        <span class="row"><span>Fee</span><b>${(Number(d.feeBps) / 10).toFixed(1)} pts</b></span>
        <span class="row"><span>${picked === i + 1 ? "Your pick" : "Pick"}</span><span>#${i + 1}</span></span>`;
      b.addEventListener("click", () => pick(i));
      box.appendChild(b);
    });
  }

  function renderRounds(ri) {
    const st = S.st, box = $("rounds"); box.textContent = "";
    if (!st.game) { box.textContent = "No rounds yet."; return; }
    for (let r = 0; r < 5; r++) {
      const row = document.createElement("div");
      row.className = "rrow" + (ri.r === r + 1 ? " now" : "");
      const done = ri.r > r + 1;
      const w = st.rWin[r], hasW = w && w !== E.ZeroAddress;
      let best = "";
      if (done && st.deals[r]) {
        const vals = st.deals[r].map(dealValue);
        let bi = 0; vals.forEach((v, i) => { if (v > vals[bi]) bi = i; });
        best = `Best deal: #${bi + 1} (${pts(vals[bi])} pts)`;
      }
      const you = mine(r + 1);
      row.innerHTML = `<b>Round ${r + 1}</b><span>${ROUND_S[r]} s</span>` +
        `<span>${done ? (hasW ? "Won by " + short(w) + (same(w, S.account) ? " (you)" : "") : "No picks") : ri.r === r + 1 ? "Open" : "Waiting"}</span>` +
        `<span>${done ? best : (you ? "You picked #" + you : "")}</span>`;
      box.appendChild(row);
    }
  }

  function renderPlayers() {
    const st = S.st, box = $("players");
    if (!st.players || !st.players.length) { box.textContent = "No players yet."; return; }
    const rows = st.players.map((p) => {
      const s = st.scores[p];
      const wins = st.rWin ? st.rWin.filter((w) => same(w, p)).length : 0;
      return `<div class="rrow"><b>${short(p)}${same(p, S.account) ? " (you)" : ""}</b><span>${wins} round win(s)</span><span>${pts(s.tv)} pts total</span><span>${s.picks.filter((x) => Number(x) > 0).length}/5 picks</span></div>`;
    });
    box.innerHTML = `<div class="rounds">${rows.join("")}</div>`;
  }

  // ---------- wallet ----------
  async function connect() {
    if (!window.ethereum) { setBanner("MetaMask not found. Install it and reload.", true); return; }
    try {
      const provider = new E.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      await setAccount(provider);
    } catch (e) { setBanner(prettyError(e), true); }
  }
  async function setAccount(provider) {
    const signer = await provider.getSigner();
    S.account = await signer.getAddress();
    const net = await provider.getNetwork();
    S.chainOk = net.chainId === 11155111n;
    S.writer = S.chainOk ? new E.Contract(S.cfg.address, S.abi, signer) : null;
    $("acct").hidden = false; $("acct").textContent = short(S.account);
    $("netBadge").textContent = S.chainOk ? "Sepolia" : "Wrong network";
    $("netBadge").className = "badge " + (S.chainOk ? "ok" : "off");
    $("connectBtn").textContent = S.chainOk ? "Connected" : "Switch to Sepolia";
    $("connectBtn").disabled = S.chainOk;
    if (!S.chainOk) {
      try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] }); return setAccount(new E.BrowserProvider(window.ethereum)); }
      catch (_) { setBanner("Please switch MetaMask to the Sepolia test network.", true); }
    } else setBanner("");
    refresh();
  }

  async function send(label, fn) {
    if (S.busy) return;
    if (!S.writer) { setBanner("Connect MetaMask on Sepolia first.", true); return; }
    S.busy = true; render();
    try {
      setTx("wait", "Confirm " + label + " in MetaMask...");
      const tx = await fn(S.writer);
      setTx("wait", "Waiting for confirmation...", tx.hash);
      await tx.wait();
      setTx("ok", label + " confirmed.", tx.hash);
    } catch (e) { setTx("bad", prettyError(e)); }
    S.busy = false; refresh();
  }
  const pick = (i) => send("your pick #" + (i + 1), (c) => c.pick(i));

  // ---------- practice calculator ----------
  function calc() {
    const r = parseFloat($("cRate").value) || 0, n = parseInt($("cN").value, 10) || 0, f = parseFloat($("cFee").value) || 0;
    const comp = 1000 * Math.pow(1 + r / 100, n) - 1000 - f, simple = 1000 * (r / 100) * n - f;
    $("cOut").textContent = `compound: ${Math.max(comp, 0).toFixed(2)} pts   |   simple interest (wrong): ${Math.max(simple, 0).toFixed(2)} pts`;
  }

  // ---------- init ----------
  function theme() {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("studrush:theme", t); } catch (_) {}
  }

  async function init() {
    $("themeBtn").addEventListener("click", theme);
    $("connectBtn").addEventListener("click", connect);
    $("startBtn").addEventListener("click", () => send("start game", (c) => c.startGame()));
    $("joinBtn").addEventListener("click", () => send("join (0.001 ETH)", (c) => c.join({ value: E.parseEther("0.001") })));
    $("finishBtn").addEventListener("click", () => send("finish game", (c) => c.finish()));
    for (const id of ["cRate", "cN", "cFee"]) $(id).addEventListener("input", calc);
    calc();
    if (!E) { setBanner("ethers.js failed to load. Check your connection.", true); return; }
    try { await load(); } catch (e) { setBanner("Could not load config.json / abi.json.", true); return; }
    if (window.ethereum) {
      window.ethereum.on && window.ethereum.on("accountsChanged", () => location.reload());
      window.ethereum.on && window.ethereum.on("chainChanged", () => location.reload());
      try { const p = new E.BrowserProvider(window.ethereum); if ((await p.send("eth_accounts", [])).length) await setAccount(p); } catch (_) {}
    }
    await refresh();
    setInterval(refresh, POLL_MS);
    setInterval(() => { if (S.st) render(); }, 1000);
  }
  init();
})();
