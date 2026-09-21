/**
 * Solodit API integration — searches the Solodit database (50K+ audit findings)
 * for historical vulnerabilities matching the detected threat categories.
 *
 * Used during the synthesis phase to enrich code-level threats with historical evidence.
 */

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

  if (!soloditKey) {
    console.error(
      "Solodit: API key required — pass --solodit-key or set SOLODIT_API_KEY."
    );
    return results;
  }

  // Build search queries from contract type + categories
  const queries = buildSearchQueries(contractType, categories);

  for (const [category, keywords] of queries) {
    const findings: SoloditFinding[] = [];

    for (const keyword of keywords) {
      try {
        console.log(`    Solodit query: "${keyword}"`);
        const searchResults = await querySolodit(keyword, soloditKey);
        findings.push(...searchResults);
      } catch (err: any) {
        console.error(
          `    Solodit query failed: ${err?.message ?? String(err)}`
        );
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
    // Normalize: "OracleManipulation" → "oracle-manipulation", "Reentrancy" → "reentrancy"
    const normalized = category
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase() as ThreatCategory;
    const baseKeywords = categoryKeywords[normalized] || categoryKeywords[category] || [category];
    const combined = typeKeyword
      ? baseKeywords.map((kw) => `${typeKeyword} ${kw}`)
      : baseKeywords;
    queries.set(category, combined);
  }

  return queries;
}

/**
 * Cyfrin Solodit Findings API endpoint.
 *
 * POST with the X-Cyfrin-API-Key header; the key is required (a missing key
 * returns HTTP 401).
 */
const SOLODIT_FINDINGS_ENDPOINT =
  "https://solodit.cyfrin.io/api/v1/solodit/findings";

/**
 * Query the Solodit Findings API for findings matching a keyword.
 *
 * Fails loudly: a missing key or a failed request is logged and yields no
 * findings, rather than being reported as a silent success.
 */
async function querySolodit(
  keyword: string,
  soloditKey?: string
): Promise<SoloditFinding[]> {
  if (!soloditKey) {
    console.error(
      "Solodit: API key required — pass --solodit-key or set SOLODIT_API_KEY."
    );
    return [];
  }

  try {
    const response = await fetch(SOLODIT_FINDINGS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cyfrin-API-Key": soloditKey,
      },
      body: JSON.stringify({
        page: 1,
        pageSize: 5,
        filters: { keywords: keyword, impact: ["HIGH", "MEDIUM"] },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.error(`Solodit: request failed (HTTP ${response.status}).`);
      return [];
    }

    const json = (await response.json()) as { findings?: any[] };
    const items = Array.isArray(json.findings) ? json.findings : [];
    return items.map((item: any) => ({
      title: item.title || "Unknown",
      severity: item.impact || "Unknown",
      description: (item.summary || item.content || "").slice(0, 500),
      url: item.source_link || undefined,
    }));
  } catch (err: any) {
    console.error(`Solodit: request error — ${err?.message ?? String(err)}`);
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
