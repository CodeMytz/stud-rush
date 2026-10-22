// Reactive app state + every chain interaction (ethers v6).
// The page only reads and displays state. Scoring, round winners, timers and payouts are decided by YieldArena.sol.
import { BrowserProvider, Contract, JsonRpcProvider, isAddress, ZeroAddress } from "ethers";
import abi from "./abi.json";
import deployment from "./deployment.json";
import { roundAt, same } from "./format.js";

export const CHAIN_ID = deployment.chainId;
export const CONTRACT = deployment.address;
// Uniswap swap page: SepoliaETH -> STUD (address comes from deployment.json, so it always matches the game).
export const BUY_URL = `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=NATIVE&outputCurrency=${(deployment.stud || "").toLowerCase()}`;
export const EXPLORER = import.meta.env.VITE_EXPLORER || "https://sepolia.etherscan.io";
const READ_RPC = import.meta.env.VITE_READ_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const POLL_MS = 3000;
const RECENT = 12; // how many latest games the lobby and history read

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

// Contract revert reasons -> short player-facing text.
const REASONS = {
  "Not enough STUD": "Not enough STUD for the 50 STUD entry.",
  "Approve STUD first": "Approve STUD first.",
  "Lobby closed": "This game already started.",
  "Already joined": "You already joined this game.",
  "Game is full": "This game is full.",
  "Unknown game": "Unknown game.",
  "Join first": "Join this game first.",
  "No round is open": "No round is open right now.",
  "Already picked this round": "You already picked this round.",
  "Game not over": "The game is not over yet.",
  "Already finished": "Already settled.",
  "Only the host": "Only the host can do that.",
  "Need 2 players": "At least 2 players are needed to start.",
  "Already started": "The game already started.",
  "Game cancelled": "This game was cancelled.",
  "Not in this game": "You are not in this game.",
  "Host must cancel": "The host cancels the game instead of leaving.",
};

export const app = $state({
  deployed: isAddress(CONTRACT || ""),
  hasWallet: typeof window !== "undefined" && !!window.ethereum,
  account: null,
  chainOk: false,
  busy: false,
  now: Math.floor(Date.now() / 1000),
  error: "",
  tx: null, // { state: "wait" | "ok" | "bad", text, hash }
  fee: 0n,
  studBal: 0n, studDec: 18,
  score: 0n,
  gamesWon: 0n,
  games: [],
  activeId: null,
  detail: null,
  dismissed: {},
});

let provider, reader, studR, studW, writer;
const dealCache = new Map();

// ---------- chain clock ----------
// app.now = estimated chain time (seconds, fractional). It runs on the browser's monotonic clock, so it never
// stalls or jumps when a poll is slow. Each new block tells us "chain time minus local time"; a block is always
// seen a little AFTER it was made, so the largest recent sample is the most accurate one. The clock is eased
// toward that value (at most 10 % faster or slower), so corrections are never visible as jumps in the countdown.
const mono = () => (performance.timeOrigin + performance.now()) / 1000;
let samples = [];      // one sample per distinct block
let lastBlock = -1;
let offset = null;     // chain time - local time, smoothed
let lastTick = 0;

function noteBlock(blk) {
  if (blk.number === lastBlock) return;
  lastBlock = blk.number;
  samples = [...samples.slice(-19), blk.timestamp - mono()];
}

function tick() {
  const t = mono();
  if (!samples.length) { app.now = t; lastTick = t; return; }
  const target = Math.max(...samples);
  if (offset === null || Math.abs(target - offset) > 8) offset = target; // first value, or the PC clock was changed
  else {
    const step = Math.max(0, t - lastTick) * 0.1;
    offset += Math.max(-step, Math.min(step, target - offset));
  }
  lastTick = t;
  app.now = t + offset;
}

// ---------- errors ----------
const rejected = (e) => !!e && (e.code === "ACTION_REJECTED" || e.code === 4001 || e?.info?.error?.code === 4001);
function pretty(e) {
  if (rejected(e)) return "Rejected in MetaMask. Nothing was sent.";
  const text = [e?.reason, e?.revert?.args?.[0], e?.shortMessage, e?.info?.error?.message, e?.message].filter(Boolean).join(" | ");
  const hit = Object.keys(REASONS).find((r) => text.includes(r));
  if (hit) return REASONS[hit];
  if (e?.code === "INSUFFICIENT_FUNDS") return "Not enough Sepolia ETH for gas.";
  return (text || String(e)).slice(0, 200);
}

// ---------- reading ----------
const plainGame = (id, g) => ({
  id: Number(id),
  creator: g.creator,
  start: Number(g.startTime),   // 0 = lobby, still waiting for players
  skipped: Number(g.skipped),
  cancelled: g.cancelled,
  count: Number(g.playerCount),
  settled: g.settled,
  winner: g.winner,
  winnerWins: Number(g.winnerWins),
  pot: g.pot,
  joined: false,
});

async function loadDeals(id, r) {
  const key = id + ":" + r;
  if (!dealCache.has(key)) {
    const d = await reader.getRoundDeals(id, r);
    dealCache.set(key, d.map((x) => ({ rate: Number(x.rate), periods: Number(x.periods), feeBps: Number(x.feeBps) })));
  }
  return dealCache.get(key);
}

async function loadDetail(id) {
  const g = app.games.find((x) => x.id === id);
  if (!g) return;
  const r = roundAt(g.start, g.skipped, app.now).r;
  // One round ahead, so the next round's deals are already there the moment it opens.
  const shown = g.start ? Math.min(r + 1, 5) : 0;
  const deals = await Promise.all(Array.from({ length: shown }, (_, i) => loadDeals(id, i)));
  const [picks, rw, total, players, made] = await Promise.all([
    reader.getPicks(id, app.account),
    reader.getRoundWinners(id),
    reader.totalValue(id, app.account),
    reader.getPlayers(id),
    r >= 1 && r <= 5 ? reader.picksMade(id, r - 1) : 0,
  ]);
  // Who has already picked in the current round (shown in the players list).
  const picked = r >= 1 && r <= 5
    ? (await Promise.all(players.map((a) => reader.getPicks(id, a)))).map((x) => Number(x[r - 1]) > 0)
    : [];
  app.detail = { id, deals, picks: [...picks].map(Number), winners: [...rw[0]], total, players: [...players], picked, made: Number(made) };
}

export async function refresh() {
  if (!app.deployed || !reader) return;
  try {
    const blk = await provider.getBlock("latest");
    noteBlock(blk);
    tick();

    const count = Number(await reader.gameCount());
    const ids = [];
    for (let id = count; id >= Math.max(1, count - RECENT + 1); id--) ids.push(id);
    const [infos, joined] = await Promise.all([
      Promise.all(ids.map((id) => reader.gameInfo(id))),
      Promise.all(ids.map((id) => (app.account ? reader.joined(id, app.account) : false))),
    ]);
    const games = infos.map((r, i) => ({ ...plainGame(ids[i], r[0]), joined: joined[i] }));
    app.games = games;

    if (app.account) {
      const [s, g, sc, gw] = await Promise.all([
        studR.balanceOf(app.account),
        reader.score(app.account), reader.gamesWon(app.account),
      ]);
      app.studBal = s; app.score = sc; app.gamesWon = gw;
    }

    // The game the player is in right now (newest joined, not settled). A game settled this session stays until closed.
    const live = games.find((g) => g.joined && !g.settled);
    if (live) app.activeId = live.id;
    else if (app.activeId && !games.find((g) => g.id === app.activeId && g.settled && !app.dismissed[g.id])) app.activeId = null;

    if (app.activeId && app.account) await loadDetail(app.activeId);
    else app.detail = null;
    app.error = "";
  } catch (e) {
    app.error = "Could not read the contract: " + (e.shortMessage || e.message || e).toString().slice(0, 120);
  }
}

// ---------- wallet ----------
async function bind(p) {
  const signer = await p.getSigner();
  app.account = await signer.getAddress();
  const net = await p.getNetwork();
  app.chainOk = Number(net.chainId) === CHAIN_ID;
  writer = studW = null;
  if (app.chainOk && app.deployed && reader) {
    writer = new Contract(CONTRACT, abi, signer);
    studW = new Contract(await studR.getAddress(), ERC20, signer);
  }
  await refresh();
}

export async function connect() {
  if (!window.ethereum) { app.error = "MetaMask not found. Install it and reload."; return; }
  try {
    app.error = "";
    const p = new BrowserProvider(window.ethereum);
    await p.send("eth_requestAccounts", []);
    await bind(p);
    if (!app.chainOk) await switchNetwork();
  } catch (e) { app.tx = { state: "bad", text: pretty(e) }; }
}

export async function switchNetwork() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CHAIN_ID.toString(16) }] });
    await bind(new BrowserProvider(window.ethereum));
  } catch (e) { app.tx = { state: "bad", text: pretty(e) }; }
}

// ---------- writing ----------
/** Runs transactions one after the other (e.g. approve, then join) and reports each one. */
async function run(steps) {
  if (app.busy) return;
  if (!app.account) { app.tx = { state: "bad", text: "Connect your wallet first." }; return; }
  if (!writer) { app.tx = { state: "bad", text: "Switch MetaMask to Sepolia first." }; return; }
  app.busy = true;
  try {
    for (const [i, step] of steps.entries()) {
      const label = steps.length > 1 ? `${step.label} (${i + 1}/${steps.length})` : step.label;
      app.tx = { state: "wait", text: `Confirm ${label} in MetaMask…` };
      const tx = await step.fn();
      app.tx = { state: "wait", text: `${label} pending…`, hash: tx.hash };
      await tx.wait();
      app.tx = { state: "ok", text: `${step.label} confirmed`, hash: tx.hash };
    }
  } catch (e) {
    app.tx = { state: "bad", text: pretty(e) };
  } finally {
    app.busy = false;
    refresh();
  }
}

async function entrySteps(call) {
  const steps = [];
  if (app.studBal < app.fee) { app.tx = { state: "bad", text: REASONS["Not enough STUD"] }; return null; }
  const have = await studR.allowance(app.account, CONTRACT);
  if (have < app.fee) steps.push({ label: "approve 50 STUD", fn: () => studW.approve(CONTRACT, app.fee) });
  steps.push(call);
  return steps;
}

export const actions = {
  async create() {
    const steps = await entrySteps({ label: "create game", fn: () => writer.createGame() });
    if (steps) run(steps);
  },
  async join(id) {
    const steps = await entrySteps({ label: `join game #${id}`, fn: () => writer.join(id) });
    if (steps) run(steps);
  },
  pick: (id, slot) => run([{ label: `pick ${"ABCD"[slot]}`, fn: () => writer.pick(id, slot) }]),
  begin: (id) => run([{ label: `start game #${id}`, fn: () => writer.start(id) }]),
  cancel: (id) => run([{ label: `cancel game #${id} (refund)`, fn: () => writer.cancel(id) }]),
  leave: (id) => run([{ label: `leave game #${id} (refund)`, fn: () => writer.leave(id) }]),
  settle: (id) => run([{ label: `settle game #${id}`, fn: () => writer.finish(id) }]),
  close(id) { app.dismissed[id] = true; app.activeId = null; app.detail = null; },
};

// ---------- start ----------
export async function start() {
  if (!app.deployed) return;
  provider = new JsonRpcProvider(READ_RPC, CHAIN_ID, { staticNetwork: true });
  reader = new Contract(CONTRACT, abi, provider);
  try {
    const [s, fee] = await Promise.all([reader.stud(), reader.entryFee()]);
    studR = new Contract(s, ERC20, provider);
    app.studDec = Number(await studR.decimals()); app.fee = fee;
  } catch (e) {
    app.error = "Could not read the contract: " + (e.shortMessage || e.message || e).toString().slice(0, 120);
    return;
  }
  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
    try {
      const p = new BrowserProvider(window.ethereum);
      if ((await p.send("eth_accounts", [])).length) await bind(p);
    } catch (_) { /* stays disconnected */ }
  }
  await refresh();
  setInterval(refresh, POLL_MS);
  tick();
  setInterval(tick, 250);
}

export { same, ZeroAddress };