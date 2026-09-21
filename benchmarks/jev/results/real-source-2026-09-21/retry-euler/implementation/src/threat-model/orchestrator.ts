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
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync } from "fs";
import { captureJson, captureStage, sourceInventory } from "./capture.js";
import { sourceOnlyHook } from "./source-only.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
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
  /**
   * Allow `npm install` to run inside the audit target. Off by default: it
   * executes the target's lifecycle scripts.
   */
  allowNpmInstall?: boolean;
  /** Preserve generation output and every synthesis transition. */
  captureRaw?: boolean;
  /** Restrict model tools to reads inside a prepared source workspace. */
  sourceOnly?: boolean;
}

export async function generateThreatModel(
  opts: ThreatModelOptions
): Promise<ThreatModel> {
  const baseOutputDir = opts.outputDir || "forge-proof-output";
  mkdirSync(baseOutputDir, { recursive: true });
  const runDir = opts.captureRaw
    ? mkdtempSync(join(baseOutputDir, `threat-model-${timestamp()}-`))
    : join(baseOutputDir, `threat-model-${timestamp()}`);
  if (opts.sourceOnly && opts.enabledProviders?.some(p => p.phase === "enrichment" || p.id === "etherscan")) {
    throw new Error("Source-only collection cannot use incident/external enrichment providers");
  }
  const inventory = opts.captureRaw ? sourceInventory(opts.contractPath) : undefined;

  // Phase 0: Pre-computation
  console.log("\n  Phase 0: Pre-computing analysis data...");
  const precomputed = await precomputeAnalysis(opts.contractPath, opts.allowNpmInstall === true);

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
  if (opts.sourceOnly) {
    agentDef.tools = ["Read", "Grep", "Glob"];
    agentDef.prompt += "\nSource-only collection: use only Read, Grep, and Glob inside this workspace. If context/ exists, it contains additional contract source in separate compilation units; consult it to resolve cross-contract behavior. No incident history, web access, shell commands, or external files are available.";
  }
  const agents = { "threat-modeler": agentDef };

  const orchestratorPrompt = buildOrchestratorPrompt(precomputed);

  let rawModel: any = null;
  let costUsd = 0;
  let durationMs = 0;
  let numTurns = 0;

  const sdkOptions: Options = {
      model: "opus",
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Task"],
      // See src/orchestrator.ts — the cwd is the untrusted audit target.
      settingSources: [],
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
    };
  if (opts.sourceOnly) {
    sdkOptions.tools = ["Read", "Grep", "Glob", "Task", "Agent"];
    sdkOptions.allowedTools = ["Read", "Grep", "Glob", "Task", "Agent"];
    sdkOptions.disallowedTools = ["Bash", "WebFetch", "WebSearch", "Write", "Edit", "NotebookEdit"];
    sdkOptions.hooks = { PreToolUse: [{ hooks: [sourceOnlyHook(precomputed.projectDir)] }] };
  }
  if (opts.captureRaw) captureJson(runDir, "generation-config.json", {
    version: 1, sourceOnly: !!opts.sourceOnly, sourceInventory: inventory,
    providers: active.map(p => ({ id: p.id, phase: p.phase })),
    prompt: orchestratorPrompt, agent: agentDef, outputFormat: sdkOptions.outputFormat,
    requestedModel: sdkOptions.model, maxBudgetUsd: sdkOptions.maxBudgetUsd, maxTurns: sdkOptions.maxTurns,
    modelOverrides: Object.fromEntries(["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "FORGE_PROOF_CLASSIFIER_MODEL"].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    billingNote: "SDK-reported generation cost; excludes the separate blueprint classifier call and is not independently reconciled provider billing.",
  });
  const observedModels = new Set<string>();
  let completionStatus = "no-result";
  let modelUsage: unknown = null;
  try {
  for await (const message of query({ prompt: orchestratorPrompt, options: sdkOptions })) {
    handleMessage(message);
    if (message.type === "assistant" && message.message?.model) observedModels.add(message.message.model);

    // Capture the final structured result
    if (message?.type === "result") {
      completionStatus = message.subtype;
      modelUsage = (message as any).modelUsage ?? null;
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

  } catch (error) {
    if (opts.captureRaw) captureJson(runDir, "generation-failure.json", { status: "query-threw", errorType: error instanceof Error ? error.name : "unknown", observedModels: [...observedModels] });
    throw error;
  }
  if (opts.captureRaw) {
    captureJson(runDir, "raw-agent-output.json", rawModel);
    captureJson(runDir, "generation-result.json", { completionStatus, parseSucceeded: Array.isArray(rawModel?.threats), observedModels: [...observedModels], modelUsage, sdkReportedCostUsd: costUsd, durationMs, numTurns });
  }

  // A partial-recovery parse can return an object without a threats array;
  // everything downstream assumes it is iterable.
  if (!rawModel || typeof rawModel !== "object") {
    rawModel = {};
  }
  rawModel.contractType ??= "other";
  rawModel.actors = Array.isArray(rawModel.actors) ? rawModel.actors : [];
  rawModel.assets = Array.isArray(rawModel.assets) ? rawModel.assets : [];
  rawModel.trustBoundaries = Array.isArray(rawModel.trustBoundaries)
    ? rawModel.trustBoundaries
    : [];
  rawModel.threats = Array.isArray(rawModel.threats) ? rawModel.threats : [];

  if (costUsd > 0) {
    console.log(`\n  Agent completed: ${numTurns} turns, $${costUsd.toFixed(2)}, ${(durationMs / 1000).toFixed(1)}s`);
  }

  if (opts.captureRaw) captureJson(runDir, "raw-findings.json", rawModel);

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

  if (opts.captureRaw) captureJson(runDir, "pre-synthesis.json", rawModel);

  // Run synthesis filter providers (anti-slop, self-contradiction, dedup, ranking, custom)
  for (const filter of synthesisFilterProviders(active)) {
    const before = opts.captureRaw ? structuredClone(rawModel.threats) : undefined;
    const started = performance.now();
    rawModel.threats = filter.apply(rawModel.threats, precomputed);
    if (opts.captureRaw) captureStage(runDir, filter.id, before, rawModel.threats, performance.now() - started);
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
      // Providers report their own sourceKey; deduplicate so the list reflects
      // what actually ran rather than repeating hardcoded entries.
      sourcesQueried: [
        ...new Set([
          ...precomputeResults.map((r) => r.sourceKey),
          ...(precomputed.onChain ? ["etherscan-v2"] : []),
          ...enrichmentSources,
        ]),
      ].filter(Boolean),
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

function buildOrchestratorPrompt(pre: PrecomputedAnalysis): string {
  const srcDir = resolveSrcDir(pre.projectDir);
  return `You are Forge Proof's threat modeling orchestrator.

Your job is to delegate to the **threat-modeler** agent, which will deeply explore the smart contracts in ${pre.projectDir}/${srcDir}/ and produce a structured threat model as JSON.

## Instructions

1. Delegate to the **threat-modeler** agent with this brief:
   "Analyze all smart contracts in ${pre.projectDir}/${srcDir}/. Produce a complete threat model as JSON following your output format instructions. Use the pre-computed code map and on-chain data to guide your exploration. Every threat must include a TRACE."

2. When the threat-modeler returns its JSON output, present it as your final response.

3. Do NOT modify the JSON. Do NOT add commentary. Just output the raw JSON the agent produced.

Important: The threat-modeler agent has all the context it needs (AST structural data, Etherscan data, analysis patterns). Just delegate and return the result.

The Task tool is SYNCHRONOUS: it does not return until the agent has completely
finished, and what it returns IS the agent's full output. Nothing runs in the
background and there is nothing to wait for or poll. Never say the agent "is
running" or that you will "wait for it" — by then it has already finished and
you are holding its result. Never end your turn straight after a Task call;
pass the returned JSON to the StructuredOutput tool.`;
}

// ---------------------------------------------------------------------------
// Parse agent output into structured data
// ---------------------------------------------------------------------------

/**
 * Scan from an opening bracket to its matching close, skipping JSON string
 * literals so brackets inside strings are not counted. Returns undefined when
 * the brackets never balance.
 */
function extractBracketed(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

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

  // Strategy 4: Extract just the threats array and wrap it. Locate the key,
  // then scan to the matching `]` with a depth counter so trailing text (and
  // nested arrays) cannot over-capture.
  const threatsKey = output.indexOf('"threats"');
  if (threatsKey !== -1) {
    const arrayStart = output.indexOf("[", output.indexOf(":", threatsKey));
    const threatsJson = arrayStart === -1 ? undefined : extractBracketed(output, arrayStart);
    if (threatsJson) {
      try {
        const threats = JSON.parse(threatsJson);
        console.log(`  Recovered ${threats.length} threat(s) from partial JSON.`);
        return { contractType: "other", actors: [], assets: [], trustBoundaries: [], threats };
      } catch { /* continue */ }
    }
  }

  console.warn(
    "  Warning: Could not parse agent output as JSON. Creating empty threat model."
  );
  console.warn(`  First 500 chars: ${output.slice(0, 500)}`);
  return null;
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

  // Tool results arrive as `user` messages with tool_result content blocks;
  // there is no top-level "tool_result" message type.
  if (message.type === "user" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        console.error(`  [ERROR] ${text.slice(0, 300)}`);
      }
    }
  }

  // Real failure subtypes are error_during_execution / error_max_turns /
  // error_max_budget_usd / error_max_structured_output_retries — never "error".
  if (message.type === "result" && message.subtype !== "success") {
    console.error(
      `\n  ${message.subtype}: ${message.error || "see output above"}`
    );
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
