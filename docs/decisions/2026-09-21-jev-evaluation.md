# Jev evaluation: rationale, evidence, and next validation

Date: 2026-09-21  
Status: pilot completed; production adoption deferred  
Decision: retain the benchmark and its evidence, prioritize further evaluation of duplicate-merge review, and keep contradiction review advisory.

## Why we evaluated Jev

Two current synthesis filters make semantic decisions using surface features:

- Self-contradiction uses exonerating phrases. It can downgrade a maintained allegation containing a rejected quotation or negation, and miss a retraction expressed without those phrases.
- Deduplication merges findings when their categories match and affected-code overlap exceeds 50%. Distinct defects can occur at the same location; duplicate reports can use different location notation or categories.

Jev supplies structured classification with probabilities. We tested whether that helps at these two decision points. We did not test Jev as a vulnerability discoverer, severity oracle, or replacement for verification.

## Evidence retained

The [pilot assessment](../../benchmarks/jev/results/pilot-2026-09-21/assessment.md) contains recommendations and failure analysis. The [full report](../../benchmarks/jev/results/pilot-2026-09-21/report.md) contains the metric tables. The [benchmark instructions](../../benchmarks/jev/README.md) explain reproduction and dataset limitations.

The repository also retains the frozen source snapshots and labeled cases, construction script, actual baseline adapters, request prompts, source and dataset hashes, model identity, sanitized predictions and per-attempt billing, grouping probes, and machine-readable summaries. No API credential is part of this record. `FINDINGS.md` remains excluded from version control.

| Pilot observation | Result | What it supports |
|---|---|---|
| Contradiction label accuracy, 90 held-out cases | Current 34.4%; Jev 95.6% | Better handling of the constructed semantic cases |
| Dedup label accuracy, 90 held-out pairs | Current 34.4%; Jev 96.7% | Better separation of constructed duplicates and distinct mechanisms |
| Known maintained allegations incorrectly downgraded | Current 4/30; Jev 0/30 | A reason to investigate semantic review |
| Known distinct defects merged | Current 22/46; Jev 0/46 | A reason to check proposed merges before accepting them |
| Pairs merged despite insufficient information | Current 22/22; Jev 3/22 | Winning Jev choice alone is not sufficient to authorize merging |
| Original saved cases only | Contradiction tied at 87.5%; dedup tied at 100% | No demonstrated improvement on the available real subset |
| 757 successful API calls | $0.024281754; no retries or failures | Low incremental decision cost for these input sizes |
| Sequential decision latency | Median 226 ms; p95 365 ms | Material network latency compared with local filters |

The headline accuracy includes an uncertainty class that the baseline cannot emit. The report also gives clear-label accuracy and coverage. Labels were provisional assistant judgments, not independent security adjudication. Repeated templates, only two source projects, and post-filter source reports limit the claims. The real dedup subset contains no positive duplicate pairs. No production behavior has been changed on the strength of these results.

## What stronger validation needs

### 1. Raw findings from different projects

Capture findings immediately before synthesis filtering, plus each filter's proposed action and final output. Retain the project commit, upstream model and prompt/config versions, source references, and run identifier. Include cases the current pipeline would merge or downgrade; collecting only final reports would repeat the pilot's selection bias.

Initial collection target: 10–15 independently developed codebases and 300–500 raw findings. Include several contract families, ordinary production code, and known vulnerable targets. These are collection targets, not a statistical power guarantee. Forks, revisions, repeated runs, and paraphrases of a project stay in the same split and uncertainty cluster.

Use both a consecutive, unselected report sample to measure normal workload performance and a separately reported challenge sample enriched for natural retractions, genuinely uncertain findings, real duplicates, and distinct defects at shared locations. Do not inflate duplicate accuracy with thousands of easy unrelated pairs. Collect enough natural positive cases to assess recall; if they are rare, expand collection rather than replacing them with synthetic positives.

### 2. Independent labels and a precise rubric

Two Solidity/security reviewers label cases independently without seeing either method's decision. Resolve disagreements explicitly, using a third reviewer where necessary; retain original votes, final labels, evidence, and unresolved disputes. Another call to the evaluated model is not independent ground truth.

For contradiction, the primary question is whether the report maintains its allegation, retracts it, or leaves its final position unresolved. Record internal reasoning errors separately: a report can contain a bad intermediate argument while still maintaining an allegation. Revisit the pilot's three disputed original labels in a new dataset version, preserving the original pilot intact.

For deduplication, reviewers identify the defective behavior, affected implementation, repair, and group membership. Sharing an exploit chain, location, or category is insufficient. Distinguish a reporting-identity judgment from proof that the described vulnerability is real. Where source code is needed to adjudicate, preserve that evidence and separately document what input each evaluated method receives.

### 3. An untouched project-level test set

Assign roughly 60% of project families to development and 40% to held-out evaluation before prompt or threshold tuning. Keep this pilot as development/history for future work; it is no longer an unseen test set. Freeze the new rubric, prompt, candidate generation, uncertainty policy, and probability thresholds before opening the new test results.

Compare the existing filters, a straightforward deterministic repair of their known failure modes, and Jev. This tests whether the API dependency adds value over a cheap local improvement. Measure review of the same candidate pairs separately from broader candidate discovery. Evaluate complete report grouping and order sensitivity, not only isolated pairs.

### 4. Workflow impact and failure behavior

Run in shadow mode first: record recommendations while preserving all original findings and normal user-visible output. Measure distinct confirmed issues retained, incorrect suppressions/merges, duplicate workload, reviewer time, abstention rate, cost per real report, and added p50/p95 pipeline latency. Compare reviewer time with blinded, counterbalanced report assignments to reduce learning effects.

Exercise missing probabilities, timeouts, rate limits, model-version changes, and service failures. An experimental review layer must preserve findings and mark review unavailable when it cannot decide. Confidence thresholds must be validated empirically; high model confidence is not proof of correctness.

Before collecting the final test results, agree on the acceptable harmful-action rate, minimum useful coverage, and cost/latency budget. Report uncertainty over independent projects and the number of actual merge/downgrade decisions. Zero harmful errors on a small sample is not sufficient evidence for unrestricted automation.

## Adoption decisions this work can support

- **Duplicate review:** advance only if it reduces harmful merges on independently labeled held-out projects without an unacceptable increase in missed duplicates or reviewer work. Prefer a veto/review flag initially; retain separate source records and merge provenance.
- **Contradiction review:** advance as an advisory consistency check if it improves reviewer decisions. A finding's textual retraction is not, by itself, independent evidence that its vulnerability severity should change. Automatic severity changes require their own validation and explicit policy.
- **No advantage over a local repair:** keep the simpler implementation. The sunk cost of this pilot is not a reason to adopt Jev.

## Inputs needed to run the next study

The key missing inputs are representative raw reports or project selections, two independent reviewers, and an agreed budget for generating any missing reports. Existing OpenRouter access is sufficient for further Jev calls. Corpus collection and human adjudication are the substantial work; the pilot's low Jev bill does not estimate the cost of generating and reviewing a larger corpus.

This record documents why the experiment was run and why further evaluation is justified. It does not claim that production Jev adoption has already occurred. Append future decisions with their dataset/run references and keep this pilot unchanged, including negative and inconclusive results.
