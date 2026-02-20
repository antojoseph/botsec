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
import type {
  ThreatModel,
  Threat,
  ThreatCategory,
  ContractType,
  PrecomputedAnalysis,
} from "./types.js";
import type {
  Provider,
  PrecomputeResult,
} from "./providers/types.js";
import {
  precomputeProviders,
  enrichmentProviders,
  synthesisFilterProviders,
  outputFormatProviders,
} from "./providers/registry.js";

export interface ThreatModelOptions {
  /** Path to a Foundry project (must contain foundry.toml) */
  contractPath: string;
  outputDir?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Active providers (filtered by CLI flags) */
  enabledProviders?: Provider[];
  /** Per-provider CLI flag values */
  providerFlagValues?: Map<string, Record<string, string | boolean>>;
}

export async function generateThreatModel(
  opts: ThreatModelOptions
): Promise<ThreatModel> {
  const baseOutputDir = opts.outputDir || "forge-proof-output";
  const runDir = join(baseOutputDir, `threat-model-${timestamp()}`);

  // Phase 0: Pre-computation
  console.log("\n  Phase 0: Pre-computing analysis data...");
  const precomputed = await precomputeAnalysis(opts.contractPath);

  const forgeProofDir = join(precomputed.projectDir, ".forge-proof");
  mkdirSync(forgeProofDir, { recursive: true });

  // Run precompute providers (AST, inspect, blueprint, etherscan, slither, etc.)
  // Providers populate precomputed via result.data (merged after each run).
  const active = opts.enabledProviders || [];
  const flagValues = opts.providerFlagValues || new Map();
  const precomputeResults: PrecomputeResult[] = [];

  for (const provider of precomputeProviders(active)) {
    const result = await provider.run({
      projectDir: precomputed.projectDir,
      forgeProofDir,
      precomputed,
      flagValues: flagValues.get(provider.id) || {},
    });
    // Merge structured data into precomputed (e.g., structural, abi, blueprint)
    if (result.data) {
      Object.assign(precomputed, result.data);
    }
    precomputeResults.push(result);
  }

  // Write structural data to disk for file-based agent access
  let blueprintPath: string | undefined;
  let codemapPath: string | undefined;

  if (precomputed.blueprint) {
    blueprintPath = join(forgeProofDir, "blueprint.json");
    writeFileSync(blueprintPath, JSON.stringify(precomputed.blueprint, null, 2), "utf-8");
    console.log(`  Blueprint written to: ${blueprintPath}`);
  }
  if (precomputed.structural) {
    const codemapDir = join(forgeProofDir, "codemap");
    mkdirSync(codemapDir, { recursive: true });
    codemapPath = codemapDir;

    const s = precomputed.structural;

    writeFileSync(join(codemapDir, "_inheritance.json"), JSON.stringify(s.inheritance, null, 2), "utf-8");
    writeFileSync(join(codemapDir, "_callGraph.json"), JSON.stringify(s.callGraph, null, 2), "utf-8");
    writeFileSync(join(codemapDir, "_stateVarMap.json"), JSON.stringify(s.stateVarMap, null, 2), "utf-8");
    writeFileSync(join(codemapDir, "_dataDependency.json"), JSON.stringify(s.dataDependency, null, 2), "utf-8");

    const contracts = new Set<string>();
    for (const key of Object.keys(s.functionSummary)) {
      const contract = key.split(".")[0];
      if (contract) contracts.add(contract);
    }

    for (const contract of contracts) {
      const contractData: Record<string, any> = {
        functionSummary: {},
        operationOrder: {},
        authChecks: {},
        guardInventory: {},
      };
      for (const [k, v] of Object.entries(s.functionSummary)) {
        if (k.startsWith(contract + ".")) contractData.functionSummary[k] = v;
      }
      for (const [k, v] of Object.entries(s.operationOrder)) {
        if (k.startsWith(contract + ".")) contractData.operationOrder[k] = v;
      }
      for (const [k, v] of Object.entries(s.authChecks)) {
        if (k.startsWith(contract + ".")) contractData.authChecks[k] = v;
      }
      for (const [k, v] of Object.entries(s.guardInventory)) {
        if (k.startsWith(contract + ".")) contractData.guardInventory[k] = v;
      }
      if (precomputed.storageLayout[contract]) {
        contractData.storageLayout = precomputed.storageLayout[contract];
      }
      writeFileSync(join(codemapDir, `${contract}.json`), JSON.stringify(contractData, null, 2), "utf-8");
    }

    console.log(`  Code map written to: ${codemapDir}/ (${contracts.size} contract files + 4 global files)`);
  }

  // Phase 1: Agent exploration
  console.log("\n  Phase 1: Agentic code exploration...");
  console.log("─".repeat(60));

  // Collect extra data sections from precompute providers for the agent prompt
  const extraDataSections = precomputeResults
    .filter((r) => r.agentPromptSection)
    .map((r) => r.agentPromptSection)
    .join("\n\n");

  const agentDef = threatModelerAgent(precomputed, {
    blueprintPath,
    codemapPath,
    extraDataSections: extraDataSections || undefined,
  });
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
      betas: ["context-1m-2025-08-07"],
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Task", "Skill"],
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns || 200,
      maxBudgetUsd: opts.maxBudgetUsd || 50,
      thinking: { type: "adaptive" },
      cwd: precomputed.projectDir,
      agents,
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            contractType: {
              type: "string",
              enum: [
                "vault", "dex", "lending", "token", "governance",
                "bridge", "staking", "nft", "oracle", "proxy", "other",
              ],
            },
            actors: { type: "array", items: { type: "object" } },
            assets: { type: "array", items: { type: "object" } },
            trustBoundaries: { type: "array", items: { type: "object" } },
            threats: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  category: {
                    type: "string",
                    enum: [
                      "access-control", "reentrancy", "oracle-manipulation", "flash-loan",
                      "arithmetic", "denial-of-service", "front-running", "token-handling",
                      "upgradeability", "cross-contract", "governance", "randomness",
                      "unchecked-calls", "logic-error",
                    ],
                  },
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
      costUsd = (message as any).total_cost_usd || 0;
      durationMs = (message as any).duration_ms || 0;
      numTurns = (message as any).num_turns || 0;

      if (message.subtype === "success") {
        // Prefer structured_output (SDK-validated JSON) over free-form text
        rawModel = (message as any).structured_output || parseAgentOutput((message as any).result || "");
      } else if (message.subtype === "error_max_turns") {
        console.error(`\n  Turn limit (${opts.maxTurns || 200}) reached. Recovering partial results...`);
        rawModel = (message as any).structured_output || parseAgentOutput((message as any).result || "");
      } else if (message.subtype === "error_max_budget_usd") {
        console.error(`\n  Budget limit ($${opts.maxBudgetUsd || 50}) reached. Recovering partial results...`);
        rawModel = (message as any).structured_output || parseAgentOutput((message as any).result || "");
      } else if (message.subtype === "error_max_structured_output_retries") {
        console.error("\n  Structured output retries exceeded. Recovering partial results...");
        rawModel = parseAgentOutput((message as any).result || "");
      } else {
        console.error(`\n  Agent error: ${(message as any).error || message.subtype}`);
        rawModel = parseAgentOutput((message as any).result || "");
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

  // Extract unique threat categories for enrichment providers
  const categories = [
    ...new Set(rawModel.threats.map((t: Threat) => t.category)),
  ] as ThreatCategory[];

  // Run enrichment providers (Solodit, Code4rena, etc.)
  const enrichmentSources: string[] = [];
  let totalEnrichmentFindings = 0;

  for (const provider of enrichmentProviders(active)) {
    const result = await provider.enrich({
      threats: rawModel.threats,
      contractType: (precomputed.blueprint?.classification.type || "other") as ContractType,
      categories,
      precomputed,
      flagValues: flagValues.get(provider.id) || {},
    });
    enrichmentSources.push(result.sourceKey);
    totalEnrichmentFindings += result.findingsAttached;
  }

  // Run synthesis filter providers (anti-slop, self-contradiction, dedup, ranking, custom)
  for (const filter of synthesisFilterProviders(active)) {
    rawModel.threats = filter.apply(rawModel.threats, precomputed);
  }

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
        ...enrichmentSources,
        ...precomputeResults.map((r) => r.sourceKey),
      ],
      soloditFindings: totalEnrichmentFindings,
    },
  };

  // Write output to timestamped run directory
  mkdirSync(runDir, { recursive: true });
  const outputPath = join(runDir, "threat-model.json");
  writeFileSync(outputPath, JSON.stringify(threatModel, null, 2), "utf-8");

  // Write blueprint for inspection
  if (precomputed.blueprint) {
    const bpOutPath = join(runDir, "blueprint.json");
    writeFileSync(bpOutPath, JSON.stringify(precomputed.blueprint, null, 2), "utf-8");
    console.log(`  Blueprint: ${bpOutPath}`);
  }

  // Run output format providers (SARIF, HTML, etc.)
  for (const provider of outputFormatProviders(active)) {
    const outPath = provider.write({
      threatModel,
      runDir,
      flagValues: flagValues.get(provider.id) || {},
    });
    console.log(`  ${provider.name} output: ${outPath}`);
  }

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
  // Strategy 1: Try raw JSON parse
  try {
    return JSON.parse(output);
  } catch { /* continue */ }

  // Strategy 2: Extract from markdown code blocks
  const jsonBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch { /* continue */ }
  }

  // Strategy 3: Find outermost JSON object
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(output.slice(jsonStart, jsonEnd + 1));
    } catch { /* continue */ }
  }

  // Strategy 4: Extract just the threats array and wrap it
  const threatsMatch = output.match(/"threats"\s*:\s*(\[[\s\S]*\])/);
  if (threatsMatch) {
    try {
      const threats = JSON.parse(threatsMatch[1]);
      console.log(`  Recovered ${threats.length} threat(s) from partial JSON.`);
      return { contractType: "other", actors: [], assets: [], trustBoundaries: [], threats };
    } catch { /* continue */ }
  }

  console.warn(
    "  Warning: Could not parse agent output as JSON. Creating empty threat model."
  );
  console.warn(`  First 500 chars: ${output.slice(0, 500)}`);
  return {
    contractType: "other",
    actors: [],
    assets: [],
    trustBoundaries: [],
    threats: [],
  };
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

function timestamp(): string {
  return new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
}

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
