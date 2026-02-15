/**
 * Pre-computation module — runs static analysis tools and optionally fetches
 * on-chain data before the threat modeler agent starts.
 *
 * Operates directly on the user's Foundry project (no temp scaffolding).
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync, rmSync } from "fs";
import { join } from "path";
import type {
  PrecomputedAnalysis,
  StructuralAnalysis,
  ArchitecturalBlueprint,
  OnChainProfile,
  ValueFlow,
} from "./types.js";
import { analyzeFromAST } from "./ast-analysis.js";
import { buildBlueprint } from "./architecture-analyzer.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function precomputeAnalysis(
  projectDir: string,
  opts?: {
    address?: string;
    chainId?: number;
    etherscanApiKey?: string;
  }
): Promise<PrecomputedAnalysis> {
  validateFoundryProject(projectDir);

  // Build with --build-info --force to get a single build-info file with all
  // solc ASTs. Without --force, incremental builds produce fragmented build-info
  // files that lack the AST data we need.
  console.log("  Building Foundry project (with build-info for AST)...");
  const biDir = join(projectDir, "out", "build-info");
  try {
    // Remove stale build-info to get a single file with full AST data.
    // Incremental builds produce fragmented files without output.sources.
    if (existsSync(biDir)) {
      rmSync(biDir, { recursive: true, force: true });
      console.log("  Cleared stale build-info.");
    }
    execSync("forge build --build-info --force > /dev/null 2>&1", {
      cwd: projectDir,
      timeout: 300_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const biCount = existsSync(biDir) ? readdirSync(biDir).length : 0;
    console.log(`  Build complete. ${biCount} build-info file(s).`);
  } catch (e: any) {
    console.warn(`  Warning: forge build failed: ${e.message?.slice(0, 100)}`);
  }

  // 2. Structural analysis from solc AST — MUST run immediately after build,
  //    before any forge inspect calls which corrupt build-info files.
  console.log("  Analyzing solc AST from build artifacts...");
  const structural: StructuralAnalysis | undefined = analyzeFromAST(projectDir);
  if (structural) {
    console.log(
      `  AST analysis: ${Object.keys(structural.functionSummary).length} functions, ` +
        `${Object.keys(structural.callGraph).length} call graph entries, ` +
        `${Object.keys(structural.stateVarMap).length} state variables, ` +
        `${Object.keys(structural.inheritance).length} inheritance relations`
    );
  } else {
    console.log("  Warning: AST analysis produced no results.");
  }

  // 1. forge inspect (always available)
  console.log("  Running forge inspect...");
  const contracts = listContracts(projectDir);
  const abi: Record<string, any[]> = {};
  const storageLayout: Record<string, any> = {};
  const methodIds: Record<string, Record<string, string>> = {};

  for (const name of contracts) {
    try {
      abi[name] = JSON.parse(
        execSync(`forge inspect ${name} abi --json`, {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
      );
    } catch {
      /* contract may not be inspectable */
    }
    try {
      storageLayout[name] = JSON.parse(
        execSync(`forge inspect ${name} storageLayout --json`, {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
      );
    } catch {
      /* skip */
    }
    try {
      methodIds[name] = JSON.parse(
        execSync(`forge inspect ${name} methodIdentifiers --json`, {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
      );
    } catch {
      /* skip */
    }
  }

  console.log(`  Inspected ${contracts.length} contract(s): ${contracts.join(", ")}`);

  // Structural analysis was computed in step 2 above (before forge inspect).

  // 2b. Build architectural blueprint from structural analysis
  let blueprint: ArchitecturalBlueprint | undefined;
  if (structural) {
    console.log("  Building architectural blueprint...");
    blueprint = buildBlueprint(structural, abi);
    console.log(
      `  Blueprint: classified as "${blueprint.classification.type}" (${blueprint.classification.confidence} confidence), ` +
        `${blueprint.attackSurface.length} functions scored, ` +
        `${blueprint.inferredInvariants.length} invariants inferred, ` +
        `${blueprint.investigationQuestions.length} investigation questions`
    );
    if (blueprint.patternFindings.ceiViolations.length > 0) {
      console.log(
        `  CEI violations pre-detected: ${blueprint.patternFindings.ceiViolations.length}`
      );
    }
    if (blueprint.patternFindings.valueFlowPaths.filter((p) => !p.checksActualReceived).length > 0) {
      console.log(
        `  Value flow paths without balance check: ${blueprint.patternFindings.valueFlowPaths.filter((p) => !p.checksActualReceived).length}`
      );
    }
  }

  // 3. Etherscan v2 (if address provided)
  let onChain: OnChainProfile | undefined;
  if (opts?.address && opts.etherscanApiKey) {
    console.log(`  Fetching on-chain data for ${opts.address}...`);
    onChain = await fetchOnChainProfile(
      opts.address,
      opts.chainId || 1,
      opts.etherscanApiKey,
      // Use first contract's ABI for decoding
      Object.values(abi)[0] || []
    );
    console.log(
      `  Etherscan v2: ${Object.keys(onChain.functionCallFrequency).length} functions, ` +
        `${onChain.topCallers.length} unique callers`
    );
  }

  return { projectDir, abi, storageLayout, methodIds, structural, blueprint, onChain };
}

// ---------------------------------------------------------------------------
// Foundry project validation
// ---------------------------------------------------------------------------

function validateFoundryProject(projectDir: string): void {
  if (!existsSync(join(projectDir, "foundry.toml"))) {
    throw new Error(
      `Not a Foundry project: ${projectDir}\n` +
        `  Expected foundry.toml at project root.\n` +
        `  Usage: forge-proof threat-model <path-to-foundry-project>`
    );
  }
}

// ---------------------------------------------------------------------------
// Contract discovery via forge build output
// ---------------------------------------------------------------------------

function listContracts(projectDir: string): string[] {
  // Prefer scanning the out/ directory so we can filter by source path.
  // Only include contracts whose .sol file is under src/ (not lib/, test/, script/).
  const fromOut = listContractsFromOut(projectDir);
  if (fromOut.length > 0) return fromOut;

  // Fallback: parse forge build --names (includes everything)
  try {
    const output = execSync("forge build --names 2>/dev/null", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- "))
      .map((l) => l.trimStart().replace(/^- /, "").trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function listContractsFromOut(projectDir: string): string[] {
  const outDir = join(projectDir, "out");
  if (!existsSync(outDir)) return [];

  // Read foundry.toml to find the source directory (defaults to "src")
  let srcDir = "src";
  try {
    const toml = readFileSync(join(projectDir, "foundry.toml"), "utf-8");
    const srcMatch = toml.match(/^\s*src\s*=\s*"([^"]+)"/m);
    if (srcMatch) srcDir = srcMatch[1];
  } catch { /* use default */ }

  // Collect all .sol files under src/ (not lib/, test/, script/)
  const srcSolFiles = new Set<string>();
  collectSolFiles(join(projectDir, srcDir), srcSolFiles);

  const names: string[] = [];
  let skippedCount = 0;
  for (const entry of readdirSync(outDir)) {
    if (entry.endsWith(".sol") && srcSolFiles.has(entry)) {
      const subDir = join(outDir, entry);
      try {
        for (const file of readdirSync(subDir)) {
          if (file.endsWith(".json")) {
            // Skip interfaces and libraries — no executable logic to threat-model
            if (isInterfaceOrLibrary(join(subDir, file))) {
              skippedCount++;
              continue;
            }
            names.push(file.replace(".json", ""));
          }
        }
      } catch { /* skip */ }
    }
  }
  if (skippedCount > 0) {
    console.log(`  Skipped ${skippedCount} interface/library artifact(s).`);
  }
  return names;
}

/**
 * Detect interfaces and libraries from compiled artifacts.
 * - Interfaces: bytecode "0x" (len ≤ 2), no storage entries
 * - Libraries: tiny bytecode (< 500 chars), no storage entries
 * - Abstract storage contracts are KEPT (bytecode "0x" but have storage)
 */
function isInterfaceOrLibrary(artifactPath: string): boolean {
  try {
    const data = JSON.parse(readFileSync(artifactPath, "utf-8"));
    const bytecode: string = data.bytecode?.object || "";
    const storageEntries: number = data.storageLayout?.storage?.length || 0;
    if (storageEntries > 0) return false; // has storage → keep (e.g. abstract storage contracts)
    if (bytecode.length <= 2) return true;  // interface (bytecode "0x" or empty)
    if (bytecode.length < 500) return true; // library (tiny bytecode, no storage)
    return false;
  } catch {
    return false;
  }
}

function collectSolFiles(dir: string, result: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectSolFiles(fullPath, result);
      } else if (entry.endsWith(".sol")) {
        result.add(entry);
      }
    } catch { /* skip */ }
  }
}

// ---------------------------------------------------------------------------
// Etherscan v2 integration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Etherscan v2 integration
// ---------------------------------------------------------------------------

const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

async function fetchOnChainProfile(
  address: string,
  chainId: number,
  apiKey: string,
  _abi: any[]
): Promise<OnChainProfile> {
  const profile: OnChainProfile = {
    address,
    chainId,
    functionCallFrequency: {},
    topCallers: [],
    valueFlows: [],
    failedTxPatterns: [],
    adminActions: [],
    parameterRanges: {},
  };

  // 1. Fetch normal transactions (last 500)
  const txs = await etherscanGet(chainId, apiKey, {
    module: "account",
    action: "txlist",
    address,
    startblock: "0",
    endblock: "99999999",
    sort: "desc",
    page: "1",
    offset: "500",
  });

  if (!Array.isArray(txs)) return profile;

  // 2. Function call frequency
  const funcCounts: Record<string, number> = {};
  const callerCounts: Record<string, number> = {};
  const failedCounts: Record<string, number> = {};
  const valueTxs: Array<{ tx: any; value: bigint }> = [];

  for (const tx of txs) {
    const funcName = tx.functionName || tx.methodId || "unknown";
    funcCounts[funcName] = (funcCounts[funcName] || 0) + 1;
    callerCounts[tx.from] = (callerCounts[tx.from] || 0) + 1;

    if (tx.isError === "1") {
      failedCounts[funcName] = (failedCounts[funcName] || 0) + 1;
    }

    const value = BigInt(tx.value || "0");
    if (value > 0n) {
      valueTxs.push({ tx, value });
    }
  }

  profile.functionCallFrequency = funcCounts;

  // 3. Top callers
  const callerEntries = Object.entries(callerCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20);
  profile.topCallers = callerEntries.map(([addr, count]) => ({
    address: addr,
    callCount: count,
    isContract: false, // would need getcode check, skip for now
  }));

  // 4. Fetch internal txs for top value transactions
  valueTxs.sort((a, b) => (b.value > a.value ? 1 : -1));
  const topValueTxs = valueTxs.slice(0, 20);

  for (const { tx, value } of topValueTxs) {
    // Rate limit: 3 calls/sec on free tier
    await sleep(350);

    const internalTxs = await etherscanGet(chainId, apiKey, {
      module: "account",
      action: "txlistinternal",
      txhash: tx.hash,
    });

    const flow: ValueFlow = {
      txHash: tx.hash,
      functionName: tx.functionName || tx.methodId || "unknown",
      value: value.toString(),
      internalTransfers: Array.isArray(internalTxs)
        ? internalTxs.map((itx: any) => ({
            from: itx.from,
            to: itx.to,
            value: itx.value,
          }))
        : [],
    };
    profile.valueFlows.push(flow);
  }

  // 5. Failed tx patterns
  profile.failedTxPatterns = Object.entries(failedCounts)
    .filter(([, count]) => count > 0)
    .map(([funcName, count]) => ({ functionName: funcName, count }));

  // 6. Parameter ranges from tx values (simplified — just ETH values per function)
  const funcValues: Record<string, bigint[]> = {};
  for (const { tx, value } of valueTxs) {
    const funcName = tx.functionName || tx.methodId || "unknown";
    if (!funcValues[funcName]) funcValues[funcName] = [];
    funcValues[funcName].push(value);
  }
  for (const [funcName, values] of Object.entries(funcValues)) {
    values.sort((a, b) => (a > b ? 1 : -1));
    profile.parameterRanges[funcName] = {
      min: values[0].toString(),
      max: values[values.length - 1].toString(),
      median: values[Math.floor(values.length / 2)].toString(),
    };
  }

  return profile;
}

async function etherscanGet(
  chainId: number,
  apiKey: string,
  params: Record<string, string>
): Promise<any> {
  const url = new URL(ETHERSCAN_V2_BASE);
  url.searchParams.set("chainid", chainId.toString());
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const response = execSync(`curl -s "${url.toString()}"`, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const json = JSON.parse(response);
    if (json.status === "1" && json.result) {
      return json.result;
    }
    return [];
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
