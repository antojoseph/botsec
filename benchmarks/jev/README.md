# Jev filter benchmark

Completed real-source batch: [results and decision](results/real-source-2026-09-21/assessment.md). Jev and the current filters made identical decisions on 46 cases from 15 raw findings; no adoption benefit was demonstrated.

Completed pilot: [assessment and recommendation](results/pilot-2026-09-21/assessment.md), [full metrics](results/pilot-2026-09-21/report.md).

The [decision record and stronger-validation requirements](../../docs/decisions/2026-09-21-jev-evaluation.md) explain why this experiment was run, what the evidence supports, and what is still needed before adoption. The completed pilot is retained under `results/`; disposable reruns under `runs/` are ignored by Git.

The [historical-source collection](corpus/README.md) preserves pinned public-repository snapshots for Euler, Sentiment, and Socket, with deployment-match evidence and explicit qualifications. The [real-source collection tools](collection/README.md) capture findings before filtering and prepare blinded review packets. Unlabeled comparisons report disagreements and costs, not accuracy.

This offline-corpus pilot compares the actual production self-contradiction and deduplication filters with Jev via OpenRouter's Decisions endpoint. It does not change production filtering or rerun threat generation.

```sh
npm test
npm run benchmark:jev -- --offline
# Set OPENROUTER_API_KEY securely in your shell, then:
npm run benchmark:jev -- --out benchmarks/jev/runs/my-run
npm run benchmark:jev -- --report-only --out benchmarks/jev/runs/my-run
```

Default API budget: $1. Each concurrent attempt reserves the price of the full 32K input window; known usage settles the reservation, unknown billing retains it. Up to two retries are allowed for transient failures. Authentication/billing failures stop execution. Credentials and arbitrary server error text are never logged. Logs contain finding-derived decisions, so treat the corpus and run directory with the same access controls as the input reports.

There are 120 cases per task (30 development, 90 test), three repeats per case, one smoke request, and 36 ordered-pair grouping probes: 757 requests before retries. First repeat runs sequentially; subsequent repeats run at concurrency four. Primary accuracy uses the first repeat only. Six constructed grouping probes use all six finding permutations; Jev's grouping simulation uses complete-link pair agreement rather than transitive merging. Every pair ordering is queried once and reused across permutations.

`fixtures/sources.json` snapshots 19 Damn Vulnerable DeFi and five inflation-vault findings from the v0.2.1 release evaluation. These are post-filter reports, not raw generation. `fixtures/cases.json` contains frozen labels, rationales, provenance, splits, and inputs. `build-fixtures.mjs` documents their construction; do not regenerate or relabel after viewing held-out predictions. If a label is later independently corrected, version the dataset and rerun/report both versions.

The real contradiction cases assess the report's stated conclusion, not Solidity exploitability. The real duplicate pairs are distinct original findings; positive duplicates come from constructed variants. Variants use repeated templates, not 240 independent security judgments. Development findings are separately authored; all real-source variants are test-only. Real pairs connect each project's findings, so uncertainty resamples only two source-project clusters. Those intervals are exploratory and cannot establish generalization.

The baseline is evaluated on cloned original finding objects. Contradiction decision detection normalizes severity/confidence to avoid a saturated Low/low state hiding a downgrade; actual original-field effects are also recorded. Both methods receive the same description/attackScenario evidence for contradiction; dedup Jev receives title, description, attackScenario, category, and locations, whereas the existing filter only uses category and locations. No label, rationale, source-project identifier, or gold grouping is sent to Jev.

Reports include three-class accuracy and fixed-three-class macro-F1, clear-label accuracy, per-class precision/recall, confusion matrices, harmful false actions, uncertain-case actions, abstention/coverage, multiclass Brier score, probability reliability bins, fixed-threshold risk/coverage, paired differences, repeat consistency, costs and timing. Baselines cannot emit an uncertain label; clear-label scores expose that capability difference. Probability thresholds use returned choice probability, not Jev's separate confidence value. Missing probabilities are not fabricated.

`predictions.jsonl` has one result per job; `attempts.jsonl` has sanitized API answers and billing for every attempt, including retries. `manifest.json` freezes model, prompts, corpus hash and source hashes. `groups.json` records grouping outcomes. Failed decisions count as incorrect in completed runs. Resume uses completed job IDs and preserves billed attempts; a changed corpus/prompt/model requires a new directory. A resolved model version changing mid-run stops the run. For interrupted runs, only a later completed run supports the full-corpus headline metrics.

Pricing and schema sources: [OpenRouter Jev](https://openrouter.ai/typesafe/jev-1.13), [OpenAPI](https://openrouter.ai/openapi.json). The endpoint is `/api/alpha/decisions`, not chat completions. The model alias used is `typesafe/jev-1.13`; the returned dated model is recorded. No production latency or whole-pipeline savings are inferred from this decision-only benchmark.
