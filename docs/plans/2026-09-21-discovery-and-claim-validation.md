# Next steps: improve discovery and validate attack claims

Date: 2026-09-21

The objective is to find the actual vulnerable mechanism and produce an attack narrative that survives source-level scrutiny. Keep Jev out of production: the real-source comparison showed no improvement in the two filter decisions. Improving discovery and validating claims are the priorities.

## Current state

- The baseline is preserved: 15 raw findings from Socket, Sentiment and Euler, plus source snapshots, trusted PoCs and billing. Sentiment's specific read-only reentrancy mechanism was missed; Socket and Euler reports identified relevant root causes but contained flawed attack reasoning.
- Implementation commit `8081e11` adds a source inventory, earlier cross-contract exploration, structured attack assessments, exact source-quote checks and retained rejected leads. All 31 tests pass.
- A fresh Sonnet run on those same three projects is in progress. This is a development regression check: the failures informed the changes, so it is not a held-out accuracy test.
- The original $15 generation authorization remains the aggregate limit. Prior generation cost $2.09373585; this run has a $12 cap, keeping the combined maximum at $14.09373585. No new Jev calls are planned.
- Trusted DeFiHackLabs PoCs remain outside discovery inputs. We are not rerunning those PoCs or waiting for human reviewers.

## 1. Finish the current comparison

Preserve every consecutive attempt, including failures. Compare the original and revised generator on identical historical source scopes and the same model configuration. Do not retry merely because a report is disappointing.

Assess these specific mechanisms against the trusted PoCs and source:

| Project | What a useful report must explain |
|---|---|
| Socket | Gateway delegatecall context, caller-controlled token calldata, victim allowance, zero-amount balance checks, and why the entire transferFrom transaction commits. |
| Sentiment | Pool-share burn and Vault balance-update ordering, the ETH callback, transient LP valuation, and the consumer's borrowing operation during that callback. |
| Euler | Collateral reduction without a solvency check, actual creation of an insolvent position, and a liquidation path consistent with deferred checks and health requirements. |

Record full, partial, missed or unresolved mechanism coverage; raw/final findings; rejected leads; source-citation failures; reasoning defects; actual cost and latency. Fewer findings alone is not success. Preserve original reports rather than rewriting them to match the reference.

**Deliverable:** a before/after assessment with file-level evidence, billing and all raw outputs. The evaluation rules are frozen in [protocol.json](../../benchmarks/discovery/results/source-claims-2026-09-21/protocol.json).

## 2. Review the attack reasoning, beyond citation matching

For every retained finding, check:

1. **Reachability:** Can an unprivileged attacker satisfy the actual deployment, token, allowance and registration prerequisites?
2. **Execution context:** Which contract owns storage and tokens, which address is the spender, and how do CALL and DELEGATECALL change those facts?
3. **Guards and rollback:** Do locks, authorization or final/deferred checks block the sequence? If the outer transaction reverts, do not claim that an inner transfer or approval survives.
4. **Transient state:** What has changed at the callback, what has not, which reader observes the mismatch, and which operation commits a harmful decision from it?
5. **Arithmetic and economics:** Does the formula actually move as claimed? Account for attacker funding, repayments, fees and remaining assets; distinguish net profit, bad debt and griefing.

Exact quotes establish that the cited text exists. They do not prove the interpretation, reachability or exploitability. Keep unresolved assumptions explicit; preserve rejected candidates with counterevidence. Do not turn `citations-checked` into an “exploit verified” badge.

**Deliverable:** an evidence-backed disposition for each new finding, with unresolved cases and known limitations retained.

## 3. Fix only failures the new run demonstrates

If the model still misses a mechanism, inspect the missing source reads and boundary traversal before adding more generic prompt text. If evidence is present but reasoning is wrong, target that reasoning failure. If citation checks fail, distinguish wrong paths/ranges from an unsupported claim.

Preserve counterexamples and add focused regression tests for deterministic behavior. Do not hardcode the three incident names, addresses or exploit sequences into production logic. Re-run only the affected check when a change warrants it, retaining previous results and accounting for the remaining budget.

**Success criterion:** better supported mechanism coverage without hiding uncertainty, silently dropping difficult findings or claiming executed verification. A single improved run is promising evidence, not a general accuracy claim.

## 4. Broaden to unseen project families

After the development changes are stable, freeze the prompt, evidence format and assessment rubric. Use the existing [candidate plan](../../benchmarks/jev/collection/expansion-plan.json) to select unrelated vulnerable projects and ordinary production code. Confirm historical source correspondence before generation and keep forks/related implementations together.

Do not label ordinary code safe merely because no exploit is known. Score naturally occurring failures and unresolved findings separately. The eleven additional candidates are a backlog, not completed data, and the three development incidents cannot serve as an unseen test set.

**Deliverable:** a family-level held-out evaluation of discovery and claim quality, with cost and latency. Broader paid generation needs a separate budget decision before starting; it is outside the currently approved three-project batch.

## 5. Add executable checks where they resolve a real uncertainty

For claims not settled by trusted reference evidence, identify a concrete falsifiable assertion: unauthorized value transfer, committed insolvency, callback-time valuation, or positive net attacker proceeds. Build the smallest reproduction or property check that tests it, using the correct source version and deployment assumptions.

Where feasible, run the same assertion against a narrowly repaired version as a control. A build failure, RPC failure, empty symbolic search or unreachable test is not a security verdict. Preserve commands, environment, assertions and outcomes. Do not rerun trusted incident PoCs merely as a process requirement.

**Deliverable:** executable evidence for specific claims, or a precise statement of why they remain unresolved. This is separate from the currently running source-only discovery experiment.

## 6. Ship with the evidence and limitations

Run the relevant tests, inspect report compatibility and check that merged findings retain their original assessments. Preserve the benchmark, source references, rejected leads and decision rationale. Push the reviewed changes to main; continue excluding `FINDINGS.md` and credentials.

Recommend wider use only when the evidence shows useful gains. Keep source inspection, assistant judgment, trusted reference evidence and executed verification distinguishable in the report. Human review can strengthen ambiguous judgments later; it is not a gate for this exploratory work.
