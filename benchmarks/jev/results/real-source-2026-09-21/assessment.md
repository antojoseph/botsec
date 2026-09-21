# Real-source Jev comparison — 2026-09-21

**Decision: keep the existing filters. This batch demonstrated no benefit from adding Jev to either decision point.** Jev and the production baselines made identical decisions on all 46 cases. This is a negative result for adoption on this workload, not proof that semantic review can never help.

We generated reports with the documented Sonnet 4.6 configuration from historical Euler, Sentiment and Socket sources, using the existing Haiku classification call. All normalized raw findings were captured before filtering. Jev received the same report fields and unchanged questions used in the earlier pilot, through OpenRouter's Decisions endpoint. Requested model: `typesafe/jev-1.13`; served model: `typesafe/jev-1.13-20260917`.

| Metric | Current filters | Jev |
|---|---:|---:|
| Position decisions | 15 maintains | 15 maintains |
| Duplicate decisions | 31 distinct | 31 distinct |
| Agreement with provisional position labels | 13/15 (86.7%) | 13/15 (86.7%) |
| Agreement with provisional duplicate labels | 30/31 (96.8%) | 30/31 (96.8%) |
| Position latency, median / p95 | 0.040 / 0.165 ms | 243 / 393 ms |
| Pair latency, median / p95 | 0.020 / 0.034 ms | 206 / 327 ms |
| Incremental API cost for these 46 decisions | $0 | $0.002422224 |
| API failures / retries / unknown bills | N/A | 0 / 0 / 0 |

The local baseline incurs compute cost, even though it has no API bill. Its sub-millisecond timings are noisy measurements from this machine. Jev timings include the client/network round trip; they are not server-only inference times. Pair comparisons do not establish whole-report grouping quality or whole-pipeline latency under concurrent execution.

**These percentages are agreement with provisional assistant labels, not independently established accuracy or vulnerability-detection accuracy.** The labels were frozen before this run's Jev requests, and the comparison manifest records their SHA-256. The assistant had seen the earlier pilot, report text and some production filter outcomes; this was not fully blinded or independent. Optional human review packets remain blank. No human votes or exploit executions are claimed.

The label distribution is 13 maintained allegations, two unresolved positions, 30 distinct pairs and one provisional duplicate pair. There are no unambiguous retractions and no insufficient-identity pairs. Consequently, retraction recall cannot be estimated here; duplicate recall has only one provisional positive. Both methods miss that one positive and choose maintains on the two unresolved positions. Neither makes a destructive action on this sample, so this does not validate safety when they actually downgrade or merge findings.

Four position cases and the one duplicate pair have explicit alternative labels recorded before Jev predictions. Exhaustively allowing those alternatives leaves the difference between methods at **zero**. The tie does not depend on agreeing with the assistant's disputed labels. Three project families and shared reports make the 46 cases strongly dependent; the exploratory bootstrap in the JSON is not evidence of population equivalence.

## What the trusted PoCs establish

We accepted the pinned DeFiHackLabs PoCs as requested and retained the three reference files outside generator access. They anchor known incident mechanisms. We did not rerun them, and they do not automatically validate every newly generated claim or determine whether two reports describe the same defect.

| Project | Raw findings | Qualitative coverage of the reference incident |
|---|---:|---|
| Socket | 4 | f001 identifies unrestricted callee/calldata, but its narrative uses faulty rollback/approval reasoning and omits the PoC's concrete zero-amount gateway route and victim `transferFrom` sequence. Root-cause overlap, not a faithful complete exploit report. |
| Sentiment | 5 | None describes the PoC's exit-pool ETH callback followed by borrowing against transient LP valuation. Generic spot-price manipulation reports are not equivalent to read-only reentrancy. |
| Euler | 6 | f001 identifies the missing `checkLiquidity` in `donateToReserves`; f006 depends on the same defect after calling normal debt transfer benign. The proposed profitable/deferred sequence contains health-check inconsistencies, so root identification is not a verified end-to-end exploit. |

Reference evidence: [Socket PoC](reference-pocs/SocketGateway_exp.sol), [Sentiment PoC](reference-pocs/Sentiment_exp.sol), [Euler PoC](reference-pocs/Euler_exp.sol), and their [pinned hashes](reference-pocs/manifest.json). The [historical corpus evidence](../../corpus/README.md) records source/deployment correspondence and limitations. Report-to-source references and reasoning are retained in [provisional labels](review/provisional-labels.json).

This is why human review was not required to start this comparison. The exploit references supply evidence about known bugs; report position and duplicate identity are separate semantic judgments. We used explicitly provisional judgments for those, with unresolved labels where warranted. Independent review would strengthen those labels, but is optional for this exploratory batch.

All 15 reports survive the captured anti-slop, contradiction and dedup stages. Jev likewise proposes no downgrade or merge. The larger observed opportunity is generation quality: missing Sentiment's known mechanism and including questionable attack narratives. Neither of the two Jev classification tasks can discover an omitted issue or establish exploitability.

## Collection, billing and provenance

The approved generation cap was $15 across these three projects, plus at most $1 for Jev comparisons. Actual generation billing was **$2.09373585**, including Haiku classification, the failed original Euler attempt and its successful retry. Jev added **$0.002422224**, for **$2.096158074 total**. Every forwarded generation and Jev request has known billing from the API response or retained generation lookup; this is provider-reported cost rather than an account statement reconciliation.

Socket and Sentiment completed on their first attempt. The original gateway failed to settle most available response `usage.cost` values and accumulated $14.78410995 in conservative reservations despite only $0.95128160 in actual charges. This stopped the first Euler run. We retained that attempt and its original ledger, reconciled all returned costs, fixed the gateway, and retried only Euler in a fresh source workspace with a $13.50 cap. The retry cost $1.14245425. No completed report was discarded or replaced based on findings.

The canonical [collection manifest](collection.json) combines attempts; [attempt 1](collection-attempt-1.json), [billing reconciliation](billing-reconciliation.json), [retry manifest](retry-euler/collection.json) and both billing ledgers preserve the original evidence. The retry manifest carries its own preparation paths. Absolute temporary paths are provenance records, not prerequisites for replay: the preparer reconstructs inputs from retained compiler bundles.

Prepared workspaces contained only selected historical Solidity and generated Foundry configuration, with extra compilation units in `context/`. They held 56 Socket, 109 Sentiment and 47 Euler source files, including duplicated dependencies in separate units. Primary units supply the AST; context units are readable but excluded from that primary AST build. This is scoped analysis, not whole-protocol coverage. The model was limited to read tools in those workspaces; exploit scripts, postmortems, labels and corpus manifests were outside access. Public contract names/comments remain visible, so training-data memorization cannot be excluded. The tool boundary is not an OS sandbox.

The generator implementation used for each attempt is retained under `implementation/` and `retry-euler/implementation/`, with hashes and the base commit. The final source includes subsequent formatting/default-path cleanup and scoring/documentation additions; those did not change the captured findings. Raw output, normalization, full synthesis stage inputs/outputs, prompt/schema/configuration, observed model IDs and source hashes are retained. Artifact hashes are listed in `artifacts.sha256.json`. `FINDINGS.md` and credentials are excluded.

## Reproduction and remaining scope

See the [collection instructions](../../collection/README.md). Recompute this result without API calls:

```sh
node benchmarks/jev/collection/score-provisional.mjs \
  --cases benchmarks/jev/results/real-source-2026-09-21/review/cases.json \
  --labels benchmarks/jev/results/real-source-2026-09-21/review/provisional-labels.json \
  --shadow benchmarks/jev/results/real-source-2026-09-21/shadow \
  --out /tmp/jev-provisional-scores.json
```

Use a new output path; evidence files are never overwritten. [Machine-readable scores](provisional-scores.json) include confusion matrices, support counts, per-project results, exploratory clustered intervals and label sensitivity. The [shadow summary](shadow/summary.json) separately reports unlabeled decisions, timing and cost.

This completes the approved initial three-project batch. The expansion plan names 14 candidates in 12 conservative families, but only these three projects have been collected. The other eleven require source matching and generation; naming them is not validation. Further adoption evidence would need naturally occurring duplicate/retraction cases, ordinary production projects, a frozen unseen family split, grouping/workflow evaluation and comparison against a simple local filter repair. Spending the remaining budget simply to repeat these same easy-negative comparisons is not justified by this result.

Validation: application build and 27 tests passed, including raw capture before mutation/removal, parse-failure distinction, source tool boundaries, billing settlement, review completeness, optional independent adjudication and rejection of changed/late provisional labels. No production Jev integration was added.
