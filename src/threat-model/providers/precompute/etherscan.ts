/**
 * Etherscan v2 PrecomputeProvider — fetches on-chain transaction data
 * and builds an activity profile for the target contract.
 *
 * Activated automatically when --address is provided on the CLI.
 * Not auto-registered via the provider flag system (uses top-level flags).
 *
 * The provider sets ctx.precomputed.onChain so that:
 * - The agent prompt includes on-chain data via buildOnChainSection()
 * - rankThreats() can boost priorities for high-activity functions
 * - The ThreatModel output includes the onChainProfile field
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import type {
  PrecomputeProvider,
  PrecomputeContext,
  PrecomputeResult,
} from "../types.js";
import type { OnChainProfile, ValueFlow } from "../../types.js";

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

export const etherscanProvider: PrecomputeProvider = {
  id: "etherscan",
  name: "Etherscan v2",
  phase: "precompute",
  // Not auto-registered — activated via --address in the CLI
  flag: "_etherscan",
  flagDescription:
    "Fetch on-chain transaction data (activated automatically by --address)",

  async run(ctx: PrecomputeContext): Promise<PrecomputeResult> {
    const address = ctx.flagValues["address"] as string;
    const chainId = parseInt((ctx.flagValues["chain"] as string) || "1");
    const apiKey = ctx.flagValues["etherscan-key"] as string;

    if (!address || !apiKey) {
      return { outputPaths: [], agentPromptSection: "", sourceKey: "etherscan-v2" };
    }

    console.log(`  Fetching on-chain data for ${address}...`);

    const firstAbi = Object.values(ctx.precomputed.abi)[0] || [];
    const profile = await fetchOnChainProfile(address, chainId, apiKey, firstAbi);

    // Set on PrecomputedAnalysis so agent prompt + ranking can use it
    ctx.precomputed.onChain = profile;

    console.log(
      `  Etherscan v2: ${Object.keys(profile.functionCallFrequency).length} functions, ` +
        `${profile.topCallers.length} unique callers`,
    );

    // Write to disk for inspection
    const outputPath = join(ctx.forgeProofDir, "etherscan.json");
    writeFileSync(outputPath, JSON.stringify(profile, null, 2), "utf-8");

    return {
      outputPaths: [outputPath],
      // Agent prompt section is empty — buildOnChainSection() in threat-modeler.ts
      // handles prompt injection by reading pre.onChain directly
      agentPromptSection: "",
      sourceKey: "etherscan-v2",
    };
  },
};

// ---------------------------------------------------------------------------
// Etherscan v2 API
// ---------------------------------------------------------------------------

const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

async function fetchOnChainProfile(
  address: string,
  chainId: number,
  apiKey: string,
  _abi: any[],
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
  params: Record<string, string>,
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
