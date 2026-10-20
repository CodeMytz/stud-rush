/* Stud Rush front end. Plain script, ethers v6 (loaded as window.ethers).
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
  const NAMES = [
    { name: "Rush", blurb: "Biggest bonus, shortest lock" },
    { name: "Steady", blurb: "Middle bonus, middle lock" },
    { name: "Bargain bin", blurb: "Smallest bonus, longest lock" },
  ];
  const LEVELS = [[10, "Maxed out"], [6, "Whale"], [3, "Trader"], [1, "Regular"], [0, "New buyer"]];

  const $ = (id) => document.getElementById(id);
  const S = {
    cfg: null, abi: null, readProvider: null, reader: null, studR: null, gameR: null,
    account: null, chainOk: false, writer: null,
    offers: null, stock: 0n, player: null,
    bal: { eth: null, stud: null, game: null },
    c: { PACK: 100n * 10n ** 18n, PRICE: 10n ** 15n, MAX: 10 }, // replaced by contract reads
    busy: false, demo: false, tick: 0,
  };

  // ---------- helpers ----------
  const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
  const fmt = (v, d = 2) => (v === null || v === undefined ? "-" : Number(E.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: d }));
  const short = (a) => (a && a !== E.ZeroAddress ? a.slice(0, 6) + "..." + a.slice(-4) : "nobody yet");
  const nowS = () => Math.floor(Date.now() / 1000);
  const clock = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  const txUrl = (h) => EXPLORER + "/tx/" + h;
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
    const root = $("offers");
    root.textContent = "";
    NAMES.forEach((n, i) => {
      const card = document.createElement("section");
      card.className = "card offer";
      card.innerHTML =
        '<div class="head"><h2>' + n.name + '</h2><span class="badge" id="o' + i + 'State">-</span></div>' +
        '<p class="muted small" style="margin:0">' + n.blurb + "</p>" +
        '<div class="bonus"><span id="o' + i + 'Bonus">-</span><small>bonus</small></div>' +
        '<div class="get" id="o' + i + 'Get">-</div>' +
        '<div class="track"><div class="fill" id="o' + i + 'Fill"></div></div>' +
        '<ul class="facts">' +
        '<li><span class="muted">After a purchase</span><span id="o' + i + 'Next">-</span></li>' +
        '<li><span class="muted">Lowest bonus</span><span id="o' + i + 'Min">-</span></li>' +
        '<li><span class="muted">Locks for everyone</span><span id="o' + i + 'Lock">-</span></li>' +
        '<li><span class="muted">Sold</span><span id="o' + i + 'Sold">-</span></li>' +
        '<li><span class="muted">Last buyer</span><span class="mono" id="o' + i + 'Last">-</span></li>' +
        "</ul>" +
        '<button class="btn primary" type="button" id="o' + i + 'Btn">-</button>';
      root.appendChild(card);
      $("o" + i + "Btn").addEventListener("click", () => buy(i));
    });
  }

  function perkBps() { return S.player && S.player.gamePerk ? 100 : 0; }

  function buttonState(i) {
    const o = S.offers && S.offers[i];
    const bonus = o ? o.bonus + perkBps() : 0;
    const get = S.c.PACK + (S.c.PACK * BigInt(bonus)) / 10000n;
    if (!hasContract() || !o) return { text: "Not available", disabled: true };
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
    return { text: "Buy " + fmt(get) + " STUD for " + E.formatEther(S.c.PRICE) + " ETH", disabled: false };
  }

  function renderOffers() {
    NAMES.forEach((_, i) => {
      const o = S.offers && S.offers[i];
      const st = buttonState(i);
      const btn = $("o" + i + "Btn");
      btn.textContent = st.text;
      btn.disabled = st.disabled;
      if (!o) return;
      const left = Math.max(0, o.readyAt - nowS());
      const perk = perkBps();
      const next = o.bonus > o.min + o.decay ? o.bonus - o.decay : o.min;
      const get = S.c.PACK + (S.c.PACK * BigInt(o.bonus + perk)) / 10000n;
      $("o" + i + "Bonus").textContent = pct(o.bonus + perk);
      $("o" + i + "Get").textContent = "You get " + fmt(get) + " STUD" + (perk ? " (includes GAME perk)" : "");
      $("o" + i + "Next").textContent = pct(next + perk);
      $("o" + i + "Min").textContent = pct(o.min + perk);
      $("o" + i + "Lock").textContent = o.cooldown + " s";
      $("o" + i + "Sold").textContent = String(o.sold);
      $("o" + i + "Last").textContent = short(o.lastBuyer);
      const badge = $("o" + i + "State");
      badge.textContent = left > 0 ? "Locked " + clock(left) : "Open";
      badge.className = "badge " + (left > 0 ? "warn" : "ok");
      $("o" + i + "Fill").style.width = left > 0 ? Math.min(100, (left / o.cooldown) * 100) + "%" : "0%";
    });
  }

  function renderWallet() {
    $("balEth").textContent = S.bal.eth === null ? "-" : Number(E.formatEther(S.bal.eth)).toLocaleString(undefined, { maximumFractionDigits: 4 });
    $("balStud").textContent = fmt(S.bal.stud);
    $("balGame").textContent = hasGame() ? fmt(S.bal.game) : "off";
    $("stock").textContent = hasContract() ? fmt(S.stock, 0) : "-";
    $("addTokenBtn").hidden = !S.account;
    const p = $("perkLine");
    if (!hasGame()) p.textContent = "The GAME perk is not enabled in this deployment.";
    else if (!S.account) p.textContent = "Connect a wallet to see whether you get the GAME perk (+1.00% when you hold at least 1 GAME).";
    else p.textContent = S.player && S.player.gamePerk ? "GAME perk active: +1.00% on every purchase." : "Hold at least 1 GAME to add 1.00% to every purchase.";
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

  function render() { renderHeader(); renderWallet(); renderPlayer(); renderOffers(); }

  // ---------- reads ----------
  async function loadChainState() {
    if (!hasContract()) return;
    try {
      const [offers, stock] = await Promise.all([S.reader.getOffers(), S.reader.stock()]);
      S.offers = Array.from(offers, (o) => ({
        bonus: Number(o.bonus), start: Number(o.startBonus), decay: Number(o.decay), min: Number(o.minBonus),
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
        what.textContent = NAMES[Number(l.args.offerId)].name + " at " + pct(l.args.bonusBps) + " bonus";
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
        try {
          for (const log of rc.logs) {
            const p = S.writer.interface.parseLog(log);
            if (p && p.name === "Purchased") msg = "Purchase confirmed: you received " + fmt(p.args.studReceived) + " STUD (bonus " + pct(Number(p.args.bonusBps) + (S.player && S.player.gamePerk ? 100 : 0)) + ").";
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
        const [pack, price, max] = await Promise.all([S.reader.PACK(), S.reader.PRICE(), S.reader.MAX_BUYS()]);
        S.c = { PACK: pack, PRICE: price, MAX: Number(max) };
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
