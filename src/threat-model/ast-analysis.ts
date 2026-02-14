/**
 * AST-based structural analysis — extracts call graphs, state variable read/write maps,
 * inheritance trees, and function summaries from Foundry build artifacts.
 *
 * Uses the solc AST embedded in each contract's JSON artifact (out/<File>.sol/<Contract>.json).
 * Zero external dependencies beyond Foundry itself.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import type { SlitherAnalysis } from "./types.js";

// ---------------------------------------------------------------------------
// AST node types (subset of solc compact AST)
// ---------------------------------------------------------------------------

interface ASTNode {
  id: number;
  nodeType: string;
  name?: string;
  src?: string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Global ID map: maps AST node IDs to their definitions across all files
// ---------------------------------------------------------------------------

interface NodeInfo {
  node: ASTNode;
  contractName?: string;
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze all build artifacts in a Foundry project and extract structural data.
 * Returns the same SlitherAnalysis shape so it can drop in as a replacement.
 *
 * Reads ASTs from the build-info file (requires `forge build --build-info`).
 */
export function analyzeFromAST(projectDir: string): SlitherAnalysis | undefined {
  const outDir = join(projectDir, "out");
  if (!existsSync(outDir)) return undefined;

  // Read foundry.toml to find source directory
  let srcDir = "src";
  try {
    const toml = readFileSync(join(projectDir, "foundry.toml"), "utf-8");
    const m = toml.match(/^\s*src\s*=\s*"([^"]+)"/m);
    if (m) srcDir = m[1];
  } catch { /* default */ }

  // Load ASTs from build-info (contains all source ASTs)
  const buildInfoDir = join(outDir, "build-info");
  if (!existsSync(buildInfoDir)) return undefined;

  const globalIdMap = new Map<number, NodeInfo>();
  const sourceContracts: Array<{ sourceFile: string; contractNodes: ASTNode[] }> = [];

  for (const biFile of readdirSync(buildInfoDir)) {
    if (!biFile.endsWith(".json")) continue;

    let buildInfo: any;
    try {
      const content = readFileSync(join(buildInfoDir, biFile), "utf-8");
      buildInfo = JSON.parse(content);
    } catch { continue; }

    const sources = buildInfo.output?.sources;
    if (!sources) continue;

    for (const [sourcePath, sourceData] of Object.entries(sources) as [string, any][]) {
      const ast = sourceData.ast;
      if (!ast) continue;

      // Only process source contracts (under srcDir, not lib/test/script)
      const isSource = sourcePath.startsWith(`${srcDir}/`);

      // Build global ID map from ALL ASTs (need cross-file references)
      walkAST(ast, (node) => {
        if (node.id !== undefined) {
          globalIdMap.set(node.id, { node, sourceFile: sourcePath });
        }
        if (node.nodeType === "ContractDefinition") {
          globalIdMap.set(node.id, { node, contractName: node.name, sourceFile: sourcePath });
        }
      });

      // But only extract structural data from source contracts
      if (isSource) {
        const contractNodes: ASTNode[] = [];
        for (const n of ast.nodes || []) {
          if (n.nodeType === "ContractDefinition") {
            contractNodes.push(n);
          }
        }
        if (contractNodes.length > 0) {
          sourceContracts.push({ sourceFile: sourcePath, contractNodes });
        }
      }
    }
  }

  if (sourceContracts.length === 0) return undefined;

  // Now extract the 4 structural data types
  const callGraph: Record<string, string[]> = {};
  const stateVarMap: Record<string, {
    readBy: string[];
    writtenBy: string[];
    type: string;
    visibility: string;
  }> = {};
  const inheritance: Record<string, string[]> = {};
  const functionSummary: Record<string, {
    visibility: string;
    modifiers: string[];
    stateVarsRead: string[];
    stateVarsWritten: string[];
    externalCalls: string[];
    internalCalls: string[];
  }> = {};

  // State var ID → name mapping for resolving references
  const stateVarIds = new Map<number, { name: string; contractName: string }>();

  for (const { sourceFile, contractNodes } of sourceContracts) {
    for (const contract of contractNodes) {
      const contractName = contract.name || "Unknown";

      // 1. Inheritance
      const bases = (contract.baseContracts || []).map((bc: any) => {
        const baseName = bc.baseName?.name || bc.baseName?.namePath || "Unknown";
        return baseName;
      });
      if (bases.length > 0) {
        inheritance[contractName] = bases;
      }

      // Collect state variables
      const stateVars: ASTNode[] = [];
      const functions: ASTNode[] = [];

      for (const member of contract.nodes || []) {
        if (member.nodeType === "VariableDeclaration" && member.stateVariable) {
          stateVars.push(member);
          const varName = `${contractName}.${member.name}`;
          stateVarIds.set(member.id, { name: varName, contractName });
          if (!stateVarMap[varName]) {
            stateVarMap[varName] = {
              readBy: [],
              writtenBy: [],
              type: member.typeDescriptions?.typeString || "unknown",
              visibility: member.visibility || "internal",
            };
          }
        }
        if (member.nodeType === "FunctionDefinition") {
          functions.push(member);
        }
      }

      // 2. Analyze each function
      for (const func of functions) {
        const funcName = func.name || func.kind || "unnamed";
        const qualifiedName = `${contractName}.${funcName}`;

        // Modifiers
        const modifiers = (func.modifiers || []).map(
          (m: any) => m.modifierName?.name || "unknown"
        );

        // Collect calls, state var reads/writes
        const internalCalls: string[] = [];
        const externalCalls: string[] = [];
        const varsRead = new Set<string>();
        const varsWritten = new Set<string>();

        walkAST(func.body || {}, (node) => {
          // Function calls
          if (node.nodeType === "FunctionCall") {
            const expr = node.expression;
            if (expr?.nodeType === "Identifier") {
              const refId = expr.referencedDeclaration;
              const refInfo = refId ? globalIdMap.get(refId) : undefined;
              const callName = refInfo?.node?.name || expr.name || "unknown";
              if (refInfo?.contractName && refInfo.contractName !== contractName) {
                externalCalls.push(`${refInfo.contractName}.${callName}`);
              } else {
                internalCalls.push(callName);
              }
            } else if (expr?.nodeType === "MemberAccess") {
              const memberName = expr.memberName;
              const refId = expr.referencedDeclaration;
              const refInfo = refId ? globalIdMap.get(refId) : undefined;
              // External call if target is a different contract or via interface
              const targetContract = refInfo?.contractName || "external";
              externalCalls.push(`${targetContract}.${memberName}`);
            }
          }

          // State variable reads (Identifier referencing a state var)
          if (node.nodeType === "Identifier" && node.referencedDeclaration) {
            const varInfo = stateVarIds.get(node.referencedDeclaration);
            if (varInfo) {
              varsRead.add(varInfo.name);
            }
          }

          // State variable writes (Assignment where LHS references state var)
          if (node.nodeType === "Assignment") {
            const lhs = node.leftHandSide;
            if (lhs) {
              const refId = lhs.referencedDeclaration ||
                lhs.baseExpression?.referencedDeclaration;
              const varInfo = refId ? stateVarIds.get(refId) : undefined;
              if (varInfo) {
                varsWritten.add(varInfo.name);
              }
            }
          }

          // Unary operations (++, --)
          if (node.nodeType === "UnaryOperation" && node.prefix !== undefined) {
            const subExpr = node.subExpression;
            if (subExpr?.referencedDeclaration) {
              const varInfo = stateVarIds.get(subExpr.referencedDeclaration);
              if (varInfo) {
                varsWritten.add(varInfo.name);
              }
            }
          }
        });

        // Build function summary
        functionSummary[qualifiedName] = {
          visibility: func.visibility || "internal",
          modifiers,
          stateVarsRead: [...varsRead],
          stateVarsWritten: [...varsWritten],
          externalCalls: [...new Set(externalCalls)],
          internalCalls: [...new Set(internalCalls)],
        };

        // Build call graph
        const allCalls = [
          ...new Set([...internalCalls, ...externalCalls]),
        ];
        if (allCalls.length > 0) {
          callGraph[qualifiedName] = allCalls;
        }

        // Update state var map
        for (const varName of varsRead) {
          if (stateVarMap[varName] && !stateVarMap[varName].readBy.includes(qualifiedName)) {
            stateVarMap[varName].readBy.push(qualifiedName);
          }
        }
        for (const varName of varsWritten) {
          if (stateVarMap[varName] && !stateVarMap[varName].writtenBy.includes(qualifiedName)) {
            stateVarMap[varName].writtenBy.push(qualifiedName);
          }
        }
      }
    }
  }

  return {
    detectors: [], // AST analysis doesn't produce detector findings
    callGraph,
    stateVarMap,
    inheritance,
    functionSummary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkAST(node: any, visitor: (n: ASTNode) => void): void {
  if (!node || typeof node !== "object") return;

  if (node.nodeType) {
    visitor(node as ASTNode);
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walkAST(item, visitor);
      }
    } else if (typeof value === "object" && value !== null) {
      walkAST(value, visitor);
    }
  }
}

function collectSolFileNames(dir: string, result: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectSolFileNames(fullPath, result);
      } else if (entry.endsWith(".sol")) {
        result.add(entry);
      }
    } catch { /* skip */ }
  }
}
