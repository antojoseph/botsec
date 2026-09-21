# Assessment of the first Jev pilot

Jev handles the constructed semantic failures much better than the current filters, at a small API cost. This supports further evaluation of both uses, especially a second check before merging findings. It does **not** establish a real-world accuracy improvement: on the 24 original cases/pairs for each task, both methods scored identically.

757 OpenRouter calls completed successfully, with no retries, for **$0.024281754**. The served model was `typesafe/jev-1.13-20260917`. Production code was not changed. The API price is incremental: today's filters make no API calls and run in microseconds, whereas Jev adds approximately 226 ms median / 365 ms p95 per sequential decision. At concurrency four, this run processed 17.22 decisions/second.

| Held-out result | Current filter | Jev |
|---|---:|---:|
| Contradiction, all 90 provisional labels | 34.4% | 95.6% |
| Contradiction, 60 clear labels | 51.7% | 100% |
| Incorrectly downgrade maintained allegation | 4 / 30 | 0 / 30 |
| Detect explicit retraction | 5 / 30 | 30 / 30 |
| Dedup, all 90 provisional labels | 34.4% | 96.7% |
| Dedup, 68 clear labels | 45.6% | 100% |
| Merge distinct defects | 22 / 46 | 0 / 46 |
| Merge despite insufficient evidence | 22 / 22 | 3 / 22 |
| Recover constructed duplicates | 7 / 22 | 22 / 22 |

Clear-label metrics exclude gold unresolved/insufficient cases; model abstentions and failures would still count as wrong on the included cases. The all-label metric includes the baseline's inability to abstain. Neither number measures verified exploitability. Cost per 1,000 decisions was $0.026230 for contradiction and $0.038571 for dedup, averaging development and test inputs. For a hypothetical 24-finding report, this projects to $0.000630 for contradiction review plus $0.010646 to review all 276 pairs; candidate filtering would change both coverage and price.

## Contradiction review

The useful result is semantic scope handling: Jev distinguished rejected quotations, hypothetical fixes, and unrelated safe paths from actual retractions. It also recognized corrections without any of the regex trigger phrases. On these fixtures it preserved all 30 maintained allegations and recognized all 30 retractions. Its held-out decisions were identical across three repeats.

The limit is unresolved reasoning. Jev treated all three original reports we provisionally labeled unresolved as maintained allegations, including two at probability 1.0. Those reports combine questionable intermediate reasoning with continued allegations; their labels themselves need independent adjudication. The task definition—detecting a final retraction versus detecting any internal contradiction—matters here. A high returned probability did not settle that distinction. One constructed unresolved case also stayed labeled maintains. Development accuracy was only 80%, with all six shorter unresolved examples labeled maintains, showing sensitivity to how explicit the uncertainty is.

**Recommendation:** evaluate Jev as an advisory consistency check, preserving the original finding for review. The pilot supports replacing brittle phrase matching as a research direction, but not automatically downgrading a vulnerability's severity. Obtain raw pre-filter reports and independently adjudicate mixed-reasoning cases before changing production behavior.

## Duplicate review

The clearest opportunity is checking a proposed merge from the current location/category heuristic. Within its 51 held-out candidates, the baseline accepted every pair: 7 duplicates, 22 distinct mechanisms, and 22 insufficient descriptions. Jev retained the seven duplicates, rejected all 22 distinct mechanisms, and deferred 19 insufficient pairs. It still accepted three insufficient pairs, at probabilities 0.49, 0.48, and 0.51. Those are unsupported merges, even though their probabilities are low.

Outside the current candidate rule, Jev recovered 15 constructed duplicates whose metadata differed; this is a separate benefit of broader candidate generation, with additional calls and potentially quadratic cost. There were no naturally occurring positive duplicate pairs in the real subset, so this result does not establish natural duplicate recall. All 24 real distinct pairs were already handled correctly by the baseline.

Three held-out pair decisions changed over repeated calls (87/90 cases were fully consistent); they were the insufficient-evidence cases. On six separate development grouping probes, each tested in all six input orders, the baseline merged the distinct defect into the duplicate group every time. Jev's complete-link simulation preserved the correct groups in all orders. These are deliberately simple constructed probes, not independent real reports.

**Recommendation:** prioritize a shadow evaluation of Jev as a veto or review flag before the current dedup merge. Preserve both records on uncertainty or service failure. Do not let an unthresholded winning choice authorize a merge. Fixed threshold curves are available, but picking a production cutoff from this same held-out set would overfit; select it on a separate adjudicated development corpus and validate it again.

## Evidence limits and audit trail

Labels and prompts were frozen before the first live call. This is an assistant-curated challenge set with repeated transformation templates and only two source projects. The test set was intentionally enriched for known heuristic weaknesses, so its aggregate error rates are not expected production rates. Saved real findings had already passed filtering, which hides earlier discarded or merged cases. The two-cluster bootstrap intervals in the report are exploratory, not reliable generalization bounds.

No labels, prompts, or model predictions were changed after observing results. After the run, harness-only fixes made non-JSON authentication errors stop immediately, made missing grouping measurements display as unavailable, and prevented resuming against changed source files or a different budget; none affects this successful run. The original manifest records the code hashes used for inference. Raw sanitized attempt records, frozen fixtures, model IDs, request hashes, costs, and all per-case predictions remain available for inspection.
