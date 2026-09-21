#!/usr/bin/env node

/**
 * Forge Proof CLI — AI-powered formal verification for smart contracts.
 *
 * Usage:
 *   forge-proof analyze ./contracts/Vault.sol
 *   forge-proof analyze ./src --address 0x1234... --chain 1 --etherscan-key <key>
 */

import { createRequire } from "node:module";
import { Command } from "commander";

// Single source of truth for the version — keeps --version from drifting.
const { version: PKG_VERSION } = createRequire(import.meta.url)("../package.json");
import { analyze } from "./orchestrator.js";
import { generateThreatModel } from "./threat-model/orchestrator.js";
import {
  assertDependencies,
  checkDependencies,
  checkCredentials,
  CREDENTIAL_HELP,
} from "./scaffold/dependencies.js";
import { allProviders } from "./threat-model/providers/registry.js";
import type { Provider } from "./threat-model/providers/types.js";

const BANNER = `
  ___                      ___                 __
 / __\\___  _ __ __ _  ___ / _ \\_ __ ___   ___ / _|
/ _\\/ _ \\| '__/ _\` |/ _ \\ /_)/ '__/ _ \\ / _ \\ |_
/ / | (_) | | | (_| |  __/ ___/| | | (_) | (_) |  _|
\\/   \\___/|_|  \\__, |\\___\\/    |_|  \\___/ \\___/|_|
               |___/
`;

const program = new Command();

program
  .name("forge-proof")
  .description(
    "AI-powered formal verification for smart contracts using the Claude Agent SDK + Halmos"
  )
  .version(PKG_VERSION);

program
  .command("analyze")
  .description("Analyze a smart contract for vulnerabilities with formal verification")
  .argument("<path>", "Path to contract file (.sol) or project directory")
  .option("--address <addr>", "On-chain contract address for transaction analysis")
  .option("--chain <id>", "Chain ID (1=mainnet, 8453=base, 42161=arbitrum)", "1")
  .option(
    "--etherscan-key <key>",
    "Etherscan API key (or set ETHERSCAN_API_KEY env var)"
  )
  .option("--loop <n>", "Halmos loop unrolling bound (default: 3)", "3")
  .option(
    "--solver-timeout <ms>",
    "Halmos SMT solver timeout in ms (default: 10000)",
    "10000"
  )
  .option("--max-turns <n>", "Max agent turns (default: 500)", "500")
  .option("--max-budget <usd>", "Max budget in USD (default: 100)", "100")
  .option("-o, --output <dir>", "Output directory", "forge-proof-output")
  .option(
    "--threat-model <file>",
    "Path to threat model JSON (from threat-model command)"
  )
  .option(
    "--verify-only",
    "Skip exploration, go straight to verification (requires --threat-model)"
  )
  .option(
    "--no-audit-spec",
    "Skip the independent Halmos re-run that flags vacuous properties"
  )
  .option(
    "--mutation-test",
    "Inject bugs into the contract and measure how many the generated spec " +
      "catches. Costs no model tokens (forge + halmos only)."
  )
  .option(
    "--max-mutants <n>",
    "Mutants to run with --mutation-test (default: 10)",
    "10"
  )
  .action(async (contractPath, opts) => {
    console.log(BANNER);
    console.log("  AI-Powered Formal Verification for Smart Contracts\n");

    // Report how the SDK will authenticate. A missing env credential is not
    // fatal — the SDK can still use an `ant auth login` profile.
    const creds = checkCredentials();
    console.log(`  Auth:    ${creds.source}`);
    if (!creds.ok) {
      console.warn(
        "  Warning: no credential found in the environment. Continuing —\n" +
          "  the Agent SDK may still authenticate from a stored profile.\n" +
          CREDENTIAL_HELP + "\n"
      );
    }

    // Check dependencies
    assertDependencies();
    const deps = checkDependencies();
    console.log(
      `  Dependencies: forge=${deps.forge ? "ok" : "MISSING"} ` +
        `halmos=${deps.halmos ? "ok" : "MISSING"} ` +
        `cast=${deps.cast ? "ok" : "missing"}\n`
    );

    console.log(`  Target:  ${contractPath}`);
    if (opts.address) {
      console.log(`  Address: ${opts.address} (chain ${opts.chain})`);
    }
    console.log(`  Halmos:  --loop ${opts.loop} --solver-timeout ${opts.solverTimeout}`);
    if (opts.threatModel) {
      console.log(`  Threat Model: ${opts.threatModel}`);
    }
    console.log(`  Output:  ${opts.output}\n`);

    try {
      await analyze({
        contractPath,
        address: opts.address,
        chainId: opts.chain,
        etherscanApiKey:
          opts.etherscanKey || process.env.ETHERSCAN_API_KEY,
        loopBound: parseInt(opts.loop),
        solverTimeout: parseInt(opts.solverTimeout),
        maxTurns: parseInt(opts.maxTurns),
        maxBudgetUsd: parseFloat(opts.maxBudget),
        outputDir: opts.output,
        threatModelPath: opts.threatModel,
        verifyOnly: !!opts.verifyOnly,
        // commander maps --no-audit-spec to opts.auditSpec === false
        auditSpec: opts.auditSpec !== false,
        mutationTest: !!opts.mutationTest,
        maxMutants: parseInt(opts.maxMutants),
      });
    } catch (err: any) {
      console.error(`\n  Fatal error: ${err.message || err}`);
      process.exit(1);
    }
  });

program
  .command("check")
  .description("Verify that all required dependencies are installed")
  .action(() => {
    console.log(BANNER);
    const deps = checkDependencies();
    console.log("  Dependency check:");
    console.log(`    forge  (Foundry):  ${deps.forge ? "installed" : "MISSING"}`);
    console.log(`    halmos (Halmos):   ${deps.halmos ? "installed" : "MISSING"}`);
    console.log(`    cast   (Foundry):  ${deps.cast ? "installed" : "MISSING"}`);
    const creds = checkCredentials();
    console.log(`    Claude credential: ${creds.source}\n`);
    if (!creds.ok) {
      console.log(CREDENTIAL_HELP + "\n");
    }

    if (!deps.forge || !deps.halmos) {
      console.log("  Install missing tools:");
      if (!deps.forge) {
        console.log(
          "    forge: curl -L https://foundry.paradigm.xyz | bash && foundryup"
        );
      }
      if (!deps.halmos) {
        console.log(
          "    halmos: uv tool install --python 3.12 halmos   (needs Python >= 3.11)"
        );
      }
      process.exit(1);
    }

    console.log("  All dependencies satisfied.\n");
  });

// ─── Threat-model command with auto-registered provider flags ──────────────

const tmCmd = program
  .command("threat-model")
  .option("--capture-raw", "Preserve raw findings and synthesis stage inputs/outputs")
  .option("--source-only", "Restrict model tools to reads within a prepared source workspace")
  .description(
    "Generate a structured threat model for a Foundry project using agentic code exploration"
  )
  .argument(
    "<project-path>",
    "Path to Foundry project directory (must contain foundry.toml)"
  )
  .option(
    "--address <addr>",
    "On-chain contract address (enables Etherscan v2 enrichment)"
  )
  .option("--chain <id>", "Chain ID (1=mainnet, 8453=base, 42161=arbitrum)", "1")
  .option(
    "--etherscan-key <key>",
    "Etherscan API key (or set ETHERSCAN_API_KEY env var)"
  )
  .option("-o, --output <dir>", "Output directory", "forge-proof-output")
  .option("--max-turns <n>", "Max agent turns (default: 200)", "200")
  .option("--max-budget <usd>", "Max budget in USD (default: 50)", "50")
  .option(
    "--allow-npm-install",
    "Permit `npm install` inside the target project. The install runs with " +
      "`--ignore-scripts`, so the target's lifecycle scripts are NOT executed."
  );

// Auto-register provider flags from the registry.
// - Default-on providers get --no-{flag} to disable
// - Opt-in providers get --{flag} to enable
// - _-prefixed flags are programmatically activated (e.g., Etherscan via --address)
for (const provider of allProviders()) {
  if (provider.flag.startsWith("_")) continue;
  if (provider.defaultEnabled) {
    tmCmd.option(`--no-${provider.flag}`, `Disable ${provider.name}`);
  } else {
    tmCmd.option(`--${provider.flag}`, provider.flagDescription);
    if (provider.extraFlags) {
      for (const extra of provider.extraFlags) {
        tmCmd.option(extra.flag, extra.description, extra.defaultValue);
      }
    }
  }
}

tmCmd.action(async (projectPath, opts) => {
  console.log(BANNER);
  console.log("  Threat Model Generation\n");

  const creds = checkCredentials();
  console.log(`  Auth:    ${creds.source}`);
  if (!creds.ok) {
    console.warn(
      "  Warning: no credential found in the environment. Continuing —\n" +
        "  the Agent SDK may still authenticate from a stored profile.\n" +
        CREDENTIAL_HELP + "\n"
    );
  }

  console.log(`  Project: ${projectPath}`);
  if (opts.address) {
    console.log(`  Address: ${opts.address} (chain ${opts.chain})`);
  }
  console.log(`  Output:  ${opts.output}\n`);

  // Determine which providers are enabled:
  // - Default-on: enabled unless --no-{flag} is passed
  // - Opt-in: enabled only when --{flag} is passed
  // - _-prefixed: activated programmatically below
  const enabledProviders: Provider[] = [];
  const providerFlagValues = new Map<string, Record<string, string | boolean>>();

  for (const provider of allProviders()) {
    if (provider.flag.startsWith("_")) continue;

    if (provider.defaultEnabled) {
      // Default-on: include unless --no-{flag} passed.
      //
      // Commander models `--no-ast` as the NEGATION of an `ast` option: it sets
      // opts.ast = false and leaves it undefined/true otherwise. There is no
      // `opts.noAst`. Reading the negated name silently enabled every
      // default-on provider regardless of the flag.
      const flagKey = camelCase(provider.flag);
      if (opts[flagKey] !== false) {
        enabledProviders.push(provider);
      }
    } else {
      // Opt-in: include only if --{flag} passed
      const flagKey = camelCase(provider.flag);
      if (opts[flagKey]) {
        enabledProviders.push(provider);
        const values: Record<string, string | boolean> = {};
        if (provider.extraFlags) {
          for (const extra of provider.extraFlags) {
            const extraName = extractFlagName(extra.flag);
            const extraKey = camelCase(extraName);
            if (opts[extraKey] !== undefined) {
              values[extraName] = opts[extraKey];
            }
          }
        }
        providerFlagValues.set(provider.id, values);
      }
    }
  }

  // Auto-activate Etherscan provider when --address is provided
  if (opts.address) {
    const etherscan = allProviders().find((p) => p.id === "etherscan");
    if (etherscan && !enabledProviders.includes(etherscan)) {
      enabledProviders.push(etherscan);
      providerFlagValues.set("etherscan", {
        address: opts.address,
        chain: opts.chain || "1",
        "etherscan-key": opts.etherscanKey || process.env.ETHERSCAN_API_KEY || "",
      });
    }
  }

  try {
    await generateThreatModel({
      contractPath: projectPath,
      outputDir: opts.output,
      maxTurns: parseInt(opts.maxTurns),
      maxBudgetUsd: parseFloat(opts.maxBudget),
      enabledProviders,
      providerFlagValues,
      allowNpmInstall: !!opts.allowNpmInstall,
      captureRaw: !!opts.captureRaw,
      sourceOnly: !!opts.sourceOnly,
    });
  } catch (err: any) {
    console.error(`\n  Fatal error: ${err.message || err}`);
    process.exit(1);
  }
});

// ─── Helpers for CLI flag name conversion ─────────────────────────────────

/** "solodit-key" → "soloditKey" */
function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** "--solodit-key <key>" → "solodit-key" */
function extractFlagName(flag: string): string {
  const match = flag.match(/^--([^\s<]+)/);
  return match ? match[1] : flag;
}

await program.parseAsync();
