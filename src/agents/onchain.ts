/**
 * On-Chain Agent — Analyzes real blockchain transaction data for deployed contracts.
 *
 * Uses Bash (curl) to query block explorer APIs. Builds usage profiles,
 * detects suspicious patterns, and extracts concrete test values.
 */

import type { AgentDefinition } from "./explorer.js";

export interface OnchainOpts {
  address?: string;
  chainId?: string;
  etherscanApiKey?: string;
}

export function onchainAgent(opts: OnchainOpts): AgentDefinition {
  const etherscanBase = getEtherscanBase(opts.chainId);
  const apiKey = opts.etherscanApiKey || "YourApiKeyToken";
  const address = opts.address || "NOT_PROVIDED";

  return {
    description:
      "On-chain transaction analyst for smart contracts. Use this agent when an " +
      "on-chain address is provided to analyze real transaction history, identify " +
      "usage patterns, detect suspicious activity, and correlate with code-level " +
      "findings. Do NOT use this agent if no on-chain address was provided.",
    prompt: buildOnchainPrompt(etherscanBase, apiKey, address),
    tools: ["Bash", "Read"],
    model: "sonnet",
    omitClaudeMd: true,
  };
}

function buildOnchainPrompt(
  etherscanBase: string,
  apiKey: string,
  address: string
): string {
  return `You are an on-chain intelligence analyst for smart contract security.

## Your Task
Analyze real blockchain transaction data for the target contract to understand how it behaves in production.

## Available APIs
Use curl via Bash to query these endpoints. Always use -s (silent) flag.

### Etherscan API
Base URL: ${etherscanBase}
API Key: ${apiKey}
Contract Address: ${address}

Key endpoints:

Normal transactions:
  curl -s "${etherscanBase}/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&page=1&offset=50&apikey=${apiKey}"

Internal transactions:
  curl -s "${etherscanBase}/api?module=account&action=txlistinternal&address=${address}&startblock=0&endblock=99999999&sort=desc&page=1&offset=50&apikey=${apiKey}"

ERC20 token transfers:
  curl -s "${etherscanBase}/api?module=account&action=tokentx&address=${address}&sort=desc&page=1&offset=50&apikey=${apiKey}"

Event logs:
  curl -s "${etherscanBase}/api?module=logs&action=getLogs&address=${address}&fromBlock=0&toBlock=latest&page=1&offset=100&apikey=${apiKey}"

Contract ABI:
  curl -s "${etherscanBase}/api?module=contract&action=getabi&address=${address}&apikey=${apiKey}"

Contract verified source:
  curl -s "${etherscanBase}/api?module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}"

## Analysis Process

### 1. Fetch Recent Transactions (last 50-100)
- Decode function selectors (first 4 bytes of input data)
- Use cast to decode if available: cast 4byte-decode <selector>
- Track which functions are called most often
- Note typical msg.value amounts

### 2. Identify Patterns
- Who are the most frequent callers? (EOAs vs contracts)
- Are there admin/privileged transactions?
- What's the typical transaction flow?
- Time between transactions (burst patterns?)

### 3. Spot Anomalies
- Unusually large value transactions
- Failed transactions (and their revert reasons if available)
- Rapid sequences of transactions from same sender (bot/exploit patterns)
- Transactions that look like exploit attempts or probes
- Flash loan patterns (borrow + action + repay in internal txs)

### 4. Extract Concrete Test Parameters
From real transactions, extract:
- Actual deposit/withdrawal amounts
- Real token balances and supplies
- Concrete addresses that interact with the contract
- Typical function parameter ranges

## Output Format
Provide a structured analysis with:
- Transaction pattern summary (most-called functions, frequency)
- Top callers and their behavior
- Suspicious transaction flags (if any)
- Real-world usage context (what this contract does in practice)
- Concrete values to inform formal verification tests
- Any known exploit correlation`;
}

function getEtherscanBase(chainId?: string): string {
  const chains: Record<string, string> = {
    "1": "https://api.etherscan.io",
    "5": "https://api-goerli.etherscan.io",
    "11155111": "https://api-sepolia.etherscan.io",
    "137": "https://api.polygonscan.com",
    "42161": "https://api.arbiscan.io",
    "10": "https://api-optimistic.etherscan.io",
    "8453": "https://api.basescan.org",
  };
  return chains[chainId || "1"] || "https://api.etherscan.io";
}
