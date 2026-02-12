import { execSync } from "child_process";

/**
 * Check that required external tools are installed.
 * Returns an object with availability status for each tool.
 */
export function checkDependencies(): {
  forge: boolean;
  halmos: boolean;
  cast: boolean;
} {
  return {
    forge: isInstalled("forge --version"),
    halmos: isInstalled("halmos --version"),
    cast: isInstalled("cast --version"),
  };
}

function isInstalled(command: string): boolean {
  try {
    execSync(command, { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Print dependency status and exit if critical tools are missing.
 */
export function assertDependencies(): void {
  const deps = checkDependencies();

  if (!deps.forge) {
    console.error(
      "Error: `forge` not found. Install Foundry:\n" +
        "  curl -L https://foundry.paradigm.xyz | bash && foundryup"
    );
    process.exit(1);
  }

  if (!deps.halmos) {
    console.error(
      "Error: `halmos` not found. Install:\n" +
        "  pip install halmos\n" +
        "  # or: uv tool install --python 3.12 halmos"
    );
    process.exit(1);
  }

  if (!deps.cast) {
    console.warn(
      "Warning: `cast` not found. On-chain calldata decoding will be limited."
    );
  }
}
