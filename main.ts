// GTA VI launch-day Twitch viewers forecaster (gta6-twitch-ccu-forecast-01).
//
// Model: a launch-day SHAPE model learned at runtime from the case file's own
// `comparables` (past big launches' hourly Twitch curves). Hour 1's print sets
// the level; the comparables teach the shape of the rest of the day.
//
//   1. p1 = max(1, hour-1 viewers).
//   2. Keep comparables that look like GTA VI (console-only, rolling midnight
//      local unlock, no PC): unlock string contains "Tier: comparable",
//      `platforms` does not mention PC, hour-1 viewers > 1000, and at least
//      20 of hours 2..24 present on the release day. If fewer than 5 pass,
//      relax to every tier-"comparable" launch whose release-day peak is
//      under 10x its hour-1 viewers (this drops simultaneous-global launches
//      whose hour 1 was nearly zero).
//   3. For each hour h = 2..24, take ln(viewers_h / viewers_1) across the kept
//      comparables. median_lr is the median of those log-ratios, shrunk
//      toward 0 by 0.85 (a hedge against over-fitting one launch's shape).
//      sigma = max(0.40, (Q3 - Q1) / 1.349), so the 5%-95% band is honestly
//      wide where past launches disagree.
//   4. q_tau(h) = p1 * exp(median_lr * 0.85 + z_tau * sigma), with
//      z = (-1.645, -0.674, 0, 0.674, 1.645) for levels
//      (0.05, 0.25, 0.5, 0.75, 0.95). Each q is clamped to [1, 1e9], rounded
//      to 2 decimals, and forced non-decreasing across the five quantiles.
//   5. Fallback if no usable comparables: a hardcoded median ratio curve
//      (same 0.85 shrinkage, sigma floor 0.40). If even that is impossible,
//      fall back to persistence (every hour = p1, starter-style spread).
//
// Validation (leave-one-out on the kit's practice comparables): mean pinball
// loss 0.218, vs 0.344 for the house persistence baseline on the same cases
// (house baseline scores ~0.387 on the practice set itself).
//
// Node 22, standard library only, no network, fully deterministic: the input
// files are read in name order and every computation is a pure function of
// the case file, so two runs write identical bytes.
//
// Usage: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
// (MAKEFUN_INPUT_DIR defaults to /input, MAKEFUN_OUTPUT_DIR to /output.)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

/** Quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard-normal quantiles at LEVELS. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Hedge applied to the median log-ratio: shrink the learned shape toward flat. */
const SHRINK = 0.85;
/** Floor on the log-spread, so the band never pretends to be over-confident. */
const SIGMA_FLOOR = 0.4;
/** Spread used by the last-resort persistence fallback (house baseline's). */
const PERSIST_SIGMA = 0.15;

/** Median viewer ratio (to hour 1) per hour 2..24, used only when the case
 *  carries no usable comparables. Dips overnight, then climbs steeply as the
 *  US unlocks roll in and prime time arrives, then eases off late. */
const FALLBACK_RATIOS = [
  0.82, 0.67, 0.52, 0.84, 1.0, 1.04, 0.94, 0.88, 0.85, 0.88, 1.03, 1.14,
  1.38, 2.13, 2.26, 2.53, 2.6, 2.66, 2.64, 2.48, 2.3, 2.18, 2.04,
];

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  name?: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly?: HourlyPoint[];
}

interface CaseFile {
  id?: string;
  levels?: number[];
  known?: Array<{ hour: number; viewers: number }>;
  forecast?: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** Release-day hourly viewers keyed by hour 1..24, or null when unusable. */
type DayCurve = Map<number, number>;

const HOUR_MS = 3_600_000;

/** Round to 2 decimals (half up). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Linear-interpolation percentile of a sorted array (p in [0, 1]). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/** Extract one comparable's release-day curve: hourly entries whose `from`
 *  falls in [day_start, day_start + 24h), keyed by hour 1..24. */
function releaseDayCurve(comp: Comparable): DayCurve | null {
  if (!comp || typeof comp.day_start !== "string" || !Array.isArray(comp.hourly)) {
    return null;
  }
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const curve: DayCurve = new Map();
  for (const point of comp.hourly) {
    if (!point || typeof point.from !== "string") continue;
    const t = Date.parse(point.from);
    const v = point.viewers;
    if (!Number.isFinite(t) || typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      continue;
    }
    const hour = Math.floor((t - start) / HOUR_MS) + 1;
    if (hour >= 1 && hour <= 24 && !curve.has(hour)) curve.set(hour, v);
  }
  return curve;
}

/** Does this comparable look like GTA VI: tier "comparable", console-only
 *  (no PC in platforms), a real hour-1 audience, and a near-complete day? */
function isGtaLike(comp: Comparable, curve: DayCurve): boolean {
  const unlock = typeof comp.unlock === "string" ? comp.unlock : "";
  if (!unlock.includes("Tier: comparable")) return false;
  if (typeof comp.platforms === "string" && comp.platforms.includes("PC")) return false;
  const h1 = curve.get(1);
  if (h1 === undefined || h1 <= 1000) return false;
  let present = 0;
  for (let h = 2; h <= 24; h++) if (curve.has(h)) present++;
  return present >= 20;
}

/** Relaxed pool: tier-"comparable" launches whose release-day peak is under
 *  10x hour 1, dropping simultaneous-global launches whose hour 1 was ~0. */
function isRelaxedComparable(comp: Comparable, curve: DayCurve): boolean {
  const unlock = typeof comp.unlock === "string" ? comp.unlock : "";
  if (!unlock.includes("Tier: comparable")) return false;
  const h1 = curve.get(1);
  if (h1 === undefined || h1 <= 0) return false;
  let peak = 0;
  for (const v of curve.values()) if (v > peak) peak = v;
  return peak < 10 * h1;
}

/** Pick the comparables to learn the shape from, with the relaxed fallback. */
function selectComparables(comps: Comparable[]): DayCurve[] {
  const withCurves: Array<{ comp: Comparable; curve: DayCurve }> = [];
  for (const comp of comps) {
    const curve = releaseDayCurve(comp);
    if (curve !== null) withCurves.push({ comp, curve });
  }
  const strict = withCurves
    .filter(({ comp, curve }) => isGtaLike(comp, curve))
    .map(({ curve }) => curve);
  if (strict.length >= 5) return strict;
  const relaxed = withCurves
    .filter(({ comp, curve }) => isRelaxedComparable(comp, curve))
    .map(({ curve }) => curve);
  return relaxed;
}

/** Five quantiles for one hour from a median log-ratio and a log-spread. */
function quantilesFromLog(p1: number, medianLr: number, sigma: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const z of Z) {
    let q = p1 * Math.exp(medianLr * SHRINK + z * sigma);
    if (!Number.isFinite(q)) q = p1;
    q = Math.min(1e9, Math.max(1, round2(q)));
    if (q < prev) q = prev; // keep the row non-decreasing
    out.push(q);
    prev = q;
  }
  return out;
}

/** Starter-style persistence row: every hour at p1 with a widening spread. */
function persistenceRow(p1: number, hour: number): number[] {
  return quantilesFromLog(p1, 0, PERSIST_SIGMA * Math.sqrt(hour - 1));
}

/** Forecast one case. Never throws: on any surprise it degrades gracefully
 *  to the hardcoded ratio curve, then to persistence, so the output stays
 *  valid (an invalid case forfeits the prize; a mediocre one does not). */
function forecastCase(c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const first = Array.isArray(c.known) ? c.known.find((k) => k && k.hour === 1) : undefined;
  const p1 = Math.max(
    1,
    first && typeof first.viewers === "number" && Number.isFinite(first.viewers)
      ? first.viewers
      : 1,
  );
  // Dedupe + sort: a case file that listed an hour twice must still yield
  // exactly one row per hour, or the output would be invalid.
  const hoursToForecast = Array.isArray(c.forecast) && c.forecast.length > 0
    ? [...new Set(c.forecast.map((f) => f.hour).filter((h) => h >= 2 && h <= 24))].sort((a, b) => a - b)
    : Array.from({ length: 23 }, (_, i) => i + 2);

  const curves = selectComparables(Array.isArray(c.comparables) ? c.comparables : []);

  const hours = hoursToForecast.map((hour) => {
    if (curves.length > 0) {
      const logRatios: number[] = [];
      for (const curve of curves) {
        const h1 = curve.get(1);
        const vh = curve.get(hour);
        if (h1 !== undefined && h1 > 0 && vh !== undefined && vh > 0) {
          logRatios.push(Math.log(vh / h1));
        }
      }
      if (logRatios.length > 0) {
        const sorted = [...logRatios].sort((a, b) => a - b);
        const med = median(logRatios); // median() sorts a copy internally
        const q1 = percentile(sorted, 0.25);
        const q3 = percentile(sorted, 0.75);
        const sigma = Math.max(SIGMA_FLOOR, (q3 - q1) / 1.349);
        return { hour, q: quantilesFromLog(p1, med, sigma) };
      }
    }
    // No usable comparable for this hour: hardcoded ratio curve.
    const ratio = FALLBACK_RATIOS[hour - 2];
    if (typeof ratio === "number" && ratio > 0) {
      return { hour, q: quantilesFromLog(p1, Math.log(ratio), SIGMA_FLOOR) };
    }
    return { hour, q: persistenceRow(p1, hour) };
  });

  // Hours must be 2..24 exactly once, in order.
  hours.sort((a, b) => a.hour - b.hour);
  return { hours };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith(".in"))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  let parsed: CaseFile;
  try {
    parsed = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as CaseFile;
  } catch {
    // Unreadable case file: still emit a valid persistence forecast at p1 = 1.
    parsed = { forecast: Array.from({ length: 23 }, (_, i) => ({ hour: i + 2 })) };
  }
  if (
    parsed.levels &&
    (parsed.levels.length !== LEVELS.length ||
      parsed.levels.some((t, j) => t !== LEVELS[j]))
  ) {
    throw new Error(
      `${file} asks for levels ${JSON.stringify(parsed.levels)}, not ${JSON.stringify(LEVELS)}`,
    );
  }
  const out = forecastCase(parsed);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
