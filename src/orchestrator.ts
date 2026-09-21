/**
 * Orchestrator — coordinates the three sub-agents via the Claude Agent SDK.
 *
 * Pipeline:
 * 1. Scaffold a temp Foundry project with the target contract
 * 2. Run Explorer + On-Chain agents in parallel (SDK handles this via Task tool)
 * 3. Run Verifier agent with combined findings
 * 4. Stream progress to terminal
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { explorerAgent } from "./agents/explorer.js";
import { onchainAgent, type OnchainOpts } from "./agents/onchain.js";
import { verifierAgent } from "./agents/verifier.js";
import {
  scaffoldFoundryProject,
  HALMOS_ENV,
  FORGE_PROOF_TEST_DIR,
} from "./scaffold/foundry-project.js";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import type { ThreatModel, Threat } from "./threat-model/types.js";
import { runHalmos, summarize, type HalmosRun } from "./verification/halmos-json.js";
import {
  runMutationTesting,
  formatMutationReport,
  cleanBuild,
  type MutationReport,
} from "./mutation/runner.js";

export interface AnalyzeOptions {
  contractPath: string;
  address?: string;
  chainId?: string;
  etherscanApiKey?: string;
  loopBound?: number;
  solverTimeout?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  outputDir?: string;
  threatModelPath?: string;
  verifyOnly?: boolean;
  /** Re-run the generated suite through Halmos JSON and classify vacuity. */
  auditSpec?: boolean;
  /** Run mutation testing to score how much the spec actually proves. */
  mutationTest?: boolean;
  maxMutants?: number;
}

export async function analyze(opts: AnalyzeOptions): Promise<void> {
  // 1. Detect Foundry project or scaffold from .sol file
  const resolvedPath = resolve(opts.contractPath);
  const isFoundryProject = existsSync(join(resolvedPath, "foundry.toml"));
  let projectDir: string;

  if (isFoundryProject) {
    console.log("\n  Using existing Foundry project...");
    projectDir = resolvedPath;
  } else {
    console.log("\n  Setting up Foundry project...");
    projectDir = await scaffoldFoundryProject(opts.contractPath);
  }
  // The verifier writes into .forge-proof/test/, which FOUNDRY_TEST points at.
  // Foundry errors on a non-existent test path, so make sure it is there even
  // when we are using the user's own project untouched.
  mkdirSync(join(projectDir, FORGE_PROOF_TEST_DIR), { recursive: true });

  console.log(`  Working directory: ${projectDir}\n`);

  // 2. Load threat model if provided
  let threatModel: ThreatModel | undefined;
  if (opts.threatModelPath) {
    try {
      const raw = readFileSync(resolve(opts.threatModelPath), "utf-8");
      threatModel = JSON.parse(raw) as ThreatModel;
      console.log(
        `  Threat model loaded: ${threatModel.threats.length} threats from ${opts.threatModelPath}`
      );
    } catch (err: any) {
      throw new Error(
        `Failed to load threat model from ${opts.threatModelPath}: ${err.message}`
      );
    }
  }

  if (opts.verifyOnly && !threatModel) {
    throw new Error("--verify-only requires --threat-model to provide the verification brief.");
  }

  // 3. Build agent definitions
  const agents: Record<string, ReturnType<typeof explorerAgent>> = {
    "formal-verifier": verifierAgent(),
  };

  const hasOnchain = !!(opts.address && opts.etherscanApiKey);
  if (!opts.verifyOnly) {
    agents["code-explorer"] = explorerAgent();
    if (hasOnchain) {
      agents["onchain-analyst"] = onchainAgent({
        address: opts.address,
        chainId: opts.chainId,
        etherscanApiKey: opts.etherscanApiKey,
      });
    }
  }

  // 4. Build the orchestrator prompt
  const prompt = opts.verifyOnly
    ? buildVerifyOnlyPrompt(opts, projectDir, threatModel!)
    : buildOrchestratorPrompt(opts, projectDir, hasOnchain, threatModel);

  // 5. Run the orchestrator query
  console.log("─".repeat(60));
  console.log("  Starting analysis with Claude Agent SDK");
  console.log("─".repeat(60) + "\n");

  // Accumulate assistant text as a fallback, but prefer the SDK's own final
  // `result` string. Concatenating every assistant turn produced a file that
  // was the entire transcript rather than the report.
  let transcript = "";
  let finalReport = "";

  for await (const message of query({
    prompt,
    options: {
      model: "opus",
      allowedTools: [
        "Read",
        "Grep",
        "Glob",
        "Bash",
        "Write",
        "Edit",
        "Task",
      ],
      // The cwd is the AUDIT TARGET — untrusted by definition. Loading its
      // .claude/settings.json or CLAUDE.md would let a hostile repo issue
      // instructions to an agent running with permissions bypassed.
      settingSources: [],
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns || 500,
      maxBudgetUsd: opts.maxBudgetUsd || 100,
      thinking: { type: "adaptive" },
      cwd: projectDir,
      env: { ...process.env, ...HALMOS_ENV },
      agents,
    },
  })) {
    handleMessage(message);

    // Capture assistant text as a fallback transcript
    if (message?.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          transcript += block.text + "\n";
        }
      }
    }

    // Log cost/duration on completion and break to stop the loop
    if (message?.type === "result") {
      finalReport = ((message as any).result || "").trim() || transcript;
      const cost = (message as any).total_cost_usd || 0;
      const turns = (message as any).num_turns;
      const duration = (message as any).duration_ms;
      if (cost) {
        console.log(
          `\n  Completed: ${turns} turns, $${cost.toFixed(2)}, ${(duration / 1000).toFixed(1)}s`
        );
      }
      if (message.subtype === "error_max_turns") {
        console.error(`  Turn limit (${opts.maxTurns || 500}) reached. Results may be incomplete.`);
      } else if (message.subtype === "error_max_budget_usd") {
        console.error(`  Budget limit ($${opts.maxBudgetUsd || 100}) reached. Results may be incomplete.`);
      } else if (message.subtype === "error_max_structured_output_retries") {
        console.error("  Structured output retries exceeded. Results may be incomplete.");
      } else if (message.subtype !== "success") {
        console.error(`  Agent error: ${(message as any).error || message.subtype}`);
      }
      break;
    }
  }

  // Verification must leave evidence behind.
  //
  // The orchestrator model sometimes treats the (synchronous) Task tool as if it
  // were asynchronous — it announces that the verifier "is now running", ends its
  // turn, and we would otherwise write a confident-looking report containing no
  // verification at all and exit 0. For a security tool that silent false
  // success is the worst possible outcome, so check for the artifacts directly
  // rather than trusting the narrative.
  const testsWritten = countGeneratedTests(projectDir);
  if (testsWritten === 0) {
    const mode = opts.verifyOnly ? "--verify-only" : "analyze";
    throw new Error(
      `Verification produced no tests.\n` +
        `  No .sol files were written to ${join(projectDir, FORGE_PROOF_TEST_DIR)}, so nothing was\n` +
        `  actually verified and no report will be written.\n\n` +
        `  This usually means the orchestrator ended its turn believing the\n` +
        `  formal-verifier was still running in the background. The Task tool is\n` +
        `  synchronous; weaker models routed through an LLM gateway get this wrong.\n\n` +
        `  Try: re-run ${mode}, or point ANTHROPIC_DEFAULT_OPUS_MODEL at a more\n` +
        `  capable model for the orchestrator.`
    );
  }
  console.log(`\n  Verification wrote ${testsWritten} test file(s) to ${FORGE_PROOF_TEST_DIR}/`);

  // ── Phase 4: independent audit of the spec the agent produced ────────────
  //
  // Everything above this point is the agent's own account of its work. The
  // steps below re-derive the results from Halmos directly and then attack the
  // spec, so the final report rests on measurement rather than narration.
  let specAudit = "";
  const halmosEnv = { ...HALMOS_ENV };

  if (opts.auditSpec !== false) {
    try {
      console.log("\n  Auditing spec (re-running Halmos for structured results)...");
      // Drop stale artifacts first: halmos reads artifacts, not sources, so a
      // test contract that was renamed mid-run would otherwise still be counted.
      cleanBuild(projectDir, halmosEnv);
      const run = runHalmos({
        projectDir,
        env: halmosEnv,
        loopBound: opts.loopBound,
        solverTimeoutMs: opts.solverTimeout,
      });
      if (run.outcomes.length === 0) {
        console.log(
          "  No check_ properties found — spec audit has nothing to classify."
        );
      } else {
        console.log(`  ${summarize(run)}`);
        specAudit += formatVacuityReport(run);
      }

      if (run.vacuous > 0) {
        console.warn(
          `  WARNING: ${run.vacuous} propert(ies) proved nothing — see the ` +
            `VACUOUS section of the report.`
        );
      }
    } catch (err: any) {
      // A spec audit failure must not discard the verification work above it.
      console.warn(`  Spec audit skipped: ${err.message?.split("\n")[0] ?? err}`);
    }
  }

  // Mutation testing is independent of the vacuity classification: it establishes
  // its own baseline, so --no-audit-spec must not disable it.
  if (opts.mutationTest) {
    try {
      console.log("\n  Mutation testing (no model tokens — forge + halmos only)...");
      const mreport: MutationReport = runMutationTesting({
        projectDir,
        env: halmosEnv,
        loopBound: opts.loopBound,
        solverTimeoutMs: opts.solverTimeout,
        maxMutants: opts.maxMutants,
        onProgress: (m) => console.log(m),
      });
      if (mreport.score !== undefined) {
        console.log(`\n  Mutation score: ${Math.round(mreport.score * 100)}% ` +
          `(${mreport.killed} killed / ${mreport.survived} survived)`);
      }
      specAudit += "\n" + formatMutationReport(mreport);
    } catch (err: any) {
      // A mutation failure must not discard the verification work above it.
      console.warn(`  Mutation testing skipped: ${err.message?.split("\n")[0] ?? err}`);
    }
  }

  // Verification wrote tests (the guard above), yet the orchestrator returned no
  // final text — surface it instead of exiting 0 with no report.
  if (!finalReport.trim()) {
    const mode = opts.verifyOnly ? "--verify-only" : "analyze";
    throw new Error(
      `Verification produced no report.\n` +
        `  ${testsWritten} test file(s) were written to ${join(projectDir, FORGE_PROOF_TEST_DIR)}, but the\n` +
        `  orchestrator returned no final text, so no report will be written.\n\n` +
        `  This usually means the orchestrator ended its turn believing the\n` +
        `  formal-verifier was still running in the background. The Task tool is\n` +
        `  synchronous; weaker models routed through an LLM gateway get this wrong.\n\n` +
        `  Try: re-run ${mode}, or point ANTHROPIC_DEFAULT_OPUS_MODEL at a more\n` +
        `  capable model for the orchestrator.`
    );
  }

  if (specAudit) finalReport = finalReport.trimEnd() + "\n\n---\n\n" + specAudit;

  // Write report to timestamped run directory
  if (finalReport.trim()) {
    const baseOutputDir = opts.outputDir || "forge-proof-output";
    const ts = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
    const runDir = join(baseOutputDir, `analyze-${ts}`);
    mkdirSync(runDir, { recursive: true });

    const mdPath = join(runDir, "forge-proof-report.md");
    const header = `# Forge Proof — Security Audit Report\n\n**Target:** ${opts.contractPath}\n**Date:** ${new Date().toISOString()}\n\n---\n\n`;
    writeFileSync(mdPath, header + finalReport, "utf-8");

    const jsonPath = join(runDir, "forge-proof-report.json");
    writeFileSync(jsonPath, JSON.stringify({
      target: opts.contractPath,
      timestamp: new Date().toISOString(),
      threatModel: opts.threatModelPath || null,
      verifyOnly: opts.verifyOnly || false,
      report: finalReport,
    }, null, 2), "utf-8");

    console.log(`\n  Report: ${mdPath}`);
    console.log(`  JSON:   ${jsonPath}`);
  }
}

/**
 * Render the Halmos-derived verdicts, separating real proofs from vacuous ones.
 * A vacuous PASS is indistinguishable from a genuine one in the agent's prose,
 * which is exactly why this is derived from the JSON instead.
 */
function formatVacuityReport(run: HalmosRun): string {
  const lines = [
    "## SPEC AUDIT (independently re-derived from Halmos)",
    "",
    `${run.verified} verified, ${run.violated} violated, ${run.vacuous} vacuous, ` +
      `${run.errored} errored.`,
    "",
  ];

  const vacuous = run.outcomes.filter((o) => o.verdict === "vacuous");
  if (vacuous.length > 0) {
    lines.push(
      "### VACUOUS — reported no violation but proved nothing",
      "",
      "These did not fail, but no reachable path ever evaluated the assertion.",
      "They must not be read as verification:",
      ""
    );
    for (const o of vacuous) {
      lines.push(`- \`${o.name}\` — ${o.vacuityReason}`);
    }
    lines.push("");
  }

  const violated = run.outcomes.filter((o) => o.verdict === "violated");
  if (violated.length > 0) {
    lines.push("### VIOLATED — counterexample found", "");
    for (const o of violated) {
      const ce = o.counterexamples
        .map((c) => `${c.variable}=${c.value}`)
        .join(", ");
      lines.push(`- \`${o.name}\`${ce ? ` — ${ce}` : ""}`);
    }
    lines.push("");
  }

  const verified = run.outcomes.filter((o) => o.verdict === "verified");
  if (verified.length > 0) {
    lines.push("### VERIFIED — holds on all reachable paths (within bounds)", "");
    for (const o of verified) {
      lines.push(`- \`${o.name}\` (paths: ${o.totalPaths}, ${o.seconds.toFixed(2)}s)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Count generated Halmos test files, the observable evidence that verification ran. */
function countGeneratedTests(projectDir: string): number {
  const dir = join(projectDir, FORGE_PROOF_TEST_DIR);
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".sol")).length;
  } catch {
    return 0;
  }
}

/** Resolve the Solidity source directory from foundry.toml (default "src"). */
function resolveSrcDir(projectDir: string): string {
  try {
    const toml = readFileSync(join(projectDir, "foundry.toml"), "utf-8");
    const m = toml.match(/^\s*src\s*=\s*['"]([^'"]+)['"]/m);
    return m ? m[1] : "src";
  } catch {
    return "src";
  }
}

function formatThreatModelSection(threatModel: ThreatModel): string {
  const threats = threatModel.threats
    .sort((a, b) => a.priority - b.priority)
    .map((t) => {
      const lines = [
        `- **T-${t.id}: ${t.title}** [${t.severity}] [${t.category}]`,
        `  ${t.description}`,
        `  Affected: ${t.affectedCode.join(", ")}`,
      ];
      if (t.suggestedProperties.length > 0) {
        lines.push(`  Suggested properties: ${t.suggestedProperties.join("; ")}`);
      }
      if (t.attackScenario) {
        lines.push(`  Attack scenario: ${t.attackScenario}`);
      }
      lines.push(`  Claim evidence: ${t.claimReview?.status ?? "not-assessed"}; source citation checks do not verify exploit execution.`);
      if (t.claimReview?.issues.length) lines.push(`  Unresolved evidence checks: ${t.claimReview.issues.join("; ")}`);
      if (t.claimAssessment) lines.push(`  Generator claim assessment (unverified): ${JSON.stringify(t.claimAssessment)}`);
      if (t.mergedClaims) lines.push(`  Original merged claim assessments (unverified): ${JSON.stringify(t.mergedClaims)}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return `## Pre-Generated Threat Model

A threat model has already been generated for this contract (${threatModel.threats.length} threats, type: ${threatModel.contractType}).
Use it to FOCUS your analysis — do NOT start from scratch.

### Threats (ranked by priority)

${threats}

### Instructions
- The code-explorer should VALIDATE these threats (confirm or reject with evidence), not re-discover them from scratch
- Treat generator assessments as hypotheses. Exact source-quote matching is not semantic or executable verification. Resolve missing evidence, guards, rollback and economics; preserve counterevidence.
- The code-explorer should identify any ADDITIONAL threats not covered above
- The formal-verifier should prioritize writing check_ tests for the suggestedProperties listed above
- Threats marked Critical/High should be verified FIRST
`;
}

function buildVerifyOnlyPrompt(
  opts: AnalyzeOptions,
  projectDir: string,
  threatModel: ThreatModel
): string {
  const loopBound = opts.loopBound || 3;
  const solverTimeout = opts.solverTimeout || 10000;
  const srcDir = resolveSrcDir(projectDir);

  const threatSection = formatThreatModelSection(threatModel);

  return `You are Forge Proof, running in VERIFY-ONLY mode. Skip all exploration — go straight to formal verification.

Working directory (Foundry project): ${projectDir}
Source contracts are in: ${projectDir}/${srcDir}/

${threatSection}

## Your Task

Use the **formal-verifier** agent to write and run Halmos symbolic tests for the threats above. Do NOT run a code-explorer — the threat model is your brief.

For each threat:
1. Read the affected code locations listed in the threat
2. Write a check_ test function that would catch the vulnerability
3. Compile with forge build — fix errors iteratively
4. Run halmos --function check_ --loop ${loopBound} --solver-timeout-assertion ${solverTimeout}
5. If Halmos times out, fall back to forge test --match-test test_fuzz_ --fuzz-runs 1000000

Write all test files to ${projectDir}/.forge-proof/test/ — do NOT modify the project's own test/ directory or foundry.toml.
Check for existing test files in ${projectDir}/.forge-proof/test/ — if previous tests exist from an interrupted run, READ them first, fix any issues, and continue from where they left off rather than rewriting from scratch.
When running forge build or halmos, use:
  forge build
  halmos --function check_ --loop ${loopBound} --solver-timeout-assertion ${solverTimeout}

Halmos selects tests by CONTRACT and FUNCTION name, never by path: --match-contract (-mc),
--match-test (-mt), --function. There is no --match-path flag, and
\`forge build --extra-output-files none\` is not a valid command either.

FOUNDRY_TEST=${FORGE_PROOF_TEST_DIR} and FOUNDRY_DYNAMIC_TEST_LINKING=false are already
exported in your environment. Both are required: the first makes forge and halmos see
tests outside the default paths, the second stops Foundry rewriting \`new Contract()\` into
a cheatcode Halmos cannot execute.

After verification, produce a FINAL REPORT:

**VERIFIED PROPERTIES** — Properties proven to hold (within bounds): property name, Halmos bounds, path count, time.

**VIOLATIONS FOUND** — Real bugs with counterexamples: description, concrete values, attack scenario, severity.

**FUZZ RESULTS** — Properties verified by fuzz testing (not exhaustive): property name, run count, duration, any failures.

**INCONCLUSIVE** — Properties that couldn't be verified: reason, partial results.

**LIMITATIONS** — Loop bounds, properties not checked, timeouts encountered.

## How delegation works — read this carefully

The Task tool is SYNCHRONOUS. When you delegate to an agent, the tool does not
return until that agent has completely finished, and the value it returns is the
agent's full final output. Nothing runs in the background, there are no
completion notifications, and there is nothing to poll or wait for.

Therefore:
- NEVER say an agent "is running in the background" or that you will "wait for
  it to complete". By the time you can write that sentence, it has already
  finished and you are holding its result.
- NEVER end your turn immediately after a Task call. The result is already in
  hand — use it.
- Your turn is not over until you have written the FINAL REPORT below, populated
  with the actual verification results the agent returned.

IMPORTANT: Once the FINAL REPORT is written, STOP. Do not summarize it again and
do not re-state findings. Your job is done at that point.`;
}

function buildOrchestratorPrompt(
  opts: AnalyzeOptions,
  projectDir: string,
  hasOnchain: boolean,
  threatModel?: ThreatModel
): string {
  const loopBound = opts.loopBound || 3;
  const solverTimeout = opts.solverTimeout || 10000;
  const srcDir = resolveSrcDir(projectDir);

  const threatModelSection = threatModel
    ? "\n" + formatThreatModelSection(threatModel) + "\n"
    : "";

  return `You are Forge Proof, a smart contract security analyzer that combines deep code analysis, on-chain intelligence, and formal verification using Halmos.

Your target contract is at: ${opts.contractPath}
Working directory (Foundry project): ${projectDir}
${opts.address ? `On-chain address: ${opts.address} (chain: ${opts.chainId || "1"})` : "No on-chain address provided — skip on-chain analysis."}
${opts.etherscanApiKey ? "Etherscan API key is available." : ""}
${threatModelSection}
## Your Workflow

### Phase 1: Deep Understanding${hasOnchain ? " (run code-explorer and onchain-analyst IN PARALLEL)" : ""}

1. Use the **code-explorer** agent to deeply analyze the contract source code in ${projectDir}/${srcDir}/:
   - Map all state variables, their visibility, and who can modify them
   - Trace all external calls and identify reentrancy surfaces
   - Identify access control patterns and potential bypasses
   - Map token flow (mints, burns, transfers) and accounting logic
   - List specific vulnerability hypotheses with evidence
   - Suggest 5-15 formal properties that SHOULD hold true

${hasOnchain ? `2. SIMULTANEOUSLY use the **onchain-analyst** agent to analyze real transaction data:
   - Fetch recent transactions to understand usage patterns
   - Identify the most-called functions and typical parameters
   - Look for unusual transactions (large values, admin actions, failed txns)
   - Extract concrete values from real transactions for test parameters` : "2. Skip on-chain analysis (no address provided)."}

### Phase 2: Formal Verification

3. After Phase 1 completes, synthesize ALL findings into a clear brief for the verifier. Include:
   - Every vulnerability hypothesis with the code evidence
   - Every suggested property to verify
   - ${hasOnchain ? "Concrete values from on-chain analysis" : "Reasonable test bounds"}
   - The exact import paths and contract names from the source

4. Use the **formal-verifier** agent to:
   - Write Halmos symbolic tests (check_ prefix functions) in ${projectDir}/.forge-proof/test/
   - Tests must import: SymTest from halmos-cheatcodes/SymTest.sol, Test from forge-std/Test.sol
   - Tests must inherit from both SymTest and Test
   - Use svm.createUint256(), svm.createAddress() for symbolic inputs
   - Use vm.assume() for input constraints
   - Run \`forge build\` first — fix any compilation errors iteratively
   - Run \`halmos --function check_ --loop ${loopBound} --solver-timeout-assertion ${solverTimeout}\`
   - FOUNDRY_TEST=${FORGE_PROOF_TEST_DIR} and FOUNDRY_DYNAMIC_TEST_LINKING=false are already
     exported and are both required for halmos to find and execute the tests
   - For each [FAIL]: determine if real vulnerability or bad spec
   - For real bugs: explain the attack with concrete counterexample values
   - For bad specs: refine the property and retry (max 3 iterations per property)

### Phase 3: Final Report

5. After verification is complete, produce your FINAL REPORT with these sections:

**VERIFIED PROPERTIES** — Properties mathematically proven to hold (within bounds):
- Property name and description
- Halmos bounds used (--loop value, solver timeout)
- Path count and verification time

**VIOLATIONS FOUND** — Real bugs confirmed by counterexample:
- Vulnerability description
- Counterexample values (converted to decimal/ETH amounts)
- Step-by-step attack scenario using the counterexample
- Severity assessment (Critical/High/Medium/Low)
${hasOnchain ? "- On-chain correlation: has this been exploited in production?" : ""}

**INCONCLUSIVE** — Properties that couldn't be fully verified:
- Reason (timeout, path explosion, compilation issues)
- Partial results if available

**LIMITATIONS**:
- Loop bounds used (what this means for verification completeness)
- Properties NOT checked and why
- Any Halmos timeouts encountered

Be thorough. The Halmos tests and their results are the most important output — they provide mathematical evidence, not opinions.

## How delegation works — read this carefully

The Task tool is SYNCHRONOUS. When you delegate to an agent, the tool does not
return until that agent has completely finished, and the value it returns is the
agent's full final output. Nothing runs in the background, there are no
completion notifications, and there is nothing to poll or wait for.

Therefore:
- NEVER say an agent "is running in the background" or that you will "wait for
  it to complete". By the time you can write that sentence, it has already
  finished and you are holding its result.
- NEVER end your turn immediately after a Task call. The result is already in
  hand — use it.
- Your turn is not over until you have written the FINAL REPORT below, populated
  with the actual verification results the agent returned.

IMPORTANT: Once the FINAL REPORT is written, STOP. Do not summarize it again and
do not re-state findings. Your job is done at that point.`;
}

/**
 * Handle streaming messages from the SDK and display progress.
 */
const startTime = Date.now();

function elapsed(): string {
  return `${((Date.now() - startTime) / 1000).toFixed(0)}s`;
}

/** Tool result content is either a string or an array of content blocks. */
function renderToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function handleMessage(message: any): void {
  if (!message) return;

  // Assistant text messages
  if (message.type === "assistant" && message.message?.content) {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text) {
        console.log(block.text);
      }
      if (block.type === "tool_use") {
        const name = block.name || "unknown";
        const inputPreview = block.input
          ? JSON.stringify(block.input).slice(0, 120)
          : "";
        if (name === "Task") {
          const agentName =
            block.input?.description || block.input?.subagent_type || "subagent";
          console.log(`\n  [${elapsed()}] >> Delegating to: ${agentName}`);
        } else {
          console.log(`  [${elapsed()}] [${name}] ${inputPreview}...`);
        }
      }
    }
  }

  // Tool results. The SDK has no top-level "tool_result" message type — results
  // arrive as `user` messages carrying tool_result content blocks. Matching on
  // message.type === "tool_result" silently discarded every tool error.
  if (message.type === "user" && message.message?.content) {
    const blocks = Array.isArray(message.message.content)
      ? message.message.content
      : [];
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const text = renderToolResult(block.content);
      if (block.is_error) {
        console.error(`  [${elapsed()}] [ERROR] ${text.slice(0, 300)}`);
      } else if (text.length > 500) {
        console.log(`  [${elapsed()}] [result] (${text.length} chars)`);
      }
    }
  }

  // Final result
  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log("\n" + "═".repeat(60));
      console.log(`  Analysis complete. (${elapsed()})`);
      console.log("═".repeat(60));
      if (message.result) {
        console.log(message.result);
      }
    } else {
      // Real failure subtypes: error_during_execution, error_max_turns,
      // error_max_budget_usd, error_max_structured_output_retries.
      console.error(
        `\n  [${elapsed()}] ${message.subtype}: ${message.error || "see output above"}`
      );
    }
  }
}
