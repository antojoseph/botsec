/**
 * Threat Model Orchestrator — coordinates the threat modeling pipeline:
 *
 * Phase 0: Pre-compute (solc AST + forge inspect + Etherscan v2)
 * Phase 1: Agent exploration (threat modeler agent traces code paths)
 * Phase 2: Synthesis (Solodit enrichment + ranking + anti-slop filter)
 *
 * Output: threat-model.json
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { threatModelerAgent } from "../agents/threat-modeler.js";
import { precomputeAnalysis } from "./precompute.js";
import { searchSolodit } from "./solodit.js";
import type {
  ThreatModel,
  Threat,
  ThreatCategory,
  PrecomputedAnalysis,
} from "./types.js";

export interface ThreatModelOptions {
  /** Path to a Foundry project (must contain foundry.toml) */
  contractPath: string;
  /** On-chain contract address (optional, enables Etherscan v2) */
  address?: string;
  chainId?: string;
  etherscanApiKey?: string;
  soloditKey?: string;
  outputDir?: string;
  maxTurns?: number;
}

export async function generateThreatModel(
  opts: ThreatModelOptions
): Promise<ThreatModel> {
  const outputDir = opts.outputDir || "forge-proof-output";

  // Phase 0: Pre-computation
  console.log("\n  Phase 0: Pre-computing analysis data...");
  const precomputed = await precomputeAnalysis(opts.contractPath, {
    address: opts.address,
    chainId: opts.chainId ? parseInt(opts.chainId) : undefined,
    etherscanApiKey: opts.etherscanApiKey,
  });

  // Phase 1: Agent exploration
  console.log("\n  Phase 1: Agentic code exploration...");
  console.log("─".repeat(60));

  const agentDef = threatModelerAgent(precomputed);
  const agents = { "threat-modeler": agentDef };

  const orchestratorPrompt = buildOrchestratorPrompt(precomputed);

  let rawModel: any = null;
  let costUsd = 0;
  let durationMs = 0;
  let numTurns = 0;

  for await (const message of query({
    prompt: orchestratorPrompt,
    options: {
      model: "opus",
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Task"],
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns || 200,
      maxBudgetUsd: 50,
      maxThinkingTokens: 16000,
      cwd: precomputed.projectDir,
      agents,
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            contractType: { type: "string" },
            actors: { type: "array", items: { type: "object" } },
            assets: { type: "array", items: { type: "object" } },
            trustBoundaries: { type: "array", items: { type: "object" } },
            threats: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  category: { type: "string" },
                  title: { type: "string" },
                  description: { type: "string" },
                  affectedCode: { type: "array", items: { type: "string" } },
                  assets: { type: "array", items: { type: "string" } },
                  severity: { type: "string", enum: ["Critical", "High", "Medium", "Low"] },
                  confidence: { type: "string", enum: ["high", "medium", "low"] },
                  trace: {
                    type: "object",
                    properties: {
                      steps: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            action: { type: "string" },
                            target: { type: "string" },
                            finding: { type: "string" },
                          },
                          required: ["action", "target", "finding"],
                        },
                      },
                      ceiTimeline: { type: "object" },
                      dataFlow: { type: "object" },
                    },
                    required: ["steps"],
                  },
                  suggestedProperties: { type: "array", items: { type: "string" } },
                  attackScenario: { type: "string" },
                  priority: { type: "number" },
                },
                required: [
                  "id", "category", "title", "description", "affectedCode",
                  "severity", "confidence", "trace", "suggestedProperties", "priority",
                ],
              },
            },
          },
          required: ["contractType", "threats"],
        },
      },
    },
  })) {
    handleMessage(message);

    // Capture the final structured result
    if (message?.type === "result") {
      if (message.subtype === "success") {
        // Prefer structured_output (SDK-validated JSON) over free-form text
        rawModel = (message as any).structured_output || parseAgentOutput((message as any).result || "");
        costUsd = (message as any).total_cost_usd || 0;
        durationMs = (message as any).duration_ms || 0;
        numTurns = (message as any).num_turns || 0;
      } else if (message.subtype === "error_max_budget_usd") {
        console.error("\n  Budget limit ($50) reached. Partial results may be available.");
        rawModel = parseAgentOutput((message as any).result || "");
      } else {
        console.error(`\n  Agent error: ${(message as any).error || message.subtype}`);
        rawModel = { contractType: "other", actors: [], assets: [], trustBoundaries: [], threats: [] };
      }
    }
  }

  if (!rawModel) {
    rawModel = { contractType: "other", actors: [], assets: [], trustBoundaries: [], threats: [] };
  }

  if (costUsd > 0) {
    console.log(`\n  Agent completed: ${numTurns} turns, $${costUsd.toFixed(2)}, ${(durationMs / 1000).toFixed(1)}s`);
  }

  // Phase 2: Synthesis
  console.log("\n  Phase 2: Synthesis & enrichment...");

  // Extract unique threat categories for Solodit search
  const categories = [
    ...new Set(rawModel.threats.map((t: Threat) => t.category)),
  ] as ThreatCategory[];

  // Query Solodit for historical findings
  let soloditCount = 0;
  if (opts.soloditKey || true) {
    // Try Solodit regardless (may work without key via public endpoint)
    console.log("  Querying Solodit for historical findings...");
    try {
      const soloditResults = await searchSolodit(
        rawModel.contractType,
        categories,
        opts.soloditKey
      );

      // Attach findings to matching threats
      for (const threat of rawModel.threats) {
        const findings = soloditResults.get(threat.category);
        if (findings && findings.length > 0) {
          threat.historicalEvidence = {
            source: "solodit",
            references: findings.map((f) => ({
              title: f.title,
              url: f.url,
              similarity: `Matches threat category: ${threat.category}`,
            })),
          };
          soloditCount += findings.length;
        }
      }
      console.log(`  Solodit: ${soloditCount} relevant findings attached.`);
    } catch (e) {
      console.log("  Solodit: query failed, continuing without enrichment.");
    }
  }

  // Anti-slop filter: drop threats with empty traces
  const beforeCount = rawModel.threats.length;
  rawModel.threats = rawModel.threats.filter(
    (t: Threat) => t.trace && t.trace.steps && t.trace.steps.length > 0
  );
  const droppedCount = beforeCount - rawModel.threats.length;
  if (droppedCount > 0) {
    console.log(
      `  Anti-slop filter: dropped ${droppedCount} threat(s) with no code trace.`
    );
  }

  // Rank threats by severity × confidence × on-chain activity
  rankThreats(rawModel.threats, precomputed);

  // Build final ThreatModel
  const threatModel: ThreatModel = {
    version: "1.0",
    target: opts.contractPath,
    contractType: rawModel.contractType,
    timestamp: new Date().toISOString(),
    actors: rawModel.actors || [],
    assets: rawModel.assets || [],
    trustBoundaries: rawModel.trustBoundaries || [],
    threats: rawModel.threats,
    onChainProfile: precomputed.onChain,
    precomputed: {
      astAnalysisAvailable: !!precomputed.structural,
      blueprintAvailable: !!precomputed.blueprint,
      functionsAnalyzed: precomputed.structural
        ? Object.keys(precomputed.structural.functionSummary).length
        : 0,
      stateVarsTracked: precomputed.structural
        ? Object.keys(precomputed.structural.stateVarMap).length
        : 0,
      invariantsInferred: precomputed.blueprint
        ? precomputed.blueprint.inferredInvariants.length
        : 0,
      ceiViolationsDetected: precomputed.blueprint
        ? precomputed.blueprint.patternFindings.ceiViolations.length
        : 0,
      etherscanDataAvailable: !!precomputed.onChain,
    },
    metadata: {
      sourcesQueried: [
        "solc-ast",
        "forge-inspect",
        ...(precomputed.onChain ? ["etherscan-v2"] : []),
        "solodit",
      ],
      soloditFindings: soloditCount,
    },
  };

  // Write output
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "threat-model.json");
  writeFileSync(outputPath, JSON.stringify(threatModel, null, 2), "utf-8");

  // Print summary
  printSummary(threatModel, outputPath);

  return threatModel;
}

// ---------------------------------------------------------------------------
// Orchestrator prompt
// ---------------------------------------------------------------------------

function buildOrchestratorPrompt(pre: PrecomputedAnalysis): string {
  return `You are Forge Proof's threat modeling orchestrator.

Your job is to delegate to the **threat-modeler** agent, which will deeply explore the smart contracts in ${pre.projectDir}/src/ and produce a structured threat model as JSON.

## Instructions

1. Delegate to the **threat-modeler** agent with this brief:
   "Analyze all smart contracts in ${pre.projectDir}/src/. Produce a complete threat model as JSON following your output format instructions. Use the pre-computed code map and on-chain data to guide your exploration. Every threat must include a TRACE."

2. When the threat-modeler returns its JSON output, present it as your final response.

3. Do NOT modify the JSON. Do NOT add commentary. Just output the raw JSON the agent produced.

Important: The threat-modeler agent has all the context it needs (AST structural data, Etherscan data, analysis patterns). Just delegate and return the result.`;
}

// ---------------------------------------------------------------------------
// Parse agent output into structured data
// ---------------------------------------------------------------------------

function parseAgentOutput(output: string): any {
  // Try to extract JSON from the output
  // The agent should output raw JSON, but it might be wrapped in markdown code blocks
  let jsonStr = output;

  // Strip markdown code blocks
  const jsonBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1];
  }

  // Try to find the start of JSON object
  const jsonStart = jsonStr.indexOf("{");
  const jsonEnd = jsonStr.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1) {
    jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    console.warn(
      "  Warning: Could not parse agent output as JSON. Creating empty threat model."
    );
    return {
      contractType: "other",
      actors: [],
      assets: [],
      trustBoundaries: [],
      threats: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Threat ranking
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHTS: Record<string, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

const CONFIDENCE_WEIGHTS: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function rankThreats(threats: Threat[], pre: PrecomputedAnalysis): void {
  for (const threat of threats) {
    const sevWeight = SEVERITY_WEIGHTS[threat.severity] || 1;
    const confWeight = CONFIDENCE_WEIGHTS[threat.confidence] || 1;

    // On-chain activity boost: if Etherscan data shows high activity on affected functions
    let onChainBoost = 1;
    if (pre.onChain) {
      for (const code of threat.affectedCode) {
        // Extract function name from "file:function:line" format
        const parts = code.split(":");
        const funcName = parts[1] || "";
        const freq =
          Object.entries(pre.onChain.functionCallFrequency).find(([k]) =>
            k.includes(funcName)
          )?.[1] || 0;
        if (freq > 100) onChainBoost = 2;
        else if (freq > 10) onChainBoost = 1.5;
      }
    }

    // Historical evidence boost
    const histBoost = threat.historicalEvidence ? 1.3 : 1;

    // Priority: lower is higher priority
    const score = sevWeight * confWeight * onChainBoost * histBoost;
    threat.priority = Math.round(100 / score);
  }

  // Sort by priority (ascending = highest priority first)
  threats.sort((a, b) => a.priority - b.priority);

  // Re-number priorities sequentially
  for (let i = 0; i < threats.length; i++) {
    threats[i].priority = i + 1;
  }
}

// ---------------------------------------------------------------------------
// Message handling (streaming output)
// ---------------------------------------------------------------------------

function handleMessage(message: any): void {
  if (!message) return;

  if (message.type === "assistant" && message.message?.content) {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text) {
        // Don't print the full JSON output — it can be huge
        if (block.text.length > 1000 && block.text.includes('"threats"')) {
          console.log("  [Agent produced threat model JSON]");
        } else {
          console.log(block.text);
        }
      }
      if (block.type === "tool_use") {
        const name = block.name || "unknown";
        if (name === "Task") {
          const desc =
            block.input?.description || block.input?.subagent_type || "subagent";
          console.log(`\n  >> Delegating to: ${desc}`);
        } else {
          const preview = block.input
            ? JSON.stringify(block.input).slice(0, 100)
            : "";
          console.log(`  [${name}] ${preview}...`);
        }
      }
    }
  }

  if (message.type === "result" && message.subtype === "error") {
    console.error(`\n  Error: ${message.error || "Unknown error"}`);
  }
}

// ---------------------------------------------------------------------------
// Summary output
// ---------------------------------------------------------------------------

function printSummary(model: ThreatModel, outputPath: string): void {
  console.log("\n" + "═".repeat(60));
  console.log("  THREAT MODEL GENERATED");
  console.log("═".repeat(60));

  console.log(`\n  Contract type: ${model.contractType}`);
  console.log(`  Actors: ${model.actors.length}`);
  console.log(`  Assets: ${model.assets.length}`);
  console.log(`  Trust boundaries: ${model.trustBoundaries.length}`);

  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const t of model.threats) {
    byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    bySeverity[t.severity] = (bySeverity[t.severity] || 0) + 1;
  }

  console.log(`\n  Threats: ${model.threats.length} total`);
  if (bySeverity["Critical"]) console.log(`    Critical: ${bySeverity["Critical"]}`);
  if (bySeverity["High"]) console.log(`    High:     ${bySeverity["High"]}`);
  if (bySeverity["Medium"]) console.log(`    Medium:   ${bySeverity["Medium"]}`);
  if (bySeverity["Low"]) console.log(`    Low:      ${bySeverity["Low"]}`);

  const withHistory = model.threats.filter((t) => t.historicalEvidence).length;
  if (withHistory > 0) {
    console.log(`\n  Threats with historical evidence: ${withHistory}`);
  }

  console.log(`\n  Output: ${outputPath}`);
  console.log("═".repeat(60) + "\n");
}
