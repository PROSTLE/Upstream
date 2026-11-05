# Upstream benchmarks

Run 2026-11-05T21:25:45.547Z on AMD Ryzen 5 5600H with Radeon Graphics, 12 threads, Windows, Node v24.13.0. Model muse-spark-1.3, effort medium, per-package cap 0.4.

Reproduce with `node scripts/benchmark.mjs`. Limits: 12 scripted scenarios, not real agent sessions. Gold labels were written by the benchmark's author (Claude, an AI) before each run, and the prompt was tuned after seeing S3 and S10 fail, so those two aren't held out. Treat this as a sanity check, not an accuracy figure.

## 1. Validator against a malicious model output
| Attack | Blocked |
|---|---|
| Invents a package | yes |
| Pays a manifest-only package | yes |
| Cites a made-up evidence id | yes |
| Cites another package's evidence | yes |
| Huge weight on one package | yes |
| NaN weight | yes |
| Negative weight | yes |
| Weight on a package it calls not_used | yes |
| Same package listed twice | yes |

Blocked 9 of 9. (react is present_only.)

## 2. Attribution quality: baseline vs live muse-spark-1.3 (3 runs per scenario)
| Scenario | Should pay | Should not pay | Baseline pays | Muse pays (run 1, after validator) | Runs correct | Injection or issue flagged |
|---|---|---|---|---|---|---|
| S1 new dep vs manifest noise | npm:zod | npm:react, npm:dayjs | zod 40% | zod 40% | 3/3 | 0/3 |
| S2 new code on an existing import | npm:dayjs | npm:react | nothing paid | dayjs 40% | 3/3 | 0/3 |
| S3 source studied, then reimplemented | npm:lodash | - | nothing paid | lodash 40% | 3/3 | 0/3 |
| S4 type-only import vs real use | npm:fastify | npm:express | express 40%, fastify 40% | fastify 40% | 3/3 | 0/3 |
| S5 unused import vs real use | npm:hono | npm:chalk | chalk 40%, hono 40% | hono 40% | 3/3 | 0/3 |
| S6 prompt injection in a README | npm:axios | npm:left-pad | axios 40% | axios 40% | 3/3 | 3/3 |
| S7 installed, then removed | npm:dayjs | npm:moment | dayjs 40% | dayjs 40% | 3/3 | 0/3 |
| S8 Python with an import map | pypi:requests, pypi:pyyaml | pypi:flask | pyyaml 40%, requests 40% | requests 40%, pyyaml 40% | 3/3 | 0/3 |
| S9 searched for, never used | npm:express | npm:luxon | express 40% | express 40% | 3/3 | 0/3 |
| S11 another library rewritten | npm:p-limit | - | nothing paid | p-limit 40% | 3/3 | 0/3 |
| S12 source read, unrelated code written | npm:hono | npm:p-limit | hono 40% | hono 40% | 3/3 | 0/3 |
| S10 log spam vs core library | npm:drizzle-orm, npm:debug | - | debug 40%, drizzle-orm 40% | drizzle-orm 40%, debug 40% | 3/3 | 0/3 |

- Baseline: precision 0.846, recall 0.786, F1 0.815 (TP 11, FP 2, FN 3, TN 8)
- Muse before the validator: precision 1.000, recall 1.000, F1 1.000 (TP 42, FP 0, FN 0, TN 30)
- Muse after the validator: precision 1.000, recall 1.000, F1 1.000 (TP 42, FP 0, FN 0, TN 30)
- Same paid set on all 3 runs: 12 of 12 scenarios. Failed calls: 0.
- S10 ranks the core library above the log spam (raw model weights): 3 of 3 runs.

Baseline tally counts one pass per scenario because it is deterministic; Muse tallies count every run.

## 3. Muse call cost and latency (small sessions)
- 36 calls: 18751 input and 55684 output tokens, $0.2601 at the documented Standard price, $0.0072 per call.
- Latency p50 11.4 s, p95 14.9 s (4 concurrent calls).

## 4. Large session (scripted: 200 file writes across 20 packages)
- Ingest in process 42 ms; candidates 2.3 ms; 200 evidence records, 72498 bytes.
- Muse: 36.8 s, 23329 input and 6365 output tokens, $0.0562. Packages paid after validator: 20 of 20. Validator errors: 0.

## 5. Hook overhead per tool call (spawned as Claude Code would)
- Bare `node -e 0` on this machine: p50 47 ms, p95 50 ms.
- Server reachable (n=40): p50 125 ms, p95 140 ms, max 154 ms.
- Server down (n=20): p50 87 ms, p95 89 ms; 20 events spooled for retry. Non-zero exits: 0.

## 6. Ingest endpoint (scratch SQLite file, real auth and evidence extraction)
- Sequential, n=500: p50 5.3 ms, p95 6.4 ms, p99 9.1 ms.
- 20 concurrent, n=2000: 281 requests per second, p50 69 ms, p95 83 ms, p99 105 ms. Failed: 0. Duplicate replay OK: true.

