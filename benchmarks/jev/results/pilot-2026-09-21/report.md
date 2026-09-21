# Jev versus current filters: controlled pilot

Run: 2026-09-21T05:28:06.065Z. Model: typesafe/jev-1.13-20260917. Complete successful main run: true.

Labels and prompts were frozen before inference. Accuracy is agreement with provisional assistant-curated semantic labels, not independently validated vulnerability accuracy. The test set contains 24 real cases/pairs and 66 constructed cases per task. Development contains 30 separate constructed cases per task. Main scores use the first repeat; repeats are not counted as extra independent examples.

## Quality

| Task / slice | N | Baseline accuracy | Jev accuracy | Baseline macro-F1 | Jev macro-F1 | Harmful errors baseline / Jev | Jev abstentions |
|---|---:|---:|---:|---:|---:|---:|---:|
| contradiction / dev | 30 | 60.0% | 80.0% | 0.44 | 0.60 | 0 / 0 | 0 |
| contradiction / test | 90 | 34.4% | 95.6% | 0.24 | 0.96 | 4 / 0 | 26 |
| contradiction / real | 24 | 87.5% | 87.5% | 0.31 | 0.31 | 0 / 0 | 0 |
| contradiction / constructed | 66 | 15.2% | 98.5% | 0.14 | 0.98 | 4 / 0 | 26 |
| dedup / dev | 30 | 20.0% | 96.7% | 0.11 | 0.96 | 12 / 0 | 5 |
| dedup / test | 90 | 34.4% | 96.7% | 0.25 | 0.95 | 22 / 0 | 19 |
| dedup / real | 24 | 100.0% | 100.0% | 0.33 | 0.33 | 0 / 0 | 0 |
| dedup / constructed | 66 | 10.6% | 95.5% | 0.06 | 0.95 | 22 / 0 | 19 |
| dedup / existingCandidates | 51 | 13.7% | 94.1% | 0.08 | 0.92 | 22 / 0 | 19 |
| dedup / outsideCandidates | 39 | 61.5% | 100.0% | 0.25 | 0.67 | 0 / 0 | 0 |

The baseline has two outputs and no abstention. Three-class accuracy therefore includes a capability difference. Clear-label accuracy below excludes gold unresolved/insufficient cases, still counting Jev abstentions and errors as incorrect. Harmful-error counts use known maintained/distinct cases; unsafe actions on uncertain cases are reported separately.

| Task | Clear-label N | Baseline accuracy | Jev accuracy | Unsafe actions on uncertain baseline / Jev | Jev action coverage | Jev selective accuracy | Brier score |
|---|---:|---:|---:|---:|---:|---:|---:|
| contradiction | 60 | 51.7% | 100.0% | 0 / 0 | 71.1% | 93.8% | 0.07 |
| dedup | 68 | 45.6% | 100.0% | 22 / 3 | 78.9% | 95.8% | 0.09 |

## Cost and performance

Billed total: **$0.024282**, including smoke/group probes/retries. Budget accounting: $0.024282. Unknown-billing attempts: 0. Input/output tokens: 578137/32501. Attempts: 757; retries: 0; failed attempts: 0.

| Task | Measured API cost / 1,000 decisions |
|---|---:|
| contradiction | $0.026230 |
| dedup | $0.038571 |

| Concurrency | Requests | Median latency ms | p95 latency ms | Decisions/sec |
|---|---:|---:|---:|---:|
| 1 | 240 | 226.42 | 365.49 | 4.04 |
| 4 | 480 | 215.71 | 322.41 | 17.22 |

Baseline external API cost is $0. Local filter timings are in summary.json; sub-millisecond measurements include timer/runtime noise. Jev timings include network and retry waits. Throughput is not whole-pipeline speedup.

## Repetition and uncertainty

- contradiction: 90/90 held-out cases agreed across all three successful repeats. Paired accuracy difference: 61.1%; exploratory cluster-bootstrap 95% interval 53.3% to 62.7% (2 source clusters).
- dedup: 87/90 held-out cases agreed across all three successful repeats. Paired accuracy difference: 62.2%; exploratory cluster-bootstrap 95% interval 50.0% to 64.5% (2 source clusters).

**Only two source projects are available. These intervals cannot establish cross-project generalization.** Constructed variants share templates and source material; their count overstates independent evidence. Real reports are post-filter survivors, and the real duplicate pairs are all labeled distinct. This pilot cannot estimate natural duplicate recall.

Probability calibration, fixed-threshold risk/coverage curves, all confusion matrices, and grouping-order results are in summary.json. Thresholds are descriptive, not tuned on the held-out cases. Grouping uses conservative complete-link Jev pair decisions and is a simulation, not a production replacement.

## Disagreements

| Case | Origin | Expected | Baseline | Jev |
|---|---|---|---|---|
| contradiction-064 | constructed | retracts | maintains | retracts |
| contradiction-090 | constructed | retracts | maintains | retracts |
| contradiction-094 | constructed | unresolved | maintains | unresolved |
| contradiction-117 | constructed | unresolved | maintains | unresolved |
| contradiction-107 | constructed | unresolved | maintains | unresolved |
| contradiction-065 | constructed | retracts | maintains | retracts |
| contradiction-108 | constructed | unresolved | maintains | unresolved |
| contradiction-085 | constructed | retracts | maintains | retracts |
| contradiction-077 | constructed | retracts | maintains | retracts |
| contradiction-106 | constructed | unresolved | maintains | unresolved |
| contradiction-079 | constructed | retracts | maintains | retracts |
| contradiction-105 | constructed | unresolved | maintains | unresolved |
| contradiction-067 | constructed | retracts | maintains | retracts |
| contradiction-084 | constructed | retracts | maintains | retracts |
| contradiction-082 | constructed | retracts | maintains | retracts |
| contradiction-116 | constructed | unresolved | maintains | unresolved |
| contradiction-080 | constructed | retracts | maintains | retracts |
| contradiction-109 | constructed | unresolved | maintains | unresolved |
| contradiction-071 | constructed | retracts | maintains | retracts |
| contradiction-104 | constructed | unresolved | maintains | unresolved |
| contradiction-115 | constructed | unresolved | maintains | unresolved |
| contradiction-063 | constructed | maintains | retracts | maintains |
| contradiction-068 | constructed | retracts | maintains | retracts |
| contradiction-095 | constructed | unresolved | maintains | unresolved |
| contradiction-103 | constructed | unresolved | maintains | unresolved |
| contradiction-113 | constructed | unresolved | maintains | unresolved |
| contradiction-092 | constructed | retracts | maintains | retracts |
| contradiction-097 | constructed | unresolved | maintains | unresolved |
| contradiction-070 | constructed | retracts | maintains | retracts |
| contradiction-099 | constructed | unresolved | maintains | unresolved |
| contradiction-060 | constructed | maintains | retracts | maintains |
| contradiction-054 | real | unresolved | maintains | maintains |
| contradiction-120 | constructed | unresolved | maintains | unresolved |
| contradiction-112 | constructed | unresolved | maintains | unresolved |
| contradiction-110 | constructed | unresolved | maintains | unresolved |
| contradiction-057 | constructed | maintains | retracts | maintains |
| contradiction-100 | constructed | unresolved | maintains | unresolved |
| contradiction-074 | constructed | retracts | maintains | retracts |
| contradiction-049 | real | unresolved | maintains | maintains |
| contradiction-102 | constructed | unresolved | maintains | unresolved |
| contradiction-114 | constructed | unresolved | maintains | maintains |
| contradiction-066 | constructed | retracts | maintains | retracts |
| contradiction-096 | constructed | unresolved | maintains | unresolved |
| contradiction-089 | constructed | retracts | maintains | retracts |
| contradiction-056 | constructed | maintains | retracts | maintains |
| contradiction-098 | constructed | unresolved | maintains | unresolved |
| contradiction-086 | constructed | retracts | maintains | retracts |
| contradiction-088 | constructed | retracts | maintains | retracts |
| contradiction-078 | constructed | retracts | maintains | retracts |
| contradiction-101 | constructed | unresolved | maintains | unresolved |
| contradiction-118 | constructed | unresolved | maintains | unresolved |
| contradiction-083 | constructed | retracts | maintains | retracts |
| contradiction-076 | constructed | retracts | maintains | retracts |
| contradiction-072 | constructed | retracts | maintains | retracts |
| contradiction-091 | constructed | retracts | maintains | retracts |
| contradiction-045 | real | unresolved | maintains | maintains |
| contradiction-073 | constructed | retracts | maintains | retracts |
| contradiction-119 | constructed | unresolved | maintains | unresolved |
| contradiction-111 | constructed | unresolved | maintains | unresolved |
| dedup-066 | constructed | insufficient | same | insufficient |
| dedup-102 | constructed | insufficient | same | same |
| dedup-071 | constructed | distinct | same | distinct |
| dedup-110 | constructed | distinct | same | distinct |
| dedup-060 | constructed | insufficient | same | insufficient |
| dedup-059 | constructed | distinct | same | distinct |
| dedup-064 | constructed | same | distinct | same |
| dedup-098 | constructed | distinct | same | distinct |
| dedup-056 | constructed | distinct | same | distinct |
| dedup-067 | constructed | same | distinct | same |
| dedup-095 | constructed | distinct | same | distinct |
| dedup-068 | constructed | distinct | same | distinct |
| dedup-055 | constructed | same | distinct | same |
| dedup-074 | constructed | distinct | same | distinct |
| dedup-107 | constructed | distinct | same | distinct |
| dedup-116 | constructed | distinct | same | distinct |
| dedup-108 | constructed | insufficient | same | insufficient |
| dedup-083 | constructed | distinct | same | distinct |
| dedup-101 | constructed | distinct | same | distinct |
| dedup-063 | constructed | insufficient | same | insufficient |
| dedup-103 | constructed | same | distinct | same |
| dedup-069 | constructed | insufficient | same | insufficient |
| dedup-057 | constructed | insufficient | same | insufficient |
| dedup-075 | constructed | insufficient | same | insufficient |
| dedup-114 | constructed | insufficient | same | insufficient |
| dedup-087 | constructed | insufficient | same | insufficient |
| dedup-094 | constructed | same | distinct | same |
| dedup-084 | constructed | insufficient | same | insufficient |
| dedup-080 | constructed | distinct | same | distinct |
| dedup-073 | constructed | same | distinct | same |
| dedup-112 | constructed | same | distinct | same |
| dedup-085 | constructed | same | distinct | same |
| dedup-093 | constructed | insufficient | same | insufficient |
| dedup-100 | constructed | same | distinct | same |
| dedup-104 | constructed | distinct | same | distinct |
| dedup-113 | constructed | distinct | same | distinct |
| dedup-090 | constructed | insufficient | same | insufficient |
| dedup-111 | constructed | insufficient | same | same |
| dedup-099 | constructed | insufficient | same | insufficient |
| dedup-062 | constructed | distinct | same | distinct |
| dedup-105 | constructed | insufficient | same | insufficient |
| dedup-065 | constructed | distinct | same | distinct |
| dedup-078 | constructed | insufficient | same | insufficient |
| dedup-077 | constructed | distinct | same | distinct |
| dedup-120 | constructed | insufficient | same | same |
| dedup-092 | constructed | distinct | same | distinct |
| dedup-091 | constructed | same | distinct | same |
| dedup-119 | constructed | distinct | same | distinct |
| dedup-081 | constructed | insufficient | same | insufficient |
| dedup-089 | constructed | distinct | same | distinct |
| dedup-072 | constructed | insufficient | same | insufficient |
| dedup-117 | constructed | insufficient | same | insufficient |
| dedup-118 | constructed | same | distinct | same |
| dedup-058 | constructed | same | distinct | same |
| dedup-076 | constructed | same | distinct | same |
| dedup-109 | constructed | same | distinct | same |
| dedup-096 | constructed | insufficient | same | insufficient |
| dedup-082 | constructed | same | distinct | same |
| dedup-086 | constructed | distinct | same | distinct |

## Reproduce

`npm run benchmark:jev -- --out benchmarks/jev/runs/new-run` with OPENROUTER_API_KEY configured. For local-only validation use `--offline`. Resume only into a matching run directory. Rebuild the report using `--report-only --out <existing-run>`. Fixtures, request hashes, prompts, source hashes, sanitized responses, and per-attempt billing provide the audit trail.

Production filters are unchanged. A deployment decision requires inspecting disagreements and independently adjudicating raw findings from additional projects.
