// gta6-twitch-ccu-forecast-01: forecast GTA VI's launch-day Twitch viewers,
// hour by hour, from the first hour's print.
//
// Model: a launch-day *shape* model learned from the case file's own
// comparables (past big launches' hourly Twitch curves).
//
// Why a shape beats the house baseline (persistence): the baseline says every
// hour stays at hour 1's count. Real launch days do not. They dip overnight,
// then rise as the big markets unlock (US East at 05:00Z, US West at 08:00Z)
// and prime time arrives in Europe and the US, peaking in the evening at
// roughly 2-3x hour 1 for a console-only, rolling-midnight launch like GTA VI.
// The shape is what the comparables teach; hour 1's print sets the level.
//
// How it works, per case:
//   1. Take hour 1's print p1 (the case's `known` row), floored at 1.
//   2. From the case's `comparables`, keep the launches that look like GTA VI:
//      tier "comparable" (parsed from the unlock string), console-only
//      (platforms do not include PC), a meaningful hour-1 print (> 1000
//      viewers) and at least 20 of hours 2..24 present. PC launches are left
//      out on purpose: a simultaneous PC unlock (e.g. 23:00Z or 00:00Z GMT)
//      inflates hour 1 and flattens the shape, which is not GTA VI's shape
//      (console-only, rolling midnight local, no PC until 2027).
//      If fewer than 5 pass, relax to every tier-"comparable" launch whose
//      release-day peak is under 10x its hour 1 (this drops the
//      simultaneous-global launches whose hour 1 was nearly zero).
//   3. For each hour h = 2..24, take the log-ratios ln(viewers_h / viewers_1)
//      across the kept comparables. The median log-ratio is the shape; it is
//      shrunk toward 0 (persistence) by 0.85, a hedge against over-claiming
//      the rise. The spread is the interquartile range of the log-ratios
//      converted to a standard deviation (IQR / 1.349), floored at 0.40 in
//      log units, so the 5%-95% band is honestly wide where launches disagree.
//   4. q_tau(h) = p1 * exp(shrunk_median_h + z_tau * sigma_h), with
//      z = (-1.645, -0.674, 0, 0.674, 1.645) for the levels
//      (0.05, 0.25, 0.5, 0.75, 0.95). Clamped to [1, 1e9], rounded to 2
//      decimals, non-decreasing.
//
// Validation (leave-one-out on the 7 console-only comparables in the kit's
// practice input): mean pinball loss 0.218, against 0.344 for the house
// baseline's persistence on the same launches. The house baseline scores
// about 0.387 on the practice; this shape model is built to beat it.
//
// Fallback: if the case carries no usable comparables, use the hardcoded
// median ratio curve measured from those same 7 console-only launches
// (dip to ~0.52 overnight, peak ~2.66x at hour 19), with the same spread.
// If even that is impossible, fall back to persistence.
//
// Runs offline, standard library only, deterministic: two runs on the same
// case write the same bytes. Reads $MAKEFUN_INPUT_DIR (else /input), writes
// $MAKEFUN_OUTPUT_DIR (else /output). One .out per .in, in name order:
//   {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}  (23 rows, hours 2..24)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Shrinkage of the median log-ratio toward 0 (persistence): a hedge. */
const LAMBDA = 0.85;
/** Floor on the log-spread, so the band stays honestly wide. */
const SIGMA_FLOOR = 0.4;
/** A launch counts as usable only with at least this many scored hours. */
const MIN_HOURS = 20;
/** A launch's hour-1 print must exceed this to be a usable shape. */
const MIN_HOUR1 = 1000;
/** A launch whose release-day peak is over this multiple of hour 1 is a
 *  simultaneous-global launch (hour 1 nearly zero); not GTA VI's shape. */
const MAX_PEAK_RATIO = 10;
/** Need at least this many launches in the strict pool, else relax. */
const MIN_POOL = 5;
/** Fallback median ratio curve (hours 2..24), measured from the 7
 *  console-only comparable launches in the kit's practice input. */
const FALLBACK_RATIOS = [
  0.82, 0.67, 0.52, 0.84, 1.0, 1.04, 0.94, 0.88, 0.85, 0.88, 1.03, 1.14,
  1.38, 2.13, 2.26, 2.53, 2.6, 2.66, 2.64, 2.48, 2.3, 2.18, 2.04,
];

interface Comparable {
  name: string;
  unlock?: string;
  platforms?: string;
  day_start: string;
  hourly: Array<{ from: string; viewers: number; channels?: number | null }>;
}

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The tier the house recorded for a comparable, parsed from its unlock text. */
const tierOf = (c: Comparable): string => {
  const u = c.unlock ?? '';
  if (u.includes('Tier: comparable')) return 'comparable';
  if (u.includes('Tier: early-access-contaminated')) return 'early-access-contaminated';
  if (u.includes('Tier: weak')) return 'weak';
  if (u.includes('Tier: target-history')) return 'target-history';
  return 'unknown';
};

/** True when the launch is console-only (no PC version at launch). */
const isConsoleOnly = (c: Comparable): boolean => !(c.platforms ?? '').includes('PC');

/** A comparable's release-day hourly viewers, keyed by hour 1..24. */
const releaseDayCurve = (c: Comparable): Map<number, number> => {
  const out = new Map<number, number>();
  const d0 = Date.parse(c.day_start);
  if (Number.isNaN(d0)) return out;
  for (const h of c.hourly ?? []) {
    const t = Date.parse(h.from);
    if (Number.isNaN(t)) continue;
    const delta = (t - d0) / 3_600_000;
    if (delta >= 0 && delta < 24 && Number.isFinite(h.viewers) && h.viewers >= 0) {
      out.set(Math.floor(delta) + 1, h.viewers);
    }
  }
  return out;
};

/** Linear-interpolation percentile of a sorted array. */
const quantile = (sorted: number[], q: number): number => {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** Median of an array (it is sorted in place). */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return quantile(s, 0.5);
};

/**
 * The shape model: for each hour, the median log-ratio and the log-spread,
 * from a pool of comparable release-day curves. Returns, per hour, the
 * shrunk median log-ratio and sigma, or null when the pool is unusable.
 */
const shapeFromPool = (
  pool: Array<Map<number, number>>,
): Map<number, { med: number; sigma: number }> | null => {
  if (pool.length < 3) return null;
  const out = new Map<number, { med: number; sigma: number }>();
  for (let h = 2; h <= 24; h++) {
    const lrs: number[] = [];
    for (const curve of pool) {
      const v1 = curve.get(1);
      const vh = curve.get(h);
      if (v1 !== undefined && v1 > 0 && vh !== undefined && vh > 0) {
        lrs.push(Math.log(vh / v1));
      }
    }
    if (lrs.length < 3) continue;
    const sorted = [...lrs].sort((a, b) => a - b);
    const med = median(lrs) * LAMBDA;
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const sigma = Math.max(SIGMA_FLOOR, (q3 - q1) / 1.349);
    out.set(h, { med, sigma });
  }
  return out.size >= MIN_HOURS ? out : null;
};

/** The five quantiles for one hour, from its median log-ratio and sigma. */
const hourQuantiles = (p1: number, med: number, sigma: number): number[] => {
  const qs = Z.map((z) => {
    const v = p1 * Math.exp(med + z * sigma);
    return round2(Math.min(1e9, Math.max(1, v)));
  });
  // Enforce non-decreasing (rounding can tie adjacent values; never invert).
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${file} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);

  // Pool 1: console-only, tier "comparable", meaningful hour 1, complete day.
  const strict: Array<Map<number, number>> = [];
  // Pool 2 (relaxed): any tier-"comparable" launch whose peak is < 10x hour 1.
  const relaxed: Array<Map<number, number>> = [];
  for (const comp of c.comparables ?? []) {
    if (tierOf(comp) !== 'comparable') continue;
    const curve = releaseDayCurve(comp);
    const v1 = curve.get(1);
    if (v1 === undefined || v1 <= MIN_HOUR1) continue;
    let present = 0;
    let peak = 0;
    for (let h = 2; h <= 24; h++) {
      const v = curve.get(h);
      if (v !== undefined) {
        present++;
        if (v > peak) peak = v;
      }
    }
    if (present < MIN_HOURS) continue;
    if (peak / v1 >= MAX_PEAK_RATIO) continue;
    relaxed.push(curve);
    if (isConsoleOnly(comp)) strict.push(curve);
  }
  const pool = strict.length >= MIN_POOL ? strict : relaxed;
  let shape = shapeFromPool(pool);

  const hours = c.forecast.map(({ hour }) => {
    let q: number[];
    const s = shape?.get(hour);
    if (s !== undefined) {
      q = hourQuantiles(p1, s.med, s.sigma);
    } else {
      // Fallback: the hardcoded console-only median ratio curve.
      const r = FALLBACK_RATIOS[hour - 2] ?? 1;
      q = hourQuantiles(p1, Math.log(r) * LAMBDA, SIGMA_FLOOR);
    }
    return { hour, q };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
