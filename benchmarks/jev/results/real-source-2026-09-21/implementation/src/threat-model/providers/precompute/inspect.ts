/**
 * Forge Inspect PrecomputeProvider — runs `forge inspect` for ABI,
 * storage layout, and method identifiers on each discovered contract.
 *
 * Uses listContracts() from precompute.ts for contract discovery.
 */

import { execSync } from "child_process";
import type {
  PrecomputeProvider,
  PrecomputeContext,
  PrecomputeResult,
} from "../types.js";
import { listContracts } from "../../precompute.js";

export const inspectProvider: PrecomputeProvider = {
  id: "inspect",
  name: "Forge Inspect",
  phase: "precompute",
  flag: "inspect",
  flagDescription: "Run forge inspect for ABI, storage layout, and method IDs",
  defaultEnabled: true,

  async run(ctx: PrecomputeContext): Promise<PrecomputeResult> {
    console.log("  Running forge inspect...");
    const contracts = listContracts(ctx.projectDir);
    const abi: Record<string, any[]> = {};
    const storageLayout: Record<string, any> = {};
    const methodIds: Record<string, Record<string, string>> = {};

    for (const name of contracts) {
      try {
        abi[name] = JSON.parse(
          execSync(`forge inspect ${name} abi --json`, {
            cwd: ctx.projectDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }),
        );
      } catch {
        /* contract may not be inspectable */
      }
      try {
        storageLayout[name] = JSON.parse(
          execSync(`forge inspect ${name} storageLayout --json`, {
            cwd: ctx.projectDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }),
        );
      } catch {
        /* skip */
      }
      try {
        methodIds[name] = JSON.parse(
          execSync(`forge inspect ${name} methodIdentifiers --json`, {
            cwd: ctx.projectDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }),
        );
      } catch {
        /* skip */
      }
    }

    console.log(
      `  Inspected ${contracts.length} contract(s): ${contracts.join(", ")}`,
    );

    return {
      outputPaths: [],
      agentPromptSection: "",
      sourceKey: "forge-inspect",
      data: { abi, storageLayout, methodIds },
    };
  },
};
