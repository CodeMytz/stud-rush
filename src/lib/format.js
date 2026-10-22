import { formatUnits, ZeroAddress } from "ethers";

export const ROUND_S = [120, 90, 75, 60, 45]; // same as roundSeconds in YieldArena.sol

export const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const short = (a) => (a && a !== ZeroAddress ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
export const clock = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
export const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
export const feePts = (bps) => (Number(bps) / 10).toFixed(1);

/** Token amount with at most `max` decimals, thousands separators. */
export const amount = (v, dec = 18, max = 2) =>
  Number(formatUnits(v ?? 0n, dec)).toLocaleString(undefined, { maximumFractionDigits: max });

/** Game points (1e18 fixed point) */
export const pts = (v) => amount(v, 18, 1);

/**
 * Round state from chain time. r = 0 lobby (not started), 1..5 round, 6 over.
 * `left` = whole seconds until the round ends (never 0 inside a round). `skipped` = seconds the contract cut
 * because every player had already picked (the contract adds it to the elapsed time).
 */
export function roundAt(start, skipped, now) {
  if (!start) return { r: 0, left: 0, total: 0 };
  const t = Math.max(0, now - start) + skipped;
  let end = 0;
  for (let i = 0; i < ROUND_S.length; i++) {
    end += ROUND_S[i];
    if (t < end) return { r: i + 1, left: Math.ceil(end - t), total: ROUND_S[i] };
  }
  return { r: 6, left: 0, total: 0 };
}
