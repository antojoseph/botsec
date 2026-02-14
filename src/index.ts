#!/usr/bin/env node

/**
 * Forge Proof CLI — AI-powered formal verification for smart contracts.
 *
 * Usage:
 *   forge-proof analyze ./contracts/Vault.sol
 *   forge-proof analyze ./src --address 0x1234... --chain 1 --etherscan-key <key>
 */

import { Command } from "commander";
import { analyze } from "./orchestrator.js";
import { generateThreatModel } from "./threat-model/orchestrator.js";
import { assertDependencies, checkDependencies } from "./scaffold/dependencies.js";

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
    "AI-powered formal verification for smart contracts using Claude Opus + Halmos"
  )
  .version("0.1.0");

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
  .option("-o, --output <dir>", "Output directory", "forge-proof-output")
  .option(
    "--threat-model <file>",
    "Path to threat model JSON (from threat-model command)"
  )
  .action(async (contractPath, opts) => {
    console.log(BANNER);
    console.log("  AI-Powered Formal Verification for Smart Contracts\n");

    // Check API key
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "  Error: ANTHROPIC_API_KEY not set.\n" +
          "  Set it with: export ANTHROPIC_API_KEY=sk-ant-...\n"
      );
      process.exit(1);
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
        outputDir: opts.output,
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
    console.log(
      `    ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET"}\n`
    );

    if (!deps.forge || !deps.halmos) {
      console.log("  Install missing tools:");
      if (!deps.forge) {
        console.log(
          "    forge: curl -L https://foundry.paradigm.xyz | bash && foundryup"
        );
      }
      if (!deps.halmos) {
        console.log("    halmos: pip install halmos");
      }
      process.exit(1);
    }

    console.log("  All dependencies satisfied.\n");
  });

program
  .command("threat-model")
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
  .option(
    "--solodit-key <key>",
    "Solodit API key (or set SOLODIT_API_KEY env var)"
  )
  .option("-o, --output <dir>", "Output directory", "forge-proof-output")
  .option("--max-turns <n>", "Max agent turns (default: 200)", "200")
  .action(async (projectPath, opts) => {
    console.log(BANNER);
    console.log("  Threat Model Generation\n");

    // Check API key
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "  Error: ANTHROPIC_API_KEY not set.\n" +
          "  Set it with: export ANTHROPIC_API_KEY=sk-ant-...\n"
      );
      process.exit(1);
    }

    console.log(`  Project: ${projectPath}`);
    if (opts.address) {
      console.log(`  Address: ${opts.address} (chain ${opts.chain})`);
    }
    console.log(`  Output:  ${opts.output}\n`);

    try {
      await generateThreatModel({
        contractPath: projectPath,
        address: opts.address,
        chainId: opts.chain,
        etherscanApiKey:
          opts.etherscanKey || process.env.ETHERSCAN_API_KEY,
        soloditKey: opts.soloditKey || process.env.SOLODIT_API_KEY,
        outputDir: opts.output,
        maxTurns: parseInt(opts.maxTurns),
      });
    } catch (err: any) {
      console.error(`\n  Fatal error: ${err.message || err}`);
      process.exit(1);
    }
  });

program.parse();
