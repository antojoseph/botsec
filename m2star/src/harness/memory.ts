/**
 * Persistent Memory — tiered institutional knowledge store.
 *
 * Three tiers:
 *   session — in-memory only, cleared on exit
 *   project — persisted to <memoryDir>/project.json
 *   global  — persisted to <memoryDir>/global.json
 *
 * Auto-learn: entries accessed frequently bubble up to higher tiers.
 */

import fs from "fs";
import path from "path";
import { MemoryEntry, MemoryStore, MemoryTier } from "../types.js";

function now(): string {
  return new Date().toISOString();
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function createMemoryStore(memoryDir: string): MemoryStore {
  fs.mkdirSync(memoryDir, { recursive: true });

  const stores: Record<MemoryTier, Map<string, MemoryEntry>> = {
    session: new Map(),
    project: new Map(),
    global: new Map(),
  };

  // Load persisted tiers
  for (const tier of ["project", "global"] as MemoryTier[]) {
    const filePath = path.join(memoryDir, `${tier}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as MemoryEntry[];
        for (const entry of data) {
          stores[tier].set(entry.key, entry);
        }
      } catch {
        // corrupt file — start fresh
      }
    }
  }

  function persist(tier: MemoryTier): void {
    if (tier === "session") return;
    const filePath = path.join(memoryDir, `${tier}.json`);
    const entries = Array.from(stores[tier].values());
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
  }

  /** Auto-promote: if a session entry is accessed >3 times, copy to project */
  function maybePromote(entry: MemoryEntry): void {
    if (entry.tier === "session" && entry.accessCount > 3) {
      const promoted: MemoryEntry = { ...entry, tier: "project", updatedAt: now() };
      stores.project.set(entry.key, promoted);
      persist("project");
    } else if (entry.tier === "project" && entry.accessCount > 10) {
      const promoted: MemoryEntry = { ...entry, tier: "global", updatedAt: now() };
      stores.global.set(entry.key, promoted);
      persist("global");
    }
  }

  return {
    get(key: string, tier?: MemoryTier): unknown {
      const searchTiers: MemoryTier[] = tier
        ? [tier]
        : ["session", "project", "global"];

      for (const t of searchTiers) {
        const entry = stores[t].get(key);
        if (entry !== undefined) {
          entry.accessCount++;
          entry.updatedAt = now();
          maybePromote(entry);
          return entry.value;
        }
      }
      return undefined;
    },

    set(key: string, value: unknown, tier: MemoryTier = "session", tags: string[] = []): void {
      const existing = stores[tier].get(key);
      const entry: MemoryEntry = {
        id: existing?.id ?? makeId(),
        tier,
        key,
        value,
        tags,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        accessCount: existing?.accessCount ?? 0,
      };
      stores[tier].set(key, entry);
      persist(tier);
    },

    search(query: string, tier?: MemoryTier): MemoryEntry[] {
      const searchTiers: MemoryTier[] = tier
        ? [tier]
        : ["session", "project", "global"];
      const q = query.toLowerCase();
      const results: MemoryEntry[] = [];

      for (const t of searchTiers) {
        for (const entry of stores[t].values()) {
          const matchesKey = entry.key.toLowerCase().includes(q);
          const matchesTag = entry.tags.some((tag) => tag.toLowerCase().includes(q));
          const matchesValue =
            typeof entry.value === "string" && entry.value.toLowerCase().includes(q);
          if (matchesKey || matchesTag || matchesValue) {
            results.push(entry);
          }
        }
      }
      return results;
    },

    list(tier?: MemoryTier): MemoryEntry[] {
      const searchTiers: MemoryTier[] = tier
        ? [tier]
        : ["session", "project", "global"];
      const results: MemoryEntry[] = [];
      for (const t of searchTiers) {
        results.push(...stores[t].values());
      }
      return results.sort((a, b) => b.accessCount - a.accessCount);
    },

    snapshot(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const tier of ["global", "project", "session"] as MemoryTier[]) {
        for (const [key, entry] of stores[tier].entries()) {
          // global overrides project overrides session
          out[key] = entry.value;
        }
      }
      return out;
    },
  };
}
