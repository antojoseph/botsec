# Discovery and attack-claim validation

This study evaluates the generator against incident mechanisms and source evidence. It does not call Jev. The earlier real-source filter comparison showed identical decisions from Jev and the existing filters, while exposing weaknesses in the generated attack narratives.

The [next-steps plan](../../docs/plans/2026-09-21-discovery-and-claim-validation.md) records the work sequence and budget boundaries. The current development experiment is [source-claims-2026-09-21](results/source-claims-2026-09-21/), with a [pre-generation protocol](results/source-claims-2026-09-21/protocol.json) and exact implementation commit in its run provenance.

The run is complete: the final reports missed all three reference mechanisms, versus two partial matches in the baseline. It cost $4.75173630 and revealed both reasoning errors and loss of findings during output recovery. The [assessment](results/source-claims-2026-09-21/assessment.md) preserves the negative result. The experimental prompt is disabled by default; use the flag below only for deliberate research runs. Commit `8081e11`, used by this saved run, enabled the experiment implicitly; subsequent code requires the explicit flag.

Generation uses the existing historical source preparer and budgeted Sonnet collector:

```sh
npm run build
node benchmarks/jev/collection/prepare.mjs
# Use the printed preparation.json path and an explicitly allocated budget.
# OPENROUTER_API_KEY must be in the environment; Foundry must be on PATH.
node benchmarks/jev/collection/collect.mjs --preparation /path/to/preparation.json --out /path/to/new-collection --budget 4 --experimental-claims
```

The sources and trusted reference PoCs are pinned in the historical corpus. Discovery receives only the prepared Solidity and generated configuration. The evaluator sees the reference evidence separately. Changes motivated by these incidents are development changes; they cannot be evaluated as if these projects were unseen.

Experimental reports request structured `claimAssessment` reasoning: execution context, cited attack steps, four explicit checks and missing evidence. `claimReview` mechanically verifies source paths, line ranges, exact quotes and file hashes. Quotes are checked before synthesis; every original finding is preserved with `--capture-raw`. Existing filters may still remove or merge findings, and those transitions remain captured. Merged findings retain constituent assessments and require another review of the combined claim. Default generation retains the existing prompt and marks absent assessments `not-assessed`.

A successful quote check is not proof of the exploit. Even a correctly quoted function can be interpreted incorrectly, or be unreachable under the actual deployment. Generator-assigned conclusions and discarded-candidate reasons are assistant judgments; they need source/PoC assessment. `dismissedCandidates` are preserved so narrowing the final report cannot hide what was rejected. Their counterevidence receives the same mechanical citation checks. The initial experiment predates that dismissal-check addition; its original outputs remain unchanged and can be checked afterward with `review-dismissals.mjs`.

After collection finishes, create a new mechanical summary:

```sh
node benchmarks/discovery/summarize.mjs --collection /path/to/collection --out /path/to/new-summary.json
```

This summary counts completed/failed runs, raw/final findings, dismissed candidates, generator conclusions, citation checks, actual billing and generation time. It deliberately does not turn keyword matching or citation counts into vulnerability accuracy. The separate reference assessment uses the frozen mechanism rubric and records evidence and limitations for each match or miss.

Trusted DeFiHackLabs PoCs are not reexecuted as a prerequisite. No local exploit result is inferred from their presence. Later executable checks should target specific unresolved claims and preserve successful, failing and inconclusive outcomes. Ordinary projects are not presumed safe, and a future held-out study must use independent project families after the prompt and rubric are frozen.

To check dismissal citations from an earlier captured collection without changing its outputs:

```sh
node benchmarks/discovery/review-dismissals.mjs --collection /path/to/collection --out /path/to/dismissal-review.json
# If original temporary source directories are gone, first run the preparer again
# and add --preparation /path/to/new/preparation.json. Source hashes must match.
```
