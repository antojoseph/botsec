/**
 * AST-based structural analysis — extracts call graphs, state variable read/write maps,
 * inheritance trees, and function summaries from Foundry build artifacts.
 *
 * Uses the solc AST embedded in each contract's JSON artifact (out/<File>.sol/<Contract>.json).
 * Zero external dependencies beyond Foundry itself.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import type {
  StructuralAnalysis,
  OperationStep,
  AuthCheck,
  Guard,
  DataDependencyMap,
} from "./types.js";

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
 * Reads ASTs from the build-info file (requires `forge build --build-info`).
 */
export function analyzeFromAST(projectDir: string): StructuralAnalysis | undefined {
  const outDir = join(projectDir, "out");
  if (!existsSync(outDir)) return undefined;

  // Read foundry.toml to find source and test directories
  let srcDir = "src";
  const excludeDirs = new Set(["test", "script", "lib"]);
  try {
    const toml = readFileSync(join(projectDir, "foundry.toml"), "utf-8");
    const srcMatch = toml.match(/^\s*src\s*=\s*['"]([^'"]+)['"]/m);
    if (srcMatch) srcDir = srcMatch[1];
    const testMatch = toml.match(/^\s*test\s*=\s*['"]([^'"]+)['"]/m);
    if (testMatch) excludeDirs.add(testMatch[1]);
    const scriptMatch = toml.match(/^\s*script\s*=\s*['"]([^'"]+)['"]/m);
    if (scriptMatch) excludeDirs.add(scriptMatch[1]);
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

      // Only process source contracts (under srcDir, not lib/test/script/mocks)
      const isSource = sourcePath.startsWith(`${srcDir}/`) &&
        ![...excludeDirs].some((d) => sourcePath.startsWith(`${d}/`));

      // Build global ID map from ALL ASTs (need cross-file references)
      walkAST(ast, (node) => {
        if (node.id !== undefined) {
          globalIdMap.set(node.id, { node, sourceFile: sourcePath });
        }
        if (node.nodeType === "ContractDefinition") {
          globalIdMap.set(node.id, { node, contractName: node.name, sourceFile: sourcePath });
        }
      });

      // But only extract structural data from source contracts (skip interfaces/libraries)
      if (isSource) {
        const contractNodes: ASTNode[] = [];
        for (const n of ast.nodes || []) {
          if (n.nodeType === "ContractDefinition") {
            // Skip interfaces and libraries — no executable logic to threat-model
            if (n.contractKind === "interface" || n.contractKind === "library") continue;
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

  // Extract all structural data types
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

  const operationOrder: Record<string, OperationStep[]> = {};
  const authChecks: Record<string, AuthCheck[]> = {};
  const guardInventory: Record<string, Guard[]> = {};

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

        // Built-in names that are not real function calls
        const BUILTINS = new Set([
          "require", "assert", "revert", "keccak256", "abi",
          "ecrecover", "addmod", "mulmod", "selfdestruct", "blockhash",
        ]);

        walkAST(func.body || {}, (node) => {
          // Function calls
          if (node.nodeType === "FunctionCall") {
            const expr = node.expression;
            if (expr?.nodeType === "Identifier") {
              const refId = expr.referencedDeclaration;
              const refInfo = refId ? globalIdMap.get(refId) : undefined;
              const callName = refInfo?.node?.name || expr.name || "unknown";
              // Skip builtins and event emissions (ErrorDefinition, EventDefinition)
              if (BUILTINS.has(callName)) { /* skip */ }
              else if (refInfo?.node?.nodeType === "EventDefinition") { /* skip events */ }
              else if (refInfo?.node?.nodeType === "ErrorDefinition") { /* skip errors */ }
              else if (refInfo?.contractName && refInfo.contractName !== contractName) {
                externalCalls.push(`${refInfo.contractName}.${callName}`);
              } else {
                internalCalls.push(callName);
              }
            } else if (expr?.nodeType === "FunctionCallOptions") {
              // .call{value: x}(), .send{...}(), etc.
              const inner = expr.expression;
              if (inner?.nodeType === "MemberAccess") {
                externalCalls.push(`low_level.${inner.memberName}`);
              }
            } else if (expr?.nodeType === "MemberAccess") {
              const memberName = expr.memberName;
              const refId = expr.referencedDeclaration;
              const refInfo = refId ? globalIdMap.get(refId) : undefined;
              // Low-level calls (.call, .transfer, .send, .delegatecall)
              const LOW_LEVEL = ["call", "transfer", "send", "delegatecall", "staticcall"];
              if (LOW_LEVEL.includes(memberName)) {
                externalCalls.push(`low_level.${memberName}`);
              } else {
                const targetContract = refInfo?.contractName || "external";
                externalCalls.push(`${targetContract}.${memberName}`);
              }
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

        // --- NEW: Operation ordering (CFG) ---
        const ops = extractOperationOrder(func.body, stateVarIds, globalIdMap, contractName);
        if (ops.length > 0) {
          operationOrder[qualifiedName] = ops;
        }

        // --- NEW: Auth checks (msg.sender conditions) ---
        const auth = extractAuthChecks(func, globalIdMap);
        if (auth.length > 0) {
          authChecks[qualifiedName] = auth;
        }

        // --- NEW: Guard inventory (require/assert/revert) ---
        const guards = extractGuardInventory(func.body);
        if (guards.length > 0) {
          guardInventory[qualifiedName] = guards;
        }
      }
    }
  }

  // --- Post-processing: Data Dependency Analysis ---
  const dataDependency = computeDataDependency(
    sourceContracts,
    stateVarIds,
    globalIdMap,
    functionSummary
  );

  return {
    callGraph,
    stateVarMap,
    inheritance,
    functionSummary,
    operationOrder,
    authChecks,
    guardInventory,
    dataDependency,
  };
}

// ---------------------------------------------------------------------------
// Feature 4: Data Dependency Analysis (transitive variable influence)
// ---------------------------------------------------------------------------

/**
 * Compute per-function and per-contract data dependencies.
 * For each assignment `x = expr(y, z)`, x depends on {y, z}.
 * Transitive: if x depends on y and y depends on z, then x depends on z.
 * Taint sources: msg.sender, msg.value, msg.data, tx.origin, public/external function params.
 */
function computeDataDependency(
  sourceContracts: Array<{ sourceFile: string; contractNodes: ASTNode[] }>,
  stateVarIds: Map<number, { name: string; contractName: string }>,
  globalIdMap: Map<number, NodeInfo>,
  functionSummary: Record<string, any>
): DataDependencyMap {
  const byFunction: Record<string, Record<string, string[]>> = {};
  const byContract: Record<string, Record<string, string[]>> = {};
  const tainted: Record<string, string[]> = {};

  // Taint sources
  const TAINT_SOURCES = new Set([
    "msg.sender",
    "msg.value",
    "msg.data",
    "tx.origin",
    "tx.gasprice",
    "block.timestamp",
    "block.number",
  ]);

  for (const { contractNodes } of sourceContracts) {
    for (const contract of contractNodes) {
      const contractName = contract.name || "Unknown";
      const contractDeps: Record<string, Set<string>> = {};

      const functions = (contract.nodes || []).filter(
        (n: ASTNode) => n.nodeType === "FunctionDefinition"
      );

      for (const func of functions) {
        const funcName = func.name || func.kind || "unnamed";
        const qualifiedName = `${contractName}.${funcName}`;
        const funcDeps: Record<string, Set<string>> = {};

        // Collect function parameters as taint sources if public/external
        const paramNames: string[] = [];
        if (func.visibility === "public" || func.visibility === "external") {
          for (const param of func.parameters?.parameters || []) {
            if (param.name) {
              paramNames.push(param.name);
            }
          }
        }

        // Walk function body for assignments
        walkAST(func.body || {}, (node) => {
          // Assignment: x = expr or x += expr (compound assignment)
          if (node.nodeType === "Assignment") {
            const lhsName = resolveVarName(node.leftHandSide, stateVarIds, contractName);
            if (lhsName) {
              const rhsVars = collectReadVariables(node.rightHandSide, stateVarIds, contractName);
              if (!funcDeps[lhsName]) funcDeps[lhsName] = new Set();
              for (const v of rhsVars) {
                funcDeps[lhsName].add(v);
              }
              // Compound assignments (+=, -=, *=, /=) also read the LHS
              const op = node.operator;
              if (op && op !== "=") {
                funcDeps[lhsName].add(lhsName);
              }
            }
          }

          // VariableDeclarationStatement: type x = expr
          if (node.nodeType === "VariableDeclarationStatement" && node.initialValue) {
            const vars = node.declarations || node.variables || [];
            for (const decl of vars) {
              if (decl?.name) {
                const rhsVars = collectReadVariables(node.initialValue, stateVarIds, contractName);
                if (!funcDeps[decl.name]) funcDeps[decl.name] = new Set();
                for (const v of rhsVars) {
                  funcDeps[decl.name].add(v);
                }
              }
            }
          }
        });

        // Apply transitive closure within function
        applyTransitiveClosure(funcDeps);

        // Store function-level deps
        const funcResult: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(funcDeps)) {
          if (v.size > 0) funcResult[k] = [...v];
        }
        if (Object.keys(funcResult).length > 0) {
          byFunction[qualifiedName] = funcResult;
        }

        // Merge into contract-level deps
        for (const [k, v] of Object.entries(funcDeps)) {
          if (!contractDeps[k]) contractDeps[k] = new Set();
          for (const dep of v) contractDeps[k].add(dep);
        }

        // Track tainted variables — include solidity vars read (msg.sender etc)
        // and state vars that depend on tainted sources
        const taintedVars: string[] = [];
        // Solidity special vars used in this function are tainted
        walkAST(func.body || {}, (n) => {
          if (
            n.nodeType === "MemberAccess" &&
            n.expression?.nodeType === "Identifier"
          ) {
            const base = n.expression.name;
            const member = n.memberName;
            if (base === "msg" || base === "tx" || base === "block") {
              taintedVars.push(`${base}.${member}`);
            }
          }
        });
        // Variables that depend on taint sources or function params
        for (const [varName, deps] of Object.entries(funcDeps)) {
          const depsList = [...deps];
          const isTainted =
            depsList.some((d) => TAINT_SOURCES.has(d)) ||
            depsList.some((d) => paramNames.includes(d));
          if (isTainted) {
            const shortName = varName.includes(".")
              ? varName.split(".").pop()!
              : varName;
            taintedVars.push(shortName);
          }
        }
        // Parameters themselves are tainted
        for (const p of paramNames) {
          taintedVars.push(p);
        }
        // State vars read via tainted index (e.g., balances[user] where user is param)
        // are effectively tainted in this function's context
        if (paramNames.length > 0) {
          const summary = functionSummary[qualifiedName];
          if (summary) {
            for (const sv of summary.stateVarsRead) {
              const shortSv = sv.includes(".") ? sv.split(".").pop()! : sv;
              if (!taintedVars.includes(shortSv)) {
                taintedVars.push(shortSv);
              }
            }
          }
        }
        if (taintedVars.length > 0) {
          tainted[qualifiedName] = [...new Set(taintedVars)].sort();
        }
      }

      // Apply transitive closure at contract level
      applyTransitiveClosure(contractDeps);

      const contractResult: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(contractDeps)) {
        if (v.size > 0) contractResult[k] = [...v];
      }
      if (Object.keys(contractResult).length > 0) {
        byContract[contractName] = contractResult;
      }
    }
  }

  return { byFunction, byContract, tainted };
}

/** Resolve a variable reference to a name */
function resolveVarName(
  node: ASTNode | undefined,
  stateVarIds: Map<number, { name: string; contractName: string }>,
  contractName: string
): string | undefined {
  if (!node) return undefined;
  // State variable
  const refId = node.referencedDeclaration || node.baseExpression?.referencedDeclaration;
  if (refId) {
    const stateVar = stateVarIds.get(refId);
    if (stateVar) return stateVar.name;
  }
  // Local variable
  if (node.name) return node.name;
  // MemberAccess (e.g., struct.field)
  if (node.nodeType === "MemberAccess" && node.expression?.name) {
    return `${node.expression.name}.${node.memberName}`;
  }
  return undefined;
}

/** Collect all variable names read in an expression */
function collectReadVariables(
  node: ASTNode | undefined,
  stateVarIds: Map<number, { name: string; contractName: string }>,
  contractName: string
): string[] {
  if (!node) return [];
  const vars: string[] = [];

  walkAST(node, (n) => {
    // Identifier referencing a variable
    if (n.nodeType === "Identifier" && n.name) {
      const stateVar = n.referencedDeclaration
        ? stateVarIds.get(n.referencedDeclaration)
        : undefined;
      vars.push(stateVar ? stateVar.name : n.name);
    }
    // MemberAccess for msg.sender, msg.value, etc.
    if (
      n.nodeType === "MemberAccess" &&
      n.expression?.nodeType === "Identifier"
    ) {
      const base = n.expression.name;
      if (base === "msg" || base === "tx" || base === "block") {
        vars.push(`${base}.${n.memberName}`);
      }
    }
  });

  return vars;
}

/** Apply transitive closure: if A depends on B and B depends on C, A depends on C */
function applyTransitiveClosure(deps: Record<string, Set<string>>): void {
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 50; // prevent infinite loops on cyclic deps

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;
    for (const [varName, directDeps] of Object.entries(deps)) {
      const toAdd: string[] = [];
      for (const dep of directDeps) {
        const transitive = deps[dep];
        if (transitive) {
          for (const t of transitive) {
            if (t !== varName && !directDeps.has(t)) {
              toAdd.push(t);
            }
          }
        }
      }
      for (const t of toAdd) {
        directDeps.add(t);
        changed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Feature 1: Operation ordering (CFG) — for CEI violation detection
// ---------------------------------------------------------------------------

function extractOperationOrder(
  body: ASTNode | undefined,
  stateVarIds: Map<number, { name: string; contractName: string }>,
  globalIdMap: Map<number, NodeInfo>,
  contractName: string
): OperationStep[] {
  if (!body) return [];
  const steps: OperationStep[] = [];
  let idx = 0;

  function walkStatements(node: ASTNode): void {
    if (!node) return;

    // Block: walk statements in order
    if (node.nodeType === "Block" && Array.isArray(node.statements)) {
      for (const stmt of node.statements) {
        walkStatements(stmt);
      }
      return;
    }

    // ExpressionStatement — check for calls or assignments
    if (node.nodeType === "ExpressionStatement" && node.expression) {
      classifyExpression(node.expression);
      return;
    }

    // VariableDeclarationStatement — check initializer for calls/reads
    if (node.nodeType === "VariableDeclarationStatement" && node.initialValue) {
      classifyExpression(node.initialValue);
      return;
    }

    // IfStatement — branch
    if (node.nodeType === "IfStatement") {
      steps.push({ index: idx++, type: "branch", target: "if", src: node.src });
      if (node.trueBody) walkStatements(node.trueBody);
      if (node.falseBody) walkStatements(node.falseBody);
      return;
    }

    // ForStatement / WhileStatement
    if (node.nodeType === "ForStatement" || node.nodeType === "WhileStatement") {
      steps.push({ index: idx++, type: "branch", target: "loop", src: node.src });
      if (node.body) walkStatements(node.body);
      return;
    }

    // RevertStatement
    if (node.nodeType === "RevertStatement") {
      const errorName = node.expression?.expression?.name || "revert";
      steps.push({ index: idx++, type: "revert", target: errorName, src: node.src });
      return;
    }

    // Return — check for embedded expressions
    if (node.nodeType === "Return" && node.expression) {
      classifyExpression(node.expression);
      return;
    }
  }

  function classifyExpression(expr: ASTNode): void {
    if (!expr) return;

    // FunctionCall
    if (expr.nodeType === "FunctionCall") {
      let callExpr = expr.expression;
      // Unwrap FunctionCallOptions (e.g., .call{value: x}())
      if (callExpr?.nodeType === "FunctionCallOptions") {
        callExpr = callExpr.expression;
      }
      if (callExpr?.nodeType === "MemberAccess") {
        const memberName = callExpr.memberName;
        const refInfo = callExpr.referencedDeclaration
          ? globalIdMap.get(callExpr.referencedDeclaration)
          : undefined;
        const target = refInfo?.contractName
          ? `${refInfo.contractName}.${memberName}`
          : `external.${memberName}`;
        // Low-level calls (.call, .transfer, .send, .delegatecall) are always external
        const isLowLevel = ["call", "transfer", "send", "delegatecall", "staticcall"].includes(memberName);
        const isExternal = isLowLevel || (refInfo?.contractName && refInfo.contractName !== contractName);
        steps.push({
          index: idx++,
          type: isExternal ? "external-call" : "internal-call",
          target,
          src: expr.src,
        });
      } else if (callExpr?.nodeType === "Identifier") {
        const name = callExpr.name;
        // Skip built-ins that aren't real calls
        if (name === "require" || name === "assert" || name === "revert") return;
        const refInfo = callExpr.referencedDeclaration
          ? globalIdMap.get(callExpr.referencedDeclaration)
          : undefined;
        const isExternal = refInfo?.contractName && refInfo.contractName !== contractName;
        steps.push({
          index: idx++,
          type: isExternal ? "external-call" : "internal-call",
          target: isExternal ? `${refInfo!.contractName}.${name}` : name,
          src: expr.src,
        });
      }
      return;
    }

    // Assignment — check if LHS is state variable
    if (expr.nodeType === "Assignment") {
      const lhs = expr.leftHandSide;
      const refId = lhs?.referencedDeclaration || lhs?.baseExpression?.referencedDeclaration;
      const varInfo = refId ? stateVarIds.get(refId) : undefined;
      if (varInfo) {
        steps.push({
          index: idx++,
          type: "state-write",
          target: varInfo.name,
          src: expr.src,
        });
      }
      // Also check RHS for calls
      if (expr.rightHandSide) classifyExpression(expr.rightHandSide);
      return;
    }

    // UnaryOperation (++/--)
    if (expr.nodeType === "UnaryOperation") {
      const refId = expr.subExpression?.referencedDeclaration;
      const varInfo = refId ? stateVarIds.get(refId) : undefined;
      if (varInfo) {
        steps.push({
          index: idx++,
          type: "state-write",
          target: varInfo.name,
          src: expr.src,
        });
      }
      return;
    }
  }

  walkStatements(body);
  return steps;
}

// ---------------------------------------------------------------------------
// Feature 2: Auth checks (msg.sender conditions)
// ---------------------------------------------------------------------------

function containsMsgSender(node: ASTNode): boolean {
  let found = false;
  walkAST(node, (n) => {
    if (
      n.nodeType === "MemberAccess" &&
      n.expression?.nodeType === "Identifier" &&
      n.expression?.name === "msg" &&
      n.memberName === "sender"
    ) {
      found = true;
    }
  });
  return found;
}

/** Extract the identifier that msg.sender is compared against in a BinaryOperation */
function extractComparedTo(node: ASTNode): string | undefined {
  let result: string | undefined;
  walkAST(node, (n) => {
    if (n.nodeType === "BinaryOperation" && (n.operator === "==" || n.operator === "!=")) {
      const left = n.leftExpression;
      const right = n.rightExpression;
      // Check if one side is msg.sender
      const leftIsMsgSender =
        left?.nodeType === "MemberAccess" &&
        left.expression?.name === "msg" &&
        left.memberName === "sender";
      const rightIsMsgSender =
        right?.nodeType === "MemberAccess" &&
        right.expression?.name === "msg" &&
        right.memberName === "sender";

      if (leftIsMsgSender && right?.name) {
        result = right.name;
      } else if (rightIsMsgSender && left?.name) {
        result = left.name;
      }
    }
  });
  return result;
}

function extractAuthChecks(
  func: ASTNode,
  globalIdMap: Map<number, NodeInfo>
): AuthCheck[] {
  const checks: AuthCheck[] = [];

  // A. Modifiers — check if they reference msg.sender
  for (const mod of func.modifiers || []) {
    const modName = mod.modifierName?.name || "unknown";
    const refId = mod.modifierName?.referencedDeclaration;
    const modDef = refId ? globalIdMap.get(refId) : undefined;

    let checksMsgSender = false;
    let comparedTo: string | undefined;
    if (modDef?.node?.body) {
      checksMsgSender = containsMsgSender(modDef.node);
      if (checksMsgSender) {
        comparedTo = extractComparedTo(modDef.node);
      }
    }

    checks.push({
      type: "modifier",
      name: modName,
      checksMsgSender,
      comparedTo,
    });
  }

  // B. Inline checks in function body
  if (func.body) {
    walkAST(func.body, (node) => {
      // require(msg.sender == something)
      if (
        node.nodeType === "FunctionCall" &&
        node.expression?.nodeType === "Identifier" &&
        node.expression?.name === "require" &&
        node.arguments?.length > 0
      ) {
        const condition = node.arguments[0];
        if (containsMsgSender(condition)) {
          checks.push({
            type: "require",
            name: "require",
            checksMsgSender: true,
            comparedTo: extractComparedTo(condition),
          });
        }
      }

      // if (msg.sender != x) revert ...
      if (node.nodeType === "IfStatement" && containsMsgSender(node.condition)) {
        // Check if trueBody contains a revert
        let hasRevert = false;
        walkAST(node.trueBody, (n) => {
          if (n.nodeType === "RevertStatement") hasRevert = true;
        });
        if (hasRevert) {
          checks.push({
            type: "if-revert",
            name: "if-revert",
            checksMsgSender: true,
            comparedTo: extractComparedTo(node.condition),
          });
        }
      }
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Feature 3: Guard inventory (require/assert/revert)
// ---------------------------------------------------------------------------

function extractGuardInventory(body: ASTNode | undefined): Guard[] {
  if (!body) return [];
  const guards: Guard[] = [];

  walkAST(body, (node) => {
    // require(condition, "message")
    if (
      node.nodeType === "FunctionCall" &&
      node.expression?.nodeType === "Identifier" &&
      node.expression?.name === "require"
    ) {
      const args = node.arguments || [];
      const condition = args[0];
      const message = args[1]?.value;
      guards.push({
        type: "require",
        name: message || undefined,
        checksMsgSender: condition ? containsMsgSender(condition) : false,
        condition: condition ? summarizeCondition(condition) : undefined,
      });
    }

    // assert(condition)
    if (
      node.nodeType === "FunctionCall" &&
      node.expression?.nodeType === "Identifier" &&
      node.expression?.name === "assert"
    ) {
      const args = node.arguments || [];
      const condition = args[0];
      guards.push({
        type: "assert",
        checksMsgSender: condition ? containsMsgSender(condition) : false,
        condition: condition ? summarizeCondition(condition) : undefined,
      });
    }

    // revert CustomError() or revert("message")
    if (node.nodeType === "RevertStatement" && node.expression) {
      const expr = node.expression;
      const fnExpr = expr.expression;
      const refId = fnExpr?.referencedDeclaration;

      if (refId && refId > 0) {
        // Custom error
        guards.push({
          type: "custom-error",
          name: fnExpr?.name,
          checksMsgSender: false,
        });
      } else {
        // Old-style revert("message")
        guards.push({
          type: "revert",
          name: expr.arguments?.[0]?.value,
          checksMsgSender: false,
        });
      }
    }
  });

  return guards;
}

/** Produce a brief human-readable summary of a condition expression */
function summarizeCondition(node: ASTNode): string {
  if (node.nodeType === "BinaryOperation") {
    const left = summarizeCondition(node.leftExpression);
    const right = summarizeCondition(node.rightExpression);
    return `${left} ${node.operator} ${right}`;
  }
  if (node.nodeType === "MemberAccess") {
    const base = node.expression?.name || "?";
    return `${base}.${node.memberName}`;
  }
  if (node.nodeType === "Identifier") {
    return node.name || "?";
  }
  if (node.nodeType === "Literal") {
    return node.value || "?";
  }
  if (node.nodeType === "FunctionCall") {
    const fn = node.expression?.name || node.expression?.memberName || "fn";
    return `${fn}(...)`;
  }
  if (node.nodeType === "IndexAccess") {
    const base = summarizeCondition(node.baseExpression);
    return `${base}[...]`;
  }
  if (node.nodeType === "UnaryOperation") {
    return `${node.operator || "!"}${summarizeCondition(node.subExpression)}`;
  }
  return "?";
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
