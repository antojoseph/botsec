/**
 * Provider registry — the single source of truth for all pluggable providers.
 *
 * To add a new provider:
 * 1. Create a file implementing one of the Provider interfaces
 * 2. Import it here
 * 3. Add it to ALL_PROVIDERS
 *
 * The CLI flag auto-appears from the provider's ProviderMeta declaration.
 */

import type {
  Provider,
  PrecomputeProvider,
  AgentPassProvider,
  EnrichmentProvider,
  SynthesisFilterProvider,
  OutputFormatProvider,
} from "./types.js";

// ─── Built-in providers ───────────────────────────────────────────────────

// ─── Default-on precompute providers (order matters: ast → inspect → blueprint) ─
import { astProvider } from "./precompute/ast.js";
import { inspectProvider } from "./precompute/inspect.js";
import { blueprintProvider } from "./precompute/blueprint.js";
import { etherscanProvider } from "./precompute/etherscan.js";

// ─── Opt-in enrichment providers ──────────────────────────────────────────
import { soloditProvider } from "./enrichment/solodit.js";

// ─── Default-on synthesis filters (order matters: anti-slop → contradiction → dedup → ranking) ─
import { antiSlopProvider } from "./filters/anti-slop.js";
import { selfContradictionProvider } from "./filters/self-contradiction.js";
import { dedupProvider } from "./filters/dedup.js";
import { rankingProvider } from "./filters/ranking.js";

// Future examples:
// import { slitherProvider } from "./precompute/slither.js";
// import { code4renaProvider } from "./enrichment/code4rena.js";
// import { sarifProvider } from "./output/sarif.js";

const ALL_PROVIDERS: Provider[] = [
  // PrecomputeProviders — registration order = execution order
  astProvider,
  inspectProvider,
  blueprintProvider,
  etherscanProvider,
  // EnrichmentProviders
  soloditProvider,
  // SynthesisFilterProviders — registration order = execution order
  antiSlopProvider,
  selfContradictionProvider,
  dedupProvider,
  rankingProvider,
];

// ─── Typed getters ────────────────────────────────────────────────────────

export function allProviders(): readonly Provider[] {
  return ALL_PROVIDERS;
}

export function precomputeProviders(active: Provider[]): PrecomputeProvider[] {
  return active.filter(
    (p): p is PrecomputeProvider => p.phase === "precompute",
  );
}

export function agentPassProviders(active: Provider[]): AgentPassProvider[] {
  return active.filter(
    (p): p is AgentPassProvider => p.phase === "agent-pass",
  );
}

export function enrichmentProviders(active: Provider[]): EnrichmentProvider[] {
  return active.filter(
    (p): p is EnrichmentProvider => p.phase === "enrichment",
  );
}

export function synthesisFilterProviders(
  active: Provider[],
): SynthesisFilterProvider[] {
  return active.filter(
    (p): p is SynthesisFilterProvider => p.phase === "synthesis-filter",
  );
}

export function outputFormatProviders(
  active: Provider[],
): OutputFormatProvider[] {
  return active.filter(
    (p): p is OutputFormatProvider => p.phase === "output",
  );
}
