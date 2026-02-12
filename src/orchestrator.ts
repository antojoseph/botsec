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

export interface AnalyzeOptions {
  contractPath: string;
  address?: string;
  chainId?: string;
  etherscanApiKey?: string;
  loopBound?: number;
  solverTimeout?: number;
  maxTurns?: number;
  outputDir?: string;
}

export async function analyze(opts: AnalyzeOptions): Promise<void> {
  // 1. Scaffold Foundry project
  console.log("\n  Setting up Foundry project...");
  const projectDir = await scaffoldFoundryProject(opts.contractPath);
  console.log(`  Working directory: ${projectDir}\n`);

  // 2. Build agent definitions
  const agents: Record<string, ReturnType<typeof explorerAgent>> = {
    "code-explorer": explorerAgent(),
    "formal-verifier": verifierAgent(),
  };

  // Only include on-chain agent if address is provided
  const hasOnchain = !!(opts.address && opts.etherscanApiKey);
  if (hasOnchain) {
    agents["onchain-analyst"] = onchainAgent({
      address: opts.address,
      chainId: opts.chainId,
      etherscanApiKey: opts.etherscanApiKey,
    });
  }

  // 3. Build the orchestrator prompt
  const prompt = buildOrchestratorPrompt(opts, projectDir, hasOnchain);

  // 4. Run the orchestrator query
  console.log("─".repeat(60));
  console.log("  Starting analysis with Claude Agent SDK");
  console.log("─".repeat(60) + "\n");

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
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns || 500,
      cwd: projectDir,
      agents,
    },
  })) {
    handleMessage(message);
  }
}

function buildOrchestratorPrompt(
  opts: AnalyzeOptions,
  projectDir: string,
  hasOnchain: boolean
): string {
  const loopBound = opts.loopBound || 3;
  const solverTimeout = opts.solverTimeout || 10000;

  return `You are Forge Proof, a smart contract security analyzer that combines deep code analysis, on-chain intelligence, and formal verification using Halmos.

Your target contract is at: ${opts.contractPath}
Working directory (Foundry project with contract copied to src/): ${projectDir}
${opts.address ? `On-chain address: ${opts.address} (chain: ${opts.chainId || "1"})` : "No on-chain address provided — skip on-chain analysis."}
${opts.etherscanApiKey ? "Etherscan API key is available." : ""}

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
   - Write Halmos symbolic tests (check_ prefix functions) in ${projectDir}/test/
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

Be thorough. The Halmos tests and their results are the most important output — they provide mathematical evidence, not opinions.`;
}

/**
 * Handle streaming messages from the SDK and display progress.
 */
function handleMessage(message: any): void {
  // The SDK emits different message types — handle the main ones
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
          const agentType =
            block.input?.subagent_type || block.input?.description || "subagent";
          console.log(`\n  >> Delegating to: ${agentType}`);
        } else {
          console.log(`  [${name}] ${inputPreview}...`);
        }
      }
    }
  }

  // Tool results
  if (message.type === "tool_result") {
    // Tool results from subagents can be large — just note completion
    const content = message.content;
    if (typeof content === "string" && content.length > 500) {
      console.log(`  [result] (${content.length} chars)`);
    }
  }

  // Final result
  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log("\n" + "═".repeat(60));
      console.log("  Analysis complete.");
      console.log("═".repeat(60));
      if (message.result) {
        console.log(message.result);
      }
    } else if (message.subtype === "error") {
      console.error(`\n  Error: ${message.error || "Unknown error"}`);
    }
  }
}
