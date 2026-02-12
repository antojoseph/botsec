/**
 * Parse Halmos stdout into structured results.
 *
 * Halmos output format:
 *   [PASS] check_property(uint256) (paths: 3, time: 2.1s, bounds: [])
 *   [FAIL] check_property(uint256)
 *     Counterexample:
 *       p_amount_uint256 = 0x00...0186a0
 *     (paths: 7, time: 4.3s, bounds: [loop:3])
 *   [ERROR] check_property(uint256) (error message)
 */

export interface HalmosTestResult {
  name: string;
  status: "pass" | "fail" | "error" | "timeout";
  paths?: number;
  timeSeconds?: number;
  bounds?: string[];
  counterexample?: Record<string, string>;
  errorMessage?: string;
  rawOutput: string;
}

export interface HalmosRunResult {
  tests: HalmosTestResult[];
  totalPassed: number;
  totalFailed: number;
  totalErrors: number;
  rawOutput: string;
}

export function parseHalmosOutput(output: string): HalmosRunResult {
  const tests: HalmosTestResult[] = [];
  const lines = output.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Match [PASS], [FAIL], [ERROR], [TIMEOUT]
    const passMatch = line.match(
      /\[PASS\]\s+(check_\w+)\(([^)]*)\)\s*(?:\(paths:\s*(\d+),\s*time:\s*([\d.]+)s(?:,\s*bounds:\s*\[([^\]]*)\])?\))?/
    );
    if (passMatch) {
      tests.push({
        name: passMatch[1],
        status: "pass",
        paths: passMatch[3] ? parseInt(passMatch[3]) : undefined,
        timeSeconds: passMatch[4] ? parseFloat(passMatch[4]) : undefined,
        bounds: passMatch[5] ? parseBounds(passMatch[5]) : [],
        rawOutput: line,
      });
      i++;
      continue;
    }

    const failMatch = line.match(/\[FAIL\]\s+(check_\w+)\(([^)]*)\)/);
    if (failMatch) {
      const testName = failMatch[1];
      const counterexample: Record<string, string> = {};
      let rawLines = [line];

      // Look ahead for counterexample block
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        rawLines.push(nextLine);

        // Counterexample variable assignment
        const ceMatch = nextLine.match(/^\s+(p_\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/);
        if (ceMatch) {
          const hexVal = ceMatch[2];
          counterexample[ceMatch[1]] = hexVal;
          i++;
          continue;
        }

        // Stats line after counterexample
        const statsMatch = nextLine.match(
          /\(paths:\s*(\d+),\s*time:\s*([\d.]+)s(?:,\s*bounds:\s*\[([^\]]*)\])?\)/
        );
        if (statsMatch) {
          tests.push({
            name: testName,
            status: "fail",
            paths: parseInt(statsMatch[1]),
            timeSeconds: parseFloat(statsMatch[2]),
            bounds: statsMatch[3] ? parseBounds(statsMatch[3]) : [],
            counterexample:
              Object.keys(counterexample).length > 0 ? counterexample : undefined,
            rawOutput: rawLines.join("\n"),
          });
          i++;
          break;
        }

        // If we hit another test result or EOF, save what we have
        if (
          nextLine.match(/^\[(PASS|FAIL|ERROR|TIMEOUT)\]/) ||
          nextLine.trim() === ""
        ) {
          tests.push({
            name: testName,
            status: "fail",
            counterexample:
              Object.keys(counterexample).length > 0 ? counterexample : undefined,
            rawOutput: rawLines.join("\n"),
          });
          break;
        }

        i++;
      }
      continue;
    }

    const errorMatch = line.match(/\[ERROR\]\s+(check_\w+)\(([^)]*)\)\s*(.*)/);
    if (errorMatch) {
      tests.push({
        name: errorMatch[1],
        status: "error",
        errorMessage: errorMatch[3] || undefined,
        rawOutput: line,
      });
      i++;
      continue;
    }

    // Check for timeout patterns
    if (line.includes("timeout") && line.includes("check_")) {
      const toMatch = line.match(/(check_\w+)/);
      if (toMatch) {
        tests.push({
          name: toMatch[1],
          status: "timeout",
          rawOutput: line,
        });
      }
    }

    i++;
  }

  return {
    tests,
    totalPassed: tests.filter((t) => t.status === "pass").length,
    totalFailed: tests.filter((t) => t.status === "fail").length,
    totalErrors: tests.filter(
      (t) => t.status === "error" || t.status === "timeout"
    ).length,
    rawOutput: output,
  };
}

/**
 * Convert a hex counterexample value to a human-readable decimal + ETH amount.
 */
export function formatCounterexampleValue(hexValue: string): string {
  try {
    const decimal = BigInt(hexValue);
    const ether = Number(decimal) / 1e18;
    if (ether >= 0.001) {
      return `${decimal.toString()} (${ether.toFixed(6)} ETH)`;
    }
    return decimal.toString();
  } catch {
    return hexValue;
  }
}

function parseBounds(boundsStr: string): string[] {
  if (!boundsStr.trim()) return [];
  return boundsStr.split(",").map((b) => b.trim());
}
