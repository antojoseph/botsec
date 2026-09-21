# Discovery and claim-validation experiment: negative result

The revised prompt and structured claim format did **not** improve the completed reports on these three development incidents. Keep the existing discovery prompt as the default. The experiment is available behind `--experimental-claims`; mechanical source checks remain useful for exposing evidence problems but do not validate attack semantics.

## Reference-mechanism coverage

| Project | Baseline final report | Experimental final report | Main observation |
|---|---|---|---|
| Socket | Partial mechanism | Missed | Rejected the known zero-amount ERC20 allowance-theft path using an ETH-only cash-flow argument. |
| Sentiment | Missed | Missed | Did not trace the exit callback's supply/balance mismatch; retained an attack premise blocked by normal pool construction. |
| Euler | Partial mechanism | Missed | Raised an unresolved donation/solvency lead in a truncated intermediate report, then lost it during output recovery. |

Neither setup delivered a complete, internally consistent reference-mechanism report for any of the three cases under the frozen rubric. The experimental final reports also lost the baseline's two partial matches. This is evidence against adopting this combined change, not a population accuracy estimate or proof that every component is harmful. There was one stochastic run per project, and these incidents informed the changes.

The [baseline assessment](baseline-assessment.json), [Socket assessment](socket-assessment.json), [Sentiment assessment](sentiment-assessment.json) and [Euler assessment](euler-assessment.json) record the specific judgments. Source excerpts, hashes and trusted PoC excerpts are in [reference-evidence.json](reference-evidence.json). Assessment was performed by the primary assistant, not an independent reviewer. The trusted PoCs were excluded from generation and were not reexecuted.

## Cost, delivery and evidence quality

| Metric | Experimental run |
|---|---:|
| Completed parsed reports | 3 / 3 |
| Raw findings / final findings | 6 / 6 |
| Recorded dismissed candidates | 9 |
| Retained-finding citation quotes matching source | 13 / 15 |
| Findings passing all mechanical assessment checks | 2 / 6 |
| Dismissals passing mechanical citation checks | 5 / 9 |
| Billed generation requests | 66 |
| Actual generation cost, including classifier | $4.75173630 |
| Unknown bills | 0 |
| Socket / Sentiment / Euler SDK duration | 7.73 / 11.70 / 27.72 minutes |

The baseline generated 15 findings for $2.09373585. Combined generation spending is **$6.84547215 of the approved $15**, leaving $8.15452785. Prior Jev comparisons cost $0.002422224 under their separate $1 allowance; this experiment made no Jev calls. Total recorded spending across both generation batches and those Jev comparisons is $6.847894374. No further paid generation was used to improve these results.

The [summary](summary.json) records per-project metrics, SDK costs and durations; actual charges come from the [gateway billing ledger](collection/generation-billing.jsonl). These are generation timings, not verification latency. All six parsed findings survived the existing filters, so filtering did not cause the Euler candidate loss.

Output delivery is a material failure. With the collector's 8,192-token output limit, reports repeatedly truncated and recovery reanalysed or shortened them. The [sanitized diagnostics](delivery-diagnostics.json) preserve source-tool requests and report fragments: Socket and Sentiment each have one fragment stopped at the token limit; Euler has seven. At 07:50:54 UTC, Euler's `T-005` conditionally linked minting and donation to insolvency and explicitly asked whether donation enforces a liquidity check. The final report omitted it. This is an unresolved lead lost during recovery, not a proven exploit discovered successfully. Parse success alone therefore overstates delivery quality.

Citation checks exposed two mismatching quotes in retained findings, plus problems in four dismissed candidates. They did not catch Socket's incorrect rejection or Sentiment's unreachable fixed-20-decimal normal-pool premise by themselves. Correct quotations and self-reported check conclusions are insufficient to establish attack validity. The initial run predates dismissal citation checking; [dismissal-reviews.json](dismissal-reviews.json) contains separately preserved post-generation checks against the original source hashes. Original generation artifacts were not rewritten.

## What to change next

1. Fix report delivery first: use bounded per-candidate output, retain completed candidates before requesting more, and reconcile candidate identities through recovery. Test that truncation cannot silently turn a partial report into a complete smaller report. Do not solve this by repeatedly asking for fresh analysis.
2. Make source traversal observable and actionable. The Sentiment transcript never requests the supplied BasePool, PoolBalances or AssetTransfersHandler implementations containing the relevant constraints and callback sequence. Euler even calls the supplied Liquidation implementation missing. An inventory alone did not ensure inspection of the required code.
3. Check rejected claims as carefully as maintained claims. Require guards to be tied to the assets and state they protect: an ETH balance check does not establish safety of ERC20 allowances. Check constructor prerequisites and transaction ordering before accepting an attack narrative.
4. Retest only after a concrete fix, retaining failures and billing. Broader unseen-family generation follows a frozen format/rubric and a separate budget allocation; this result does not justify scaling the current experiment.

The [next-steps plan](../../../../docs/plans/2026-09-21-discovery-and-claim-validation.md) tracks this work. No human-review gate or repeated trusted-PoC execution is needed to act on these concrete failures.

## Reproduction and provenance

The [protocol](protocol.json) was frozen before generation. [run-provenance.json](run-provenance.json) pins implementation commit `8081e110ad878f63e5863cb64ac1a908e005cd42`, where the experimental behavior was enabled implicitly. Later code restores the previous default and requires `--experimental-claims`. The collection retains exact prompts, schemas, source inventories, model configuration, raw output and synthesis transitions. [artifacts.sha256.json](artifacts.sha256.json) hashes retained study files, excluding itself. Regeneration is stochastic and would incur new charges; the retained evidence can be inspected without model calls.
