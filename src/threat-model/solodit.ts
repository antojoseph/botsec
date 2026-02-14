/**
 * Solodit API integration — searches the Solodit database (50K+ audit findings)
 * for historical vulnerabilities matching the detected threat categories.
 *
 * Used during the synthesis phase to enrich code-level threats with historical evidence.
 */

import { execSync } from "child_process";
import type { ContractType, ThreatCategory } from "./types.js";

export interface SoloditFinding {
  title: string;
  severity: string;
  description: string;
  url?: string;
}

/**
 * Search Solodit for findings matching the given keywords.
 * Keywords are derived from contractType + threat categories.
 */
export async function searchSolodit(
  contractType: ContractType,
  categories: ThreatCategory[],
  soloditKey?: string
): Promise<Map<ThreatCategory, SoloditFinding[]>> {
  const results = new Map<ThreatCategory, SoloditFinding[]>();

  // Build search queries from contract type + categories
  const queries = buildSearchQueries(contractType, categories);

  for (const [category, keywords] of queries) {
    const findings: SoloditFinding[] = [];

    for (const keyword of keywords) {
      try {
        const searchResults = await querySolodit(keyword, soloditKey);
        findings.push(...searchResults);
      } catch {
        // Skip failed queries
      }

      // Rate limit between queries
      await sleep(500);
    }

    // Deduplicate by title
    const seen = new Set<string>();
    const unique = findings.filter((f) => {
      if (seen.has(f.title)) return false;
      seen.add(f.title);
      return true;
    });

    if (unique.length > 0) {
      results.set(category, unique.slice(0, 5)); // Top 5 per category
    }
  }

  return results;
}

/**
 * Build search keyword pairs from contract type and threat categories.
 */
function buildSearchQueries(
  contractType: ContractType,
  categories: ThreatCategory[]
): Map<ThreatCategory, string[]> {
  const queries = new Map<ThreatCategory, string[]>();

  const typeKeyword = contractType === "other" ? "" : contractType;

  const categoryKeywords: Record<ThreatCategory, string[]> = {
    "access-control": ["access control bypass", "unauthorized"],
    reentrancy: ["reentrancy", "cross-function reentrancy"],
    "oracle-manipulation": ["oracle manipulation", "price manipulation"],
    "flash-loan": ["flash loan attack", "flash loan"],
    arithmetic: ["overflow underflow", "precision loss rounding"],
    "denial-of-service": ["denial of service", "DoS griefing"],
    "front-running": ["front running MEV", "sandwich attack"],
    "token-handling": ["fee on transfer", "rebasing token"],
    upgradeability: ["proxy upgrade", "storage collision"],
    "cross-contract": ["cross contract", "composability"],
    governance: ["governance attack", "voting manipulation"],
    randomness: ["randomness exploit", "predictable random"],
    "unchecked-calls": ["unchecked return", "silent failure"],
    "logic-error": ["logic error", "business logic"],
  };

  for (const category of categories) {
    const baseKeywords = categoryKeywords[category] || [category];
    const combined = typeKeyword
      ? baseKeywords.map((kw) => `${typeKeyword} ${kw}`)
      : baseKeywords;
    queries.set(category, combined);
  }

  return queries;
}

/**
 * Query the Solodit API or MCP server for findings matching a keyword.
 */
async function querySolodit(
  keyword: string,
  _soloditKey?: string
): Promise<SoloditFinding[]> {
  // Try the Solodit MCP server first (if available)
  // Fallback to curl-based search
  try {
    const encoded = encodeURIComponent(keyword);
    const response = execSync(
      `curl -s "https://solodit.cyfrin.io/api/v1/search?query=${encoded}&limit=5" 2>/dev/null`,
      {
        encoding: "utf-8",
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const json = JSON.parse(response);
    if (Array.isArray(json.results || json.data || json)) {
      const items = json.results || json.data || json;
      return items.map((item: any) => ({
        title: item.title || item.name || "Unknown",
        severity: item.severity || item.impact || "Unknown",
        description:
          (item.description || item.content || "").slice(0, 500) || "",
        url: item.url || item.link || undefined,
      }));
    }
  } catch {
    // Solodit API may not be available — this is non-fatal
  }

  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
