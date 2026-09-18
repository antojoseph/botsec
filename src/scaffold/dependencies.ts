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

export interface CredentialStatus {
  ok: boolean;
  /** Human-readable description of the credential source that was found. */
  source: string;
}

/**
 * Resolve how the Claude Agent SDK will authenticate.
 *
 * ANTHROPIC_API_KEY is only one of several valid options, and requiring it
 * outright breaks every other supported path. In particular, LLM gateways such
 * as OpenRouter require ANTHROPIC_API_KEY to be *explicitly empty* while the
 * credential travels in ANTHROPIC_AUTH_TOKEN, so a naive truthiness check on
 * the API key rejects the very configuration the gateway documents.
 */
export function checkCredentials(): CredentialStatus {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;

  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return { ok: true, source: "Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK)" };
  }
  if (process.env.CLAUDE_CODE_USE_VERTEX === "1") {
    return { ok: true, source: "Google Vertex AI (CLAUDE_CODE_USE_VERTEX)" };
  }
  if (authToken) {
    return {
      ok: true,
      source: baseUrl
        ? `ANTHROPIC_AUTH_TOKEN via gateway ${baseUrl}`
        : "ANTHROPIC_AUTH_TOKEN",
    };
  }
  if (apiKey) {
    return {
      ok: true,
      source: baseUrl ? `ANTHROPIC_API_KEY via ${baseUrl}` : "ANTHROPIC_API_KEY",
    };
  }
  // No env credential. The SDK can still authenticate from an `ant auth login`
  // profile or a Claude Code subscription, so this is a warning, not a failure.
  return { ok: false, source: "none found in environment" };
}

export const CREDENTIAL_HELP =
  "  Set one of:\n" +
  "    export ANTHROPIC_API_KEY=sk-ant-...            # Anthropic API\n" +
  "    export ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=...   # LLM gateway (e.g. OpenRouter)\n" +
  "    export CLAUDE_CODE_USE_BEDROCK=1              # Amazon Bedrock\n" +
  "    export CLAUDE_CODE_USE_VERTEX=1               # Google Vertex AI\n" +
  "  ...or sign in with `ant auth login` / a Claude Code subscription.";

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
