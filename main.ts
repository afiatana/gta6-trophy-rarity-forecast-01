// gta6-trophy-rarity-forecast-01 — forecast Exophase earn rates for every GTA VI
// trophy on PS5 at the case's target, as five quantiles per trophy (Node 22,
// standard library only, no network, deterministic).
//
// Model — one forecaster per trophy, fitted only from the case file:
//
//   1. Logit trend in log-time. For each read j, x_j = ln(1 + hours from the
//      release instant 2026-11-19T00:00:00Z to the read) and y_j = logit of the
//      trophy's rate. A weighted least-squares line y ~ a + b*x is fitted with
//      weights 0.5 ** ((t_last - t_j) / 24h), so recent reads count most.
//      Log-time is the right clock for a launch: earn rates move fastest in
//      the first hours and flatten as the player base matures, and a line in
//      log-time extrapolates that deceleration instead of a straight line in
//      wall-clock time, which would explode over a 4.5-day horizon.
//   2. Slope shrinkage to a tier prior. The fitted slope is blended with a
//      prior slope b0 classified from the trophy's description (story chapter,
//      final mission, side mission, easy one-off, grind/collectible, 100%
//      completion, platinum — see priorSlope). Blend weight
//      w = Sxx / (Sxx + 0.75), where Sxx is the weighted spread of x: on
//      launch night every read is the same stale page, so Sxx ~ 0 and the
//      prior rules; in the final the history spans ~2.5 days of real reads,
//      Sxx is large and the fitted trend dominates. |b| is capped at 2.5.
//      The prior is what makes a flat history forecast movement at all:
//      story trophies climb fast in week one as players progress, grind and
//      collectible trophies climb slowly, platinum barely moves.
//   3. Monotonicity the game enforces. Story medians must fall along the
//      chain Chapter 1 >= Chapter 2 >= Chapter 3 >= Chapter 4 >= final
//      mission (you cannot finish a later chapter without the earlier ones),
//      and the platinum and the 100%-completion gold must sit at or below
//      every other trophy's median (they require all of them). Violations
//      are repaired on the medians with a pool-adjacent-violators pass.
//   4. Honest spread. sigma = sqrt(0.35^2 + 0.30^2 * horizon_days
//      + (se_b * dx)^2), where se_b is the slope's standard error and dx
//      the extrapolation distance in log-time. The 0.35 floor is the
//      refresh-jump risk: Exophase refreshes on its own schedule, and the
//      one refresh the kit records moved every rate at once (638 -> 3,868
//      players tracked, almost every rate down), so even a 90-minute
//      horizon deserves a real band — the house baseline's 0.125-logit band
//      for the practice covers nothing (practice loss ~1.51, coverage ~0).
//      For the final (4.52 days) sigma lands ~0.73-0.9 logit, narrower
//      than the house baseline's 1.06 because the median now carries the
//      trend instead of standing still, but still wide enough to cover a
//      refresh and a trend miss.
//   5. Degenerate inputs degrade to the prior, never to a crash: one
//      distinct read -> slope = prior anchored at the last rate; no usable
//      history -> tier prior absolute medians with sigma 1.5.
//
// Quantiles are the normal quantiles on the logit scale
// (z = -1.645, -0.674, 0, 0.674, 1.645), mapped back to percent, rounded
// to 4 decimals, forced non-decreasing and clamped to [0.01, 99.99].
// Pure arithmetic on the case file: no randomness, no clock, no network,
// so two runs are byte-identical.
//
// What it must do (RULES.txt):
//   - read every <id>.in in the input directory ($MAKEFUN_INPUT_DIR, else
//     /input), one case per file, JSON schema "makefun/gta6-trophies-case/v1";
//   - write <id>.out to the output directory ($MAKEFUN_OUTPUT_DIR, else
//     /output): {"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}, ...]}, one
//     row per trophy, each id once, five finite numbers 0..100,
//     non-decreasing, at most 65,536 bytes.
// Run locally: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Release instant: the log-time clock is measured from here. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** Recency half-life of a read's weight, in hours. */
const HALF_LIFE_H = 24;
/** Blend constant: w = Sxx / (Sxx + SHRINK) weights the fitted slope vs the prior. */
const SHRINK = 0.75;
/** Hard cap on |slope|, logit units per unit of ln(1 + hours). */
const SLOPE_CAP = 2.5;
/** Hard cap on how far a median may move from the last read, in logit units. */
const MOVE_CAP = 4.0;
/** Spread floor (refresh-jump risk) and per-sqrt-day random-walk spread, logit units. */
const SIGMA_FLOOR = 0.35;
const SIGMA_RW = 0.3;
/** Spread cap, logit units. */
const SIGMA_CAP = 1.6;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
}

interface Read {
  at: string;
  rates: Array<number | null>;
}

interface Case {
  levels: number[];
  horizon_minutes: number;
  target?: string;
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Hours from the release instant to an ISO timestamp (never negative). */
const hoursSinceRelease = (iso: string): number =>
  Math.max(0, (Date.parse(iso) - RELEASE_MS) / 3_600_000);

/** Chapter number from "Complete Chapter N.", else 0. */
const chapterOf = (desc: string): number => {
  const m = /Complete Chapter (\d+)/.exec(desc);
  return m ? Number(m[1]) : 0;
};

const isGrind = (desc: string): boolean =>
  /250 Stunts|gold medal in all|100 locations|3 Collectible Card sets|50 Challenges|Win 20 different races|Meditate at every spot|Explore all of Leonida|Complete 8 mission strands|100% Completion/.test(
    desc,
  );

/**
 * Prior slope of the logit rate per unit of ln(1 + hours since release):
 * story climbs fast in week one as players progress, side missions and
 * easy one-offs climb moderately, grind/collectibles climb slowly,
 * platinum and 100% completion barely move.
 */
const priorSlope = (t: Trophy): number => {
  const ch = chapterOf(t.description);
  if (t.tier === 'platinum') return 0.2;
  if (/100% Completion/.test(t.description)) return 0.2;
  if (ch > 0) return 1.3 - 0.1 * ch; // Ch1 1.2, Ch2 1.1, Ch3 1.0, Ch4 0.9
  if (/Complete the final mission/.test(t.description)) return 0.8;
  if (isGrind(t.description)) return 0.3;
  if (/^Complete /.test(t.description)) return 0.7; // side / stranger missions
  if (t.tier === 'silver') return 0.4;
  if (t.tier === 'gold') return 0.5;
  return 0.55; // default bronze one-off
};

/** Prior absolute median (percent) when a case carries no usable history. */
const priorMedianPct = (t: Trophy): number => {
  const ch = chapterOf(t.description);
  if (t.tier === 'platinum') return 0.5;
  if (/100% Completion/.test(t.description)) return 0.8;
  if (ch > 0) return [25, 18, 14, 11][ch - 1] ?? 10;
  if (/Complete the final mission/.test(t.description)) return 8;
  if (isGrind(t.description)) return 1.5;
  if (/^Complete /.test(t.description)) return 6;
  return t.tier === 'silver' ? 2 : 4;
};

interface Fit {
  medianLogit: number;
  sigma: number;
}

/** Fit one trophy's forecast from its history series. */
const fitTrophy = (t: Trophy, series: Array<{ x: number; y: number; w: number }>, xTarget: number, horizonDays: number): Fit => {
  const b0 = priorSlope(t);
  if (series.length === 0) {
    return { medianLogit: logit(priorMedianPct(t)), sigma: 1.5 };
  }
  const last = series[series.length - 1];
  // Weighted centroid and spread of x.
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const p of series) {
    sw += p.w;
    sx += p.w * p.x;
    sy += p.w * p.y;
  }
  const xBar = sx / sw;
  const yBar = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (const p of series) {
    const dx = p.x - xBar;
    sxx += p.w * dx * dx;
    sxy += p.w * dx * (p.y - yBar);
  }
  const bFit = sxx > 1e-12 ? sxy / sxx : 0;
  const wFit = sxx / (sxx + SHRINK);
  let b = wFit * bFit + (1 - wFit) * b0;
  b = Math.max(-SLOPE_CAP, Math.min(SLOPE_CAP, b));
  // Residual variance around the fitted line, for the slope standard error.
  let rss = 0;
  for (const p of series) {
    const r = p.y - (yBar + bFit * (p.x - xBar));
    rss += p.w * r * r;
  }
  const dof = Math.max(1, sw - 2);
  const s2 = rss / dof;
  const seB = sxx > 1e-12 ? Math.min(0.8, Math.sqrt(Math.max(0, s2) / sxx)) : 0.25;
  const dx = Math.max(0, xTarget - last.x);
  // Median from the shrunk line through the weighted centroid.
  let median = yBar + b * (xTarget - xBar);
  // Never let the median run absurdly far from the last observed rate.
  median = Math.max(last.y - MOVE_CAP, Math.min(last.y + MOVE_CAP, median));
  const sigma = Math.min(
    SIGMA_CAP,
    Math.sqrt(SIGMA_FLOOR * SIGMA_FLOOR + SIGMA_RW * SIGMA_RW * horizonDays + (seB * dx) * (seB * dx)),
  );
  return { medianLogit: median, sigma };
};

/** Pool-adjacent-violators pass enforcing a non-increasing sequence (in place). */
const enforceNonIncreasing = (vals: number[]): void => {
  // vals must end up vals[0] >= vals[1] >= ... ; average violating blocks.
  const stack: Array<{ sum: number; n: number }> = [];
  for (const v of vals) {
    let sum = v;
    let n = 1;
    while (stack.length > 0 && stack[stack.length - 1].sum / stack[stack.length - 1].n < sum / n) {
      const top = stack.pop()!;
      sum += top.sum;
      n += top.n;
    }
    stack.push({ sum, n });
  }
  let i = 0;
  for (const block of stack) {
    const avg = block.sum / block.n;
    for (let k = 0; k < block.n; k++) vals[i++] = avg;
  }
};

const forecastCase = (c: Case): Array<{ id: number; q: number[] }> => {
  const horizonDays = c.horizon_minutes / 1440;
  // The target instant is `at` + horizon; fall back to the last read's clock
  // plus the horizon when `target` is absent.
  const targetMs =
    c.target !== undefined
      ? Date.parse(c.target)
      : Date.parse(c.history[c.history.length - 1].at) + c.horizon_minutes * 60_000;
  const xT = Math.log(1 + Math.max(0, (targetMs - RELEASE_MS) / 3_600_000));

  const lastAt = c.history.length > 0 ? Date.parse(c.history[c.history.length - 1].at) : RELEASE_MS;
  const fits: Fit[] = c.trophies.map((t, i) => {
    const series: Array<{ x: number; y: number; w: number }> = [];
    for (const h of c.history) {
      const r = h.rates[i];
      if (r === null || r === undefined) continue;
      const x = Math.log(1 + hoursSinceRelease(h.at));
      const w = Math.pow(0.5, Math.max(0, lastAt - Date.parse(h.at)) / (HALF_LIFE_H * 3_600_000));
      series.push({ x, y: logit(r), w });
    }
    return fitTrophy(t, series, xT, horizonDays);
  });

  // Story-chain monotonicity on the medians: Ch1 >= Ch2 >= Ch3 >= Ch4 >= final.
  const medians = fits.map((f) => f.medianLogit);
  const chainIdx: number[] = [];
  for (let ch = 1; ch <= 4; ch++) {
    const idx = c.trophies.findIndex((t) => chapterOf(t.description) === ch);
    if (idx >= 0) chainIdx.push(idx);
  }
  const finalIdx = c.trophies.findIndex((t) => /Complete the final mission/.test(t.description));
  if (finalIdx >= 0) chainIdx.push(finalIdx);
  if (chainIdx.length > 1) {
    const chain = chainIdx.map((idx) => medians[idx]);
    enforceNonIncreasing(chain);
    chainIdx.forEach((idx, k) => {
      medians[idx] = chain[k];
    });
  }
  // Platinum and 100%-completion sit at or below every other trophy.
  const others = medians.filter((_, i) => {
    const t = c.trophies[i];
    return t.tier !== 'platinum' && !/100% Completion/.test(t.description);
  });
  if (others.length > 0) {
    const cap = Math.min(...others);
    c.trophies.forEach((t, i) => {
      if (t.tier === 'platinum' || /100% Completion/.test(t.description)) {
        medians[i] = Math.min(medians[i], cap);
      }
    });
  }

  return c.trophies.map((t, i) => {
    const { sigma } = fits[i];
    const m = medians[i];
    const q = Z.map((z) => round4(clamp(invLogit(m + z * sigma))));
    // Guarantee non-decreasing after rounding.
    for (let k = 1; k < q.length; k++) q[k] = Math.max(q[k], q[k - 1]);
    return { id: t.id, q };
  });
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
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
