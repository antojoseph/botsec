/**
 * Type definitions and helpers for Etherscan API responses.
 * The On-Chain agent uses curl directly, but these types help
 * the orchestrator understand and validate the data.
 */

export interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  isError: string;
  gasUsed: string;
  blockNumber: string;
  timeStamp: string;
  functionName?: string;
  methodId?: string;
}

export interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

/**
 * Extract the 4-byte function selector from calldata.
 */
export function extractSelector(input: string): string {
  if (!input || input === "0x") return "0x (transfer)";
  return input.slice(0, 10);
}

/**
 * Summarize a list of transactions into a function call distribution.
 */
export function summarizeTransactions(
  txs: EtherscanTx[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tx of txs) {
    const selector = tx.functionName || extractSelector(tx.input);
    counts[selector] = (counts[selector] || 0) + 1;
  }
  return counts;
}

/**
 * Identify transactions with unusually large values.
 */
export function flagLargeValueTxs(
  txs: EtherscanTx[],
  thresholdWei: bigint = BigInt("1000000000000000000") // 1 ETH
): EtherscanTx[] {
  return txs.filter((tx) => {
    try {
      return BigInt(tx.value) >= thresholdWei;
    } catch {
      return false;
    }
  });
}

/**
 * Identify failed transactions (potential probing or exploit attempts).
 */
export function failedTransactions(txs: EtherscanTx[]): EtherscanTx[] {
  return txs.filter((tx) => tx.isError === "1");
}
