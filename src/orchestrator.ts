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
import { scaffoldFoundryProject } from "./scaffold/foundry-project.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ThreatModel, Threat } from "./threat-model/types.js";

export interface AnalyzeOptions {
  contractPath: string;
  address?: string;
  chainId?: string;
  etherscanApiKey?: string;
  loopBound?: number;
  solverTimeout?: number;
  maxTurns?: number;
  outputDir?: string;
  threatModelPath?: string;
  verifyOnly?: boolean;
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

  let finalReport = "";

  for await (const message of query({
    prompt,
    options: {
      model: "opus",
      betas: ["context-1m-2025-08-07"],
      allowedTools: [
        "Read",
        "Grep",
        "Glob",
        "Bash",
        "Write",
        "Edit",
        "Task",
      ],
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns || 500,
      maxBudgetUsd: 100,
      maxThinkingTokens: 16000,
      cwd: projectDir,
      agents,
    },
  })) {
    handleMessage(message);

    // Capture assistant text for the report
    if (message?.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          finalReport += block.text + "\n";
        }
      }
    }

    // Log cost/duration on completion and break to stop the loop
    if (message?.type === "result") {
      const cost = (message as any).total_cost_usd;
      const turns = (message as any).num_turns;
      const duration = (message as any).duration_ms;
      if (cost) {
        console.log(
          `\n  Completed: ${turns} turns, $${cost.toFixed(2)}, ${(duration / 1000).toFixed(1)}s`
        );
      }
      if (message.subtype === "error_max_budget_usd") {
        console.error("  Budget limit ($100) reached.");
      }
      break;
    }
  }

  // Write report to output directory
  if (finalReport.trim()) {
    const outputDir = opts.outputDir || "forge-proof-output";
    mkdirSync(outputDir, { recursive: true });

    const mdPath = join(outputDir, "forge-proof-report.md");
    const header = `# Forge Proof — Security Audit Report\n\n**Target:** ${opts.contractPath}\n**Date:** ${new Date().toISOString()}\n\n---\n\n`;
    writeFileSync(mdPath, header + finalReport, "utf-8");

    const jsonPath = join(outputDir, "forge-proof-report.json");
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

  const threatSection = formatThreatModelSection(threatModel);

  return `You are Forge Proof, running in VERIFY-ONLY mode. Skip all exploration — go straight to formal verification.

Working directory (Foundry project): ${projectDir}
Source contracts are in: ${projectDir}/src/

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
When running forge build or halmos, use: forge build --extra-output-files none && halmos --match-path .forge-proof/test/

After verification, produce a FINAL REPORT:

**VERIFIED PROPERTIES** — Properties proven to hold (within bounds): property name, Halmos bounds, path count, time.

**VIOLATIONS FOUND** — Real bugs with counterexamples: description, concrete values, attack scenario, severity.

**FUZZ RESULTS** — Properties verified by fuzz testing (not exhaustive): property name, run count, duration, any failures.

**INCONCLUSIVE** — Properties that couldn't be verified: reason, partial results.

**LIMITATIONS** — Loop bounds, properties not checked, timeouts encountered.

IMPORTANT: After producing your FINAL REPORT, STOP. Do not summarize again, do not re-state findings, do not check on background tasks. Your job is done once the report is written.`;
}

function buildOrchestratorPrompt(
  opts: AnalyzeOptions,
  projectDir: string,
  hasOnchain: boolean,
  threatModel?: ThreatModel
): string {
  const loopBound = opts.loopBound || 3;
  const solverTimeout = opts.solverTimeout || 10000;

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

1. Use the **code-explorer** agent to deeply analyze the contract source code in ${projectDir}/src/:
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

IMPORTANT: After producing your FINAL REPORT, STOP. Do not summarize again, do not re-state findings, do not check on background tasks. Your job is done once the report is written.`;
}

/**
 * Handle streaming messages from the SDK and display progress.
 */
let turnCount = 0;
const startTime = Date.now();

function elapsed(): string {
  return `${((Date.now() - startTime) / 1000).toFixed(0)}s`;
}

function handleMessage(message: any): void {
  if (!message) return;

  // Assistant text messages
  if (message.type === "assistant" && message.message?.content) {
    turnCount++;
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

  // Tool results
  if (message.type === "tool_result") {
    const content = message.content;
    if (typeof content === "string" && content.length > 500) {
      console.log(`  [${elapsed()}] [result] (${content.length} chars)`);
    }
    // Surface errors from tool calls
    if (message.is_error) {
      const errText = typeof content === "string" ? content.slice(0, 300) : JSON.stringify(content).slice(0, 300);
      console.error(`  [${elapsed()}] [ERROR] ${errText}`);
    }
  }

  // Final result
  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log("\n" + "═".repeat(60));
      console.log(`  Analysis complete. (${turnCount} turns, ${elapsed()})`);
      console.log("═".repeat(60));
      if (message.result) {
        console.log(message.result);
      }
    } else if (message.subtype === "error") {
      console.error(`\n  [${elapsed()}] Error: ${message.error || "Unknown error"}`);
    }
  }
}
