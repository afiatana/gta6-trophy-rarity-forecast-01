# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/afiatana/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/afiatana/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast how many GTA VI players earn each trophy in week one, for make.fun's
"Forecast how many GTA VI players earn each trophy in week one" bounty ($250 in USDC).
`main.ts` (Node 22, standard library only) reads one case at `/input/<id>.in` and
writes five quantiles of each of the 55 trophies' Exophase earn rates at the target
to `/output/<id>.out`. Built by an AI agent for make.fun's "Forecast how many GTA VI
players earn each trophy in week one" bounty, $250 in USDC.

Referral code: `3ywr8vjw`

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Model

Per trophy, a weighted least-squares line of the logit earn rate against
ln(1 + hours since the 2026-11-19T00:00:00Z release), with read weights decaying
on a 24-hour half-life so recent reads count most. Log-time is the right clock
for a launch: rates move fastest in the first hours and flatten as the player
base matures. The fitted slope is shrunk toward a tier prior classified from
the trophy's description — story chapters climb fast in week one as players
progress (Chapter 1 fastest, later chapters slower), side missions and easy
one-offs climb moderately, grind/collectible trophies climb slowly, platinum
and 100% completion barely move. The blend weight follows the spread of the
history's log-times, so a flat launch-night history (every read the same stale
page) forecasts from the prior, while the final's ~2.5 days of real reads let
the fitted trend dominate. Medians are then repaired to the order the game
enforces: Chapter 1 ≥ Chapter 2 ≥ Chapter 3 ≥ Chapter 4 ≥ final mission, and
platinum and 100% completion at or below every other trophy.

The spread is honest about a launch: sigma = sqrt(0.35² + 0.30² · horizon_days
+ (slope standard error · extrapolation distance)²) on the logit scale. The
0.35 floor is the Exophase refresh-jump risk — the one refresh the kit
records moved every rate at once (638 → 3,868 players tracked, almost every
rate down) — so even a 90-minute horizon gets a real band, where the house
baseline's 0.125-logit band covers nothing (practice loss ~1.51, 90%
coverage ~0). For the final (4.52 days) sigma lands ~0.73–0.9 logit,
narrower than the house baseline's 1.06 because the median now carries the
trend instead of standing still.

Deterministic: pure functions of the case file, no randomness, no clock, no network.

## Validation

There is no local grade for this competition (the server grades every entry),
and the kit ships no practice answers, so no practice loss can be measured
locally. What was checked on the practice cases p00/p01 instead:

| check | result |
|---|---|
| output shape (55 rows, monotone quantiles, 0–100, ≤ 65,536 bytes) | pass, both cases |
| determinism (2 runs byte-identical) | pass, both cases |
| runtime per case | ~0.04 s (limit 8 s) |
| median vs house baseline | see below |
| spread vs house baseline | see below |

On p00/p01 the history is perfectly flat (launch night, one stale page), so
the fit contributes nothing and the prior rules: the median rises above the
last read for story/side trophies (Chapter 1: 1.25% → 1.91% on p00, 1.77% on
p01; final mission: 1.10% → 1.46%; platinum: 0.63% → 0.68%) and stays near
it for grind trophies (silver grind medians 0.63% → 0.69–0.70%), while the
90% band is ~2.1x wider than the house baseline's (median q95/q05 ratio
3.21x vs the baseline's 1.50x at a 90-minute horizon). That width is
deliberate: the practice answers are the first refreshed page, and a refresh
that reprices every trophy cannot be inside a ±11% band. Whether the upward
prior or the refresh's dilution wins on the practice is unknowable from the
kit; the design is aimed at the final, where ~2.5 days of real reads let the
fitted trend — not the prior — set the median.
