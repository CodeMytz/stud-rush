/* Stud Rush front end (compound-interest edition). Plain script, ethers v6 (loaded as window.ethers).
   The page only reads and displays state. Every rule is enforced by StudRush.sol. */
(function () {
  "use strict";

  const E = window.ethers;
  const SEPOLIA = 11155111n;
  const SEPOLIA_HEX = "0xaa36a7";
  const READ_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
  const EXPLORER = "https://sepolia.etherscan.io";
  const POLL_MS = 5000;
  const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
  const REASONS = [
    "Offer is cooling down", "Send exactly 0.001 ETH", "Wallet limit reached",
    "Shop is out of STUD", "Unknown offer", "STUD transfer failed",
  ];
  const TIERS = [
    { name: "Rush", blurb: "Biggest rates, shortest lock (30 s)" },
    { name: "Steady", blurb: "Middle rates, middle lock (60 s)" },
    { name: "Bargain bin", blurb: "Small rates, longest lock (120 s)" },
  ];
  // Option ids: 0-3 Rush, 4-7 Steady, 8-11 Bargain bin (same order as the contract).
  const OPTIONS = [
    "Quick Flip", "Double Up", "Sprint", "Burst",
    "Short Hop", "Even Keel", "Long Haul", "Marathon",
    "Penny Stack", "Nickel Drip", "Loose Change", "Dust Pile",
  ];
  const COUNT = OPTIONS.length, TIER_SIZE = 4;
  const tierOf = (i) => Math.floor(i / TIER_SIZE);
  const LEVELS = [[10, "Maxed out"], [6, "Whale"], [3, "Trader"], [1, "Regular"], [0, "New buyer"]];

  const $ = (id) => document.getElementById(id);
  const S = {
    cfg: null, abi: null, readProvider: null, reader: null, studR: null, gameR: null,
    account: null, chainOk: false, writer: null,
    offers: null, stock: 0n, player: null,
    bal: { eth: null, stud: null, game: null },
    c: { PACK: 100n * 10n ** 18n, PRICE: 10n ** 15n, MAX: 10, PERK: 100n }, // replaced by contract reads
    busy: false, demo: false, reveal: false, tick: 0,
    score: { smart: 0, total: 0 },
  };

  // ---------- helpers ----------
  const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
  const fmt = (v, d = 2) => (v === null || v === undefined ? "-" : Number(E.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: d }));
  const short = (a) => (a && a !== E.ZeroAddress ? a.slice(0, 6) + "..." + a.slice(-4) : "nobody yet");
  const nowS = () => Math.floor(Date.now() / 1000);
  const clock = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  const txUrl = (h) => EXPLORER + "/tx/" + h;
  // Same integer maths as StudRush.bonusFor: compound the pack, take off the flat fee, add the GAME perk.
  function bonusOf(rateBps, rounds, feeBps, perk) {
    const PACK = S.c.PACK;
    let a = PACK;
    for (let i = 0; i < rounds; i++) a = (a * (10000n + BigInt(rateBps))) / 10000n;
    const gross = a - PACK;
    const fee = (PACK * BigInt(feeBps)) / 10000n;
    const net = gross > fee ? gross - fee : 0n;
    return perk ? net + (PACK * S.c.PERK) / 10000n : net;
  }
  const studFee = (bps) => (Number(bps) / 100).toFixed(2) + " STUD";
  function bonusNow(o) { return bonusOf(o.rate, o.rounds, o.fee, !!(S.player && S.player.gamePerk)); }
  function bestInTier(t, onlyOpen) {
    let best = -1, bestV = -1n;
    for (let i = t * TIER_SIZE; i < (t + 1) * TIER_SIZE; i++) {
      const o = S.offers && S.offers[i];
      if (!o || (onlyOpen && o.readyAt > nowS())) continue;
      const v = bonusNow(o);
      if (v > bestV) { bestV = v; best = i; }
    }
    return best;
  }
  const hasContract = () => !!(S.cfg && E.isAddress(S.cfg.address || ""));
  const hasGame = () => !!(S.cfg && E.isAddress(S.cfg.gameToken || "") && S.cfg.gameToken !== E.ZeroAddress);

  function setBanner(msg, isErr) {
    const b = $("banner");
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg;
    b.className = "banner" + (isErr ? " err" : "");
    b.hidden = false;
  }

  function setTx(state, msg, hash) {
    $("txCard").hidden = false;
    $("txCard").className = "card txcard " + state;
    $("txMsg").textContent = msg;
    const l = $("txLink");
    l.textContent = "";
    if (hash) {
      const a = document.createElement("a");
      a.href = txUrl(hash); a.target = "_blank"; a.rel = "noopener";
      a.textContent = "View transaction on Etherscan";
      l.appendChild(a);
    }
  }

  function rejected(e) {
    return !!e && (e.code === "ACTION_REJECTED" || e.code === 4001 || (e.info && e.info.error && e.info.error.code === 4001));
  }

  function prettyError(e) {
    if (rejected(e)) return "You rejected the request in MetaMask. Nothing was sent.";
    const text = [e && e.reason, e && e.revert && e.revert.args && e.revert.args[0], e && e.shortMessage,
      e && e.info && e.info.error && e.info.error.message, e && e.error && e.error.message, e && e.message]
      .filter(Boolean).join(" | ");
    const hit = REASONS.find((r) => text.includes(r));
    if (hit) return "The contract rejected the purchase: " + hit + ".";
    if (e && e.code === "INSUFFICIENT_FUNDS") return "Not enough Sepolia ETH for the price plus gas.";
    return (text || String(e)).slice(0, 240);
  }

  function loadScore() {
    try {
      const v = JSON.parse(localStorage.getItem("studrush:score") || "null");
      if (v && Number.isInteger(v.smart) && Number.isInteger(v.total)) S.score = v;
    } catch (_) {}
  }
  function saveScore() {
    try { localStorage.setItem("studrush:score", JSON.stringify(S.score)); } catch (_) {}
    renderScore();
  }
  function renderScore() {
    $("stScore").textContent = S.score.total ? S.score.smart + " / " + S.score.total : "-";
  }

  // ---------- theme ----------
  function initTheme() {
    $("themeBtn").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("studrush:theme", next); } catch (_) {}
    });
  }

  // ---------- offers (built once, updated in place) ----------
  function buildOffers() {
    const root = $("tiers");
    root.textContent = "";
    TIERS.forEach((t, ti) => {
      const sec = document.createElement("section");
      sec.className = "tier";
      sec.innerHTML =
        '<div class="tierhead"><h2>' + t.name + "</h2>" +
        '<span class="muted small">' + t.blurb + '</span></div><div class="grid four" id="tier' + ti + '"></div>';
      root.appendChild(sec);
      const grid = sec.querySelector(".grid");
      for (let k = 0; k < TIER_SIZE; k++) {
        const i = ti * TIER_SIZE + k;
        const card = document.createElement("section");
        card.className = "card offer";
        card.id = "o" + i;
        card.innerHTML =
          '<div class="head"><h3>' + OPTIONS[i] + '</h3><span class="badge" id="o' + i + 'State">-</span></div>' +
          '<div class="rate"><span id="o' + i + 'Rate">-</span><small>per round</small></div>' +
          '<div class="plan"><span><b id="o' + i + 'Rounds">-</b> rounds</span><span>fee <b id="o' + i + 'Fee">-</b></span></div>' +
          '<div class="get" id="o' + i + 'Get">-</div>' +
          '<div class="track"><div class="fill" id="o' + i + 'Fill"></div></div>' +
          '<ul class="facts">' +
          '<li><span class="muted">Rate after a purchase</span><span id="o' + i + 'Next">-</span></li>' +
          '<li><span class="muted">Lowest rate</span><span id="o' + i + 'Min">-</span></li>' +
          '<li><span class="muted">Sold</span><span id="o' + i + 'Sold">-</span></li>' +
          '<li><span class="muted">Last buyer</span><span class="mono" id="o' + i + 'Last">-</span></li>' +
          "</ul>" +
          '<button class="btn primary" type="button" id="o' + i + 'Btn">-</button>';
        grid.appendChild(card);
        $("o" + i + "Btn").addEventListener("click", () => buy(i));
      }
    });
  }

  function perkOn() { return !!(S.player && S.player.gamePerk); }

  function buttonState(i) {
    const o = S.offers && S.offers[i];
    if (!hasContract() || !o) return { text: "Not available", disabled: true };
    const get = S.c.PACK + bonusNow(o);
    if (!S.account) return { text: "Connect MetaMask to buy", disabled: false, action: "connect" };
    if (!S.chainOk) return { text: "Switch to Sepolia", disabled: false, action: "switch" };
    if (S.busy) return { text: "Waiting for MetaMask...", disabled: true };
    const left = o.readyAt - nowS();
    const blockers = [];
    if (S.player && S.player.purchases >= S.c.MAX) blockers.push("Wallet limit reached");
    if (left > 0) blockers.push("Locked " + clock(left));
    if (S.stock < get) blockers.push("Sold out");
    if (blockers.length) {
      return S.demo
        ? { text: "Send anyway (demo): " + blockers[0], disabled: false }
        : { text: blockers[0], disabled: true };
    }
    if (S.bal.eth !== null && S.bal.eth < S.c.PRICE) return { text: "Not enough Sepolia ETH", disabled: true };
    return { text: "Buy this option for " + E.formatEther(S.c.PRICE) + " ETH", disabled: false };
  }

  function renderOffers() {
    const best = TIERS.map((_, t) => (S.reveal ? bestInTier(t, false) : -1));
    for (let i = 0; i < COUNT; i++) {
      const o = S.offers && S.offers[i];
      const st = buttonState(i);
      const btn = $("o" + i + "Btn");
      btn.textContent = st.text;
      btn.disabled = st.disabled;
      if (!o) continue;
      const left = Math.max(0, o.readyAt - nowS());
      const next = o.rate > o.min + o.decay ? o.rate - o.decay : o.min;
      $("o" + i + "Rate").textContent = pct(o.rate);
      $("o" + i + "Rounds").textContent = String(o.rounds);
      $("o" + i + "Fee").textContent = studFee(o.fee);
      const g = $("o" + i + "Get");
      if (S.reveal) {
        const b = bonusNow(o);
        g.textContent = "Bonus " + fmt(b, 4) + " STUD" + (perkOn() ? " (incl. GAME perk)" : "");
        g.className = "get shown";
      } else {
        g.textContent = "Bonus: calculate it yourself";
        g.className = "get hidden";
      }
      $("o" + i).classList.toggle("best", best[tierOf(i)] === i);
      $("o" + i + "Next").textContent = pct(next);
      $("o" + i + "Min").textContent = pct(o.min);
      $("o" + i + "Sold").textContent = String(o.sold);
      $("o" + i + "Last").textContent = short(o.lastBuyer);
      const badge = $("o" + i + "State");
      badge.textContent = left > 0 ? "Locked " + clock(left) : (best[tierOf(i)] === i ? "Best value" : "Open");
      badge.className = "badge " + (left > 0 ? "warn" : "ok");
      $("o" + i + "Fill").style.width = left > 0 ? Math.min(100, (left / o.cooldown) * 100) + "%" : "0%";
    }
  }

  // ---------- calculator (a scratchpad: it never reads the offers) ----------
  function renderCalc() {
    if (!E) return;
    const rate = parseFloat($("cRate").value);
    const rounds = parseInt($("cRounds").value, 10);
    const fee = parseFloat($("cFee").value || "0");
    const out = $("cOut");
    if (!(rate >= 0) || !(rounds >= 1) || rounds > 30 || !(fee >= 0)) {
      out.textContent = "Enter a rate, rounds (1 to 30) and a fee.";
      return;
    }
    const bps = Math.round(rate * 100), feeBps = Math.round(fee * 100);
    const base = 100n * 10n ** 18n;
    let a = base;
    const rows = [];
    for (let r = 1; r <= rounds; r++) {
      a = (a * (10000n + BigInt(bps))) / 10000n;
      if (rounds <= 8 || r <= 3 || r === rounds) rows.push("Round " + r + ": " + Number(E.formatUnits(a, 18)).toFixed(4));
      else if (r === 4) rows.push("...");
    }
    const bonus = bonusOf(bps, rounds, feeBps, false);
    const simple = (rate * rounds).toFixed(2);
    out.innerHTML = "";
    const pre = document.createElement("div");
    pre.className = "mono small";
    pre.textContent = rows.join("\n");
    pre.style.whiteSpace = "pre";
    const res = document.createElement("div");
    res.innerHTML = "<b></b>";
    res.firstChild.textContent = "Bonus " + Number(E.formatUnits(bonus, 18)).toFixed(4) + " STUD";
    const note = document.createElement("div");
    note.className = "muted small";
    note.textContent = "100 x (1 + " + rate + "/100)^" + rounds + " - 100 - " + fee + " fee. Simple interest would say " + simple + "% (before the fee): that is the trap.";
    out.append(pre, res, note);
  }

  function renderWallet() {
    $("balEth").textContent = S.bal.eth === null ? "-" : Number(E.formatEther(S.bal.eth)).toLocaleString(undefined, { maximumFractionDigits: 4 });
    $("balStud").textContent = fmt(S.bal.stud);
    $("balGame").textContent = hasGame() ? fmt(S.bal.game) : "off";
    $("stock").textContent = hasContract() ? fmt(S.stock, 0) : "-";
    $("addTokenBtn").hidden = !S.account;
    const p = $("perkLine");
    if (!hasGame()) p.textContent = "The GAME perk is not enabled in this deployment.";
    else if (!S.account) p.textContent = "Connect a wallet to see whether you get the GAME perk (+1 STUD flat bonus when you hold at least 1 GAME).";
    else p.textContent = S.player && S.player.gamePerk ? "GAME perk active: +1 STUD on every purchase." : "Hold at least 1 GAME to add 1 STUD to every purchase.";
  }

  function renderPlayer() {
    const p = S.player;
    const buys = p ? p.purchases : null;
    const level = buys === null ? "-" : LEVELS.find((l) => buys >= l[0])[1];
    $("stLevel").textContent = level;
    $("stBuys").textContent = buys === null ? "-" : buys + " / " + S.c.MAX;
    $("stStud").textContent = p ? fmt(p.studBought) : "-";
    $("stBonus").textContent = p ? fmt(p.bonusEarned) : "-";
  }

  function renderHeader() {
    const badge = $("netBadge");
    if (!S.account) { badge.textContent = "Not connected"; badge.className = "badge off"; }
    else if (!S.chainOk) { badge.textContent = "Wrong network"; badge.className = "badge off"; }
    else { badge.textContent = "Sepolia"; badge.className = "badge ok"; }
    const a = $("acct");
    a.hidden = !S.account;
    a.textContent = S.account ? short(S.account) : "";
    if (S.account) a.title = S.account;
    const c = $("connectBtn");
    c.textContent = S.account ? "Connected" : "Connect MetaMask";
    c.disabled = !!S.account;
  }

  function render() { renderHeader(); renderWallet(); renderPlayer(); renderOffers(); renderScore(); }

  // ---------- reads ----------
  async function loadChainState() {
    if (!hasContract()) return;
    try {
      const [offers, stock] = await Promise.all([S.reader.getOffers(), S.reader.stock()]);
      S.offers = Array.from(offers, (o) => ({
        rate: Number(o.rate), start: Number(o.startRate), decay: Number(o.decay), min: Number(o.minRate),
        rounds: Number(o.rounds), fee: Number(o.feeBps),
        cooldown: Number(o.cooldown), readyAt: Number(o.readyAt), sold: Number(o.sold), lastBuyer: o.lastBuyer,
      }));
      S.stock = stock;
      if (S.account) await loadWalletState();
      if (S.tick++ % 3 === 0) loadActivity();
      if ($("banner").dataset.kind === "read") { setBanner(null); $("banner").dataset.kind = ""; }
    } catch (e) {
      setBanner("Could not read the contract from the Sepolia RPC. Retrying automatically.", true);
      $("banner").dataset.kind = "read";
    }
    render();
  }

  async function loadWalletState() {
    if (!S.account) return;
    const jobs = [
      S.readProvider.getBalance(S.account),
      S.studR.balanceOf(S.account),
      hasGame() ? S.gameR.balanceOf(S.account) : Promise.resolve(0n),
      S.reader.getPlayer(S.account),
    ];
    const [eth, stud, game, p] = await Promise.all(jobs);
    S.bal = { eth, stud, game };
    S.player = { purchases: Number(p.purchases), studBought: p.studBought, bonusEarned: p.bonusEarned, gamePerk: p.gamePerk };
  }

  async function loadActivity() {
    const list = $("activity");
    if (!hasContract()) return;
    try {
      const latest = await S.readProvider.getBlockNumber();
      const from = Math.max(Number(S.cfg.deployBlock) || 0, latest - 5000);
      const logs = await S.reader.queryFilter(S.reader.filters.Purchased(), from, latest);
      list.textContent = "";
      if (!logs.length) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "No purchases yet. Be the first.";
        list.appendChild(li);
        return;
      }
      logs.slice(-8).reverse().forEach((l) => {
        const li = document.createElement("li");
        const meta = document.createElement("span");
        meta.className = "meta";
        const who = document.createElement("span");
        who.className = "mono";
        who.textContent = short(l.args.buyer);
        const what = document.createElement("span");
        what.className = "muted small";
        what.textContent = OPTIONS[Number(l.args.offerId)] + " at " + pct(l.args.rateBps) + " per round";
        meta.append(who, what);
        const right = document.createElement("span");
        const a = document.createElement("a");
        a.href = txUrl(l.transactionHash); a.target = "_blank"; a.rel = "noopener";
        a.textContent = fmt(l.args.studReceived) + " STUD";
        right.appendChild(a);
        li.append(meta, right);
        list.appendChild(li);
      });
    } catch (_) {
      list.textContent = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "History is unavailable (the public RPC limited the log request). Offers and results are still read from the contract.";
      list.appendChild(li);
    }
  }

  // ---------- wallet ----------
  async function ensureSepolia() {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
      return true;
    } catch (err) {
      if (err && err.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: SEPOLIA_HEX, chainName: "Sepolia", rpcUrls: [READ_RPC],
              nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
              blockExplorerUrls: [EXPLORER],
            }],
          });
          return true;
        } catch (e2) { setBanner(prettyError(e2), true); return false; }
      }
      if (err && err.code === -32002) setBanner("A MetaMask request is already open. Open the MetaMask extension and approve the network switch to Sepolia.", false);
      else if (rejected(err)) setBanner("Network switch rejected. Switch MetaMask to Ethereum Sepolia to buy.", false);
      else setBanner(prettyError(err), true);
      return false;
    }
  }

  async function syncWallet() {
    if (!window.ethereum) return;
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    S.account = accs && accs[0] ? E.getAddress(accs[0]) : null;
    const id = BigInt(await window.ethereum.request({ method: "eth_chainId" }));
    S.chainOk = id === SEPOLIA;
    S.writer = null;
    S.player = null;
    S.bal = { eth: null, stud: null, game: null };
    if (S.account && S.chainOk && hasContract()) {
      const signer = await new E.BrowserProvider(window.ethereum).getSigner();
      S.writer = new E.Contract(S.cfg.address, S.abi, signer);
      if ($("banner").dataset.kind !== "read") setBanner(null);
    }
    if (S.account && !S.chainOk) setBanner("MetaMask is on the wrong network. Switch to Ethereum Sepolia (chain ID 11155111) before buying.", false);
    render();
    if (S.account) { try { await loadWalletState(); } catch (_) {} render(); }
  }

  async function connect() {
    if (!window.ethereum) {
      setBanner("MetaMask was not found. Install the MetaMask browser extension, or open this page in the MetaMask app browser.", true);
      return;
    }
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await syncWallet();
      if (S.account && !S.chainOk) { if (await ensureSepolia()) await syncWallet(); }
    } catch (e) {
      setBanner(rejected(e) ? "Connection rejected. No wallet is connected." : prettyError(e), rejected(e) ? false : true);
    }
  }

  async function switchNet() {
    if (await ensureSepolia()) await syncWallet();
  }

  async function addToken() {
    try {
      await window.ethereum.request({
        method: "wallet_watchAsset",
        params: { type: "ERC20", options: { address: S.cfg.stud, symbol: "STUD", decimals: 18 } },
      });
    } catch (e) { setBanner(prettyError(e), true); }
  }

  // ---------- buying ----------
  async function buy(i) {
    const st = buttonState(i);
    if (st.action === "connect") return connect();
    if (st.action === "switch") return switchNet();
    if (st.disabled || !S.writer) return;
    // Remember what the player could see, so we can say afterwards whether the pick was the best open one.
    const t = tierOf(i);
    const bestId = bestInTier(t, true);
    const bestBonus = bestId >= 0 ? bonusNow(S.offers[bestId]) : 0n;
    const myBonus = bonusNow(S.offers[i]);
    S.busy = true;
    render();
    try {
      setTx("wait", "Confirm the purchase in MetaMask.");
      const opts = { value: S.c.PRICE };
      if (S.demo) opts.gasLimit = 250000n; // skip the pre-check so a rejected rule shows up on Etherscan
      const tx = await S.writer.buy(i, opts);
      setTx("wait", "Transaction sent. Waiting for confirmation (about 12 seconds).", tx.hash);
      const rc = await tx.wait();
      if (rc && rc.status === 1) {
        let msg = "Purchase confirmed.";
        let smart = null;
        try {
          for (const log of rc.logs) {
            const p = S.writer.interface.parseLog(log);
            if (p && p.name === "Purchased") {
              msg = "Purchase confirmed: " + OPTIONS[i] + " at " + pct(p.args.rateBps) + " per round gave you " + fmt(p.args.studReceived, 4) +
                " STUD (bonus " + fmt(p.args.bonusStud, 4) + ").";
            }
          }
          if (bestId >= 0) {
            smart = myBonus >= bestBonus;
            S.score.total += 1;
            if (smart) S.score.smart += 1;
            saveScore();
            msg += smart
              ? " Smart pick: it was the best open " + TIERS[t].name + " option."
              : " The best open " + TIERS[t].name + " option was " + OPTIONS[bestId] + " (" + fmt(bestBonus, 4) + " STUD bonus). You missed " + fmt(bestBonus - myBonus, 4) + " STUD. Check the maths next time.";
          }
        } catch (_) {}
        setTx("ok", msg, tx.hash);
      } else {
        setTx("bad", "The transaction failed on chain. No STUD was sent.", tx.hash);
      }
    } catch (e) {
      const hash = (e && e.receipt && e.receipt.hash) || (e && e.transaction && e.transaction.hash) || null;
      setTx(rejected(e) ? "wait" : "bad", prettyError(e), hash);
    } finally {
      S.busy = false;
      await loadChainState();
      loadActivity();
    }
  }

  // ---------- start ----------
  function renderLinks() {
    const l = $("links");
    l.textContent = "";
    const add = (href, text) => {
      const a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text;
      l.append(" ", a);
    };
    if (hasContract()) add(EXPLORER + "/address/" + S.cfg.address, "Shop contract");
    if (S.cfg && E.isAddress(S.cfg.stud || "")) add(EXPLORER + "/token/" + S.cfg.stud, "STUD token");
    add("contracts/StudRush.sol", "Source code");
  }

  async function init() {
    initTheme();
    buildOffers();
    $("connectBtn").addEventListener("click", connect);
    $("addTokenBtn").addEventListener("click", addToken);
    $("demoToggle").addEventListener("change", (e) => { S.demo = e.target.checked; render(); });
    $("revealToggle").addEventListener("change", (e) => { S.reveal = e.target.checked; render(); });
    ["cRate", "cRounds", "cFee"].forEach((id) => $(id).addEventListener("input", renderCalc));
    loadScore();
    renderCalc();
    setInterval(renderOffers, 1000);
    render();

    if (!E) { setBanner("ethers.js could not be loaded from the CDN. Check your connection and reload.", true); return; }
    try {
      const [cfg, abi] = await Promise.all([
        fetch("config.json", { cache: "no-store" }).then((r) => r.json()),
        fetch("abi.json", { cache: "no-store" }).then((r) => r.json()),
      ]);
      S.cfg = cfg; S.abi = abi;
    } catch (_) {
      setBanner("Could not load config.json or abi.json. Open this page over HTTPS or a local web server, not as a file.", true);
      return;
    }
    renderLinks();
    S.readProvider = new E.JsonRpcProvider(READ_RPC, 11155111, { staticNetwork: E.Network.from(11155111) });
    if (E.isAddress(S.cfg.stud || "")) S.studR = new E.Contract(S.cfg.stud, ERC20_ABI, S.readProvider);
    if (hasGame()) S.gameR = new E.Contract(S.cfg.gameToken, ERC20_ABI, S.readProvider);

    if (!hasContract()) {
      setBanner("The shop contract is not deployed yet: config.json has no address. Run npm run deploy:sepolia and commit the updated config.json.", false);
      render();
    } else {
      S.reader = new E.Contract(S.cfg.address, S.abi, S.readProvider);
      try {
        const [pack, price, max, perk] = await Promise.all([S.reader.PACK(), S.reader.PRICE(), S.reader.MAX_BUYS(), S.reader.GAME_PERK()]);
        S.c = { PACK: pack, PRICE: price, MAX: Number(max), PERK: perk };
      } catch (_) {}
      await loadChainState();
      setInterval(loadChainState, POLL_MS);
    }

    if (window.ethereum) {
      window.ethereum.on && window.ethereum.on("accountsChanged", () => syncWallet().then(loadChainState));
      window.ethereum.on && window.ethereum.on("chainChanged", () => syncWallet().then(loadChainState));
      try { await syncWallet(); } catch (_) {}
    }
  }

  window.addEventListener("DOMContentLoaded", init);
})();
