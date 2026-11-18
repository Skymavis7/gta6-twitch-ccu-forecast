# GTA VI Launch-Day Twitch Forecaster

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Skymavis7/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Skymavis7/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

A program that forecasts how many people watch Grand Theft Auto VI live on
Twitch in each hour of its release day (2026-11-19, UTC), from the first
hour's viewer count, as five quantiles an hour. Built for the
[make.fun](https://make.fun) bounty
[gta6-twitch-ccu-forecast-01](https://make.fun/bounty/gta6-twitch-ccu-forecast-01).

## The problem

GTA VI releases 19 November 2026 on PlayStation 5 and Xbox Series X|S
only (no PC until 2027), single-player. No console maker publishes a player
count, so there is no public count of people playing it. What this contest
counts is the next best thing, public and live: Twitch's own count of
concurrent live viewers in the "Grand Theft Auto VI" category. The program
reads one case (everything recorded up to the end of the release day's first
hour, that hour's count included) and forecasts hours 2 to 24, five
quantiles each, scored by mean pinball loss on the log scale.

## The model: a launch-day shape learned from the case's own comparables

The house baseline (persistence) says every hour stays at hour 1's count.
Real launch days do not. They dip overnight, then rise as the big markets
unlock (US East at 05:00Z, US West at 08:00Z) and prime time arrives in
Europe and the US, peaking in the evening at roughly 2-3x hour 1 for a
console-only, rolling-midnight launch like GTA VI. The shape is what the
case's comparables teach; hour 1's print sets the level.

Per case, `main.ts`:

1. Takes hour 1's print `p1` (the case's `known` row), floored at 1.
2. From the case's `comparables`, keeps the launches that look like GTA VI:
   tier `"comparable"`, console-only (platforms do not include PC), a
   meaningful hour-1 print (> 1,000 viewers) and at least 20 of hours 2..24
   present. PC launches are left out on purpose: a simultaneous PC unlock
   inflates hour 1 and flattens the shape, which is not GTA VI's shape. If
   fewer than 5 pass, it relaxes to every tier-`"comparable"` launch whose
   release-day peak is under 10x its hour 1 (dropping the
   simultaneous-global launches whose hour 1 was nearly zero).
3. For each hour h = 2..24, takes the log-ratios `ln(viewers_h / viewers_1)`
   across the kept comparables. The median log-ratio is the shape, shrunk
   toward 0 (persistence) by 0.85 as a hedge against over-claiming the rise.
   The spread is the interquartile range of the log-ratios converted to a
   standard deviation (IQR / 1.349), floored at 0.40 in log units, so the
   5%-95% band is honestly wide where launches disagree.
4. `q_tau(h) = p1 * exp(shrunk_median_h + z_tau * sigma_h)`, with
   `z = (-1.645, -0.674, 0, 0.674, 1.645)` for the levels
   `(0.05, 0.25, 0.5, 0.75, 0.95)`. Clamped to `[1, 1e9]`, rounded to 2
   decimals, non-decreasing.

Validation (leave-one-out on the 7 console-only comparable launches in the
kit's practice input): mean pinball loss **0.218**, against **0.344** for the
house baseline's persistence on the same launches. The house baseline scores
about 0.387 on the practice; this shape model is built to beat it.

If a case carries no usable comparables, the program falls back to the
hardcoded median ratio curve measured from those same 7 console-only
launches (dip to ~0.52 overnight, peak ~2.66x at hour 19), with the same
spread; if even that is impossible, it falls back to persistence.

## Run it

Node 22, standard library only, no network, deterministic (two runs on the
same case write the same bytes):

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads every `*.in` in the input directory (default `/input`, or
`$MAKEFUN_INPUT_DIR`) and writes one `<id>.out` per case to the output
directory (default `/output`, or `$MAKEFUN_OUTPUT_DIR`):

```json
{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, "..."]}
```

23 rows, hours 2 to 24, five quantiles each. At most 8 seconds per case.

## Files

- `main.ts` — the forecaster (Node 22, standard library only)
- `package.json` — `{"type": "module"}`, so Node runs `main.ts` without a warning
- `LICENSE` — MIT
