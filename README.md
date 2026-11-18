# GTA VI Twitch Viewers Forecaster

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Skymavis7/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Skymavis7/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

Entry for [make.fun](https://make.fun) competition `gta6-twitch-ccu-forecast-01` ($250, Forecasting).

## Problem

Grand Theft Auto VI releases on 19 November 2026 on PlayStation 5 and Xbox Series X|S only (no PC). No console maker publishes a player count, so this contest forecasts the next best public signal: the number of concurrent viewers in Twitch's "Grand Theft Auto VI" category (Twitch game id 1867279146). One hour into the release day (UTC), the program reads hour 1's viewer print from the case file and forecasts hours 2–24, hour by hour, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95) per hour. Score is mean pinball loss on the log scale; lower is better, and a prize needs a loss strictly below the best house entry (house persistence baseline: ~0.387 on the practice set).

## Model

A launch-day **shape model** learned at runtime from the case file's own `comparables` — past big launches' hourly Twitch curves. Hour 1's print sets the level; the comparables teach the shape:

1. Keep comparables that look like GTA VI: tier `"comparable"`, console-only (platforms do not include PC), hour-1 viewers > 1000, and at least 20 of hours 2–24 present. If fewer than 5 pass, relax to tier-"comparable" launches whose release-day peak is under 10× hour 1.
2. For each hour h = 2..24, take the log-ratios ln(viewers_h / viewers_1) across the kept comparables. The median log-ratio, shrunk toward 0 by 0.85, is the shape; sigma = max(0.40, (Q3 − Q1) / 1.349) is the spread, honestly wide where launches disagree.
3. q_tau(h) = p1 · exp(median_lr · 0.85 + z_tau · sigma), z = (−1.645, −0.674, 0, 0.674, 1.645), clamped to [1, 1e9] and rounded to 2 decimals.
4. Fallbacks: a hardcoded median ratio curve if no comparables are usable, then persistence (every hour = hour 1) if even that fails — so the output is always valid.

Validation (leave-one-out on the kit's practice comparables): mean pinball loss **0.218**, vs 0.344 for persistence on the same cases.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network, deterministic (two runs write identical bytes), well under the 8-second per-case cap.

## Files

- `main.ts` — the forecaster (reads every `*.in` in the input dir, writes one `.out` per case)
- `package.json` — `{"type":"module"}`
- `LICENSE` — MIT
