# Historical protocol source snapshots

Collected on 2026-09-21 for Euler, Sentiment, and Socket. Historical deployment matching and dependency acquisition are complete for the scope below, with explicit metadata and source-fallback qualifications. This makes the sources eligible for raw-finding collection; it does not create a labeled Jev benchmark or establish new accuracy/cost results.

**Exploit evidence policy:** the user accepts DeFiHackLabs' pinned reproductions as trusted reference evidence. We did not rerun the exploits, and local exploit reexecution is no longer a prerequisite. Source/deployment correspondence was checked independently. Trusting a reproduction does not supply labels for contradiction or duplicate identity.

| Target | Incident-block result | Source selection |
|---|---|---|
| Euler, Ethereum block 16,817,995 | Read eight module mappings and embedded Git commits; checked eDAI and liquidation proxy dispatch; recompiled the core and eight modules against historical runtime. | Six modules use `d7f62927`; Installer/core sources match `c6fda952`; Governance uses `fa939872`. All selected compiler source files match their respective public repository snapshots. |
| Sentiment, Arbitrum block 77,026,912 | Historical AccountManager implementation is `0x23ad9605b6e7a02ab9f73068f5e68715f21c2b6b`, different from the explorer's current implementation. Oracle, AccountManager implementation, proxy, Balancer Vault and pool runtime comparisons completed. | Oracle: 8/8 source files match `815233ad`. AccountManager implementation: 20/20 match protocol `3d469a46` and its exact dependencies. Balancer sources match pinned public deployment artifacts. The older proxy uses a documented explorer fallback for one changed dependency. |
| Socket, Ethereum block 19,021,453 | Historical `routes(406)` resolves to `0xcc5fda5e3ca925bd0bb428c8b2669496ee43067e`. Gateway and route runtime comparisons completed. | Select the retained explorer-verified source. The June 2024 public GitHub snapshot is a later reference, not the January deployment source. |

The [runtime report](evidence/runtime-comparisons.json), [source comparisons](evidence/source-correspondence.json), and [lock](sources.lock.json) retain the actual evidence and qualifications.

## What “runtime matches” means

We compiled 16 contracts with hash-pinned official Solidity compilers and compared them with `eth_getCode` at the recorded incident blocks. The comparison records all compiler-declared immutable locations and their historical values; it does not regenerate those values by executing constructors. Repeated copies of each immutable must agree.

For 13 contracts, every remaining runtime byte matches, including metadata. For three—Socket's gateway and route, and Sentiment's AccountManager proxy—the only other difference is the 32-byte IPFS digest in the recognized 53-byte Solidity metadata trailer. Executable code matches, but full artifact reproduction remains qualified. The verifier permits only that specific digest difference; it does not remove arbitrary trailing bytes or ignore instruction differences. These exceptions remain visible in the report and target qualifications.

Historical RPC requests, responses, block hashes, code, module commits, route lookup, and proxy implementation storage are retained in `evidence/*historical-rpc.json`. They were obtained through public Blast archive endpoints. Explorer responses and original Balancer deployment artifacts are preserved as compressed archives, with hashes in the lock. This is reproducible source/runtime correspondence, not a proof of every external dependency or of the exploit's economic outcome.

## Restore and verify sources

```sh
node benchmarks/jev/corpus/fetch-sources.mjs --assemble
node benchmarks/jev/corpus/fetch-sources.mjs --verify --assemble
# Optional: --only sentiment-protocol (also restores its exact dependencies)
```

`archives/` preserves the pinned GitHub archives, licenses, dependency declarations and tests. `sources.lock.json` inventories each repository file by SHA-256 and Git blob SHA-1, records recursive submodule commits, and hashes retained evidence. Restoration uses these local archives; if a repository archive is missing, it downloads the pinned URL and checks the hash before extraction. Verification is offline.

Original repository snapshots remain under ignored `cache/<repository-id>/source/`. `--assemble` creates separate copies under `cache/workspaces/<repository-id>/`, recursively filling each submodule at its own pin. Both original and assembled files are checked against their inventories. Sentiment's protocol pins oracle `c9f56c34`; the standalone oracle snapshot is `815233ad`. Neither replaces the other. Ten distinct dependency snapshots cover the recursive submodule graph. No upstream project installation, deployment script, or exploit script was executed.

Euler's Solidity imports are included in its snapshots. Its npm lock remains preserved, but reproducing the runtime does not require its historical Hardhat/npm environment. Compiler input bundles contain the required Solidity sources and settings. Socket's later public archive already includes its library files.

## Repeat the compiler checks

From the repository root:

```sh
npm install --prefix benchmarks/jev/corpus/cache/compiler --ignore-scripts --no-audit --no-fund solc@0.8.17
node benchmarks/jev/corpus/verify-deployments.mjs --fetch-compilers
# After the compiler files are cached, the same check is offline:
node benchmarks/jev/corpus/verify-deployments.mjs
```

The installed package supplies the JavaScript wrapper. Each job uses its own historical compiler version, downloaded from Solidity's official binary distribution and checked against the SHA-256 recorded in [compilers.json](evidence/compilers.json). The four compiler versions are 0.7.1, 0.8.7, 0.8.10, and 0.8.17. No OpenRouter key is needed. Normal verification compares its result with the saved report without rewriting evidence; `--write` explicitly regenerates the report and requires its lock hash to be updated before subsequent verification.

## Why source selection mattered

Euler's last default-branch commit before the incident, `dfaa7788`, matched only 9/13 verified EToken files. The historical module getter identifies `d7f62927`, which matches all 13. Other modules really used different commits; the core and Installer match one older snapshot, while Governance matches another. Using one “latest pre-incident” tree would lose that distinction.

Sentiment's oracle matches the vulnerable function in its [postmortem](https://hackmd.io/@sentimentxyz/SJCySo1z2), but the stronger evidence is now a full 8/8 source match and historical runtime comparison. Blockscout's verified-source API resolved the earlier Arbiscan/Sourcify retrieval failures. The AccountManager implementation matches all 20 compilation sources, including four files from pinned submodules. For its older proxy, 6/7 files match: the retained explorer `Errors.sol` omits the later `MaxAssetCap` error. The proxy compiler input is kept separately instead of changing repository source to manufacture a match.

Balancer's Vault and WeightedPool sources match all 45 and 36 files respectively in public deployment build artifacts at [balancer-deployments `b55dc2b8`](https://github.com/balancer/balancer-deployments/tree/b55dc2b8a46bce8f27aed5a3b03f719f662f860a). Although that repository snapshot is newer than the incident, recompilation matches the historical code, including metadata after accounting for immutables. Original artifact Git blobs and archive hashes are recorded; the later WeightedPool V2 candidate did not match and was rejected.

Socket's public repository history begins after the incident. Its source changes an ERC20 import path and a native-to-wrapped `transfer` to `safeTransfer`. Both versions retain the vulnerable call, but that is insufficient to call them identical. We explicitly select explorer source for the gateway and route and preserve the later repository only as supporting history. The unresolved metadata digests are disclosed above.

## Next collection stage

Build an isolated source-only analyzer workspace from the selected compiler inputs, preserving separate compilation units where versions differ. The restored provenance workspaces retain upstream tests and documentation, so they must not be supplied wholesale to the analyzer. Keep exploit scripts, postmortems, labels and this evidence directory outside its accessible context.

Capture findings before synthesis filters, then obtain independent labels and broaden the project sample. `deploymentBenchmarkEligible: true` means eligible source input within the recorded scope and qualifications; it does not mean the finding dataset or adoption decision is ready. The previous Jev pilot remains unchanged. See the [decision record](../../../docs/decisions/2026-09-21-jev-evaluation.md).

## Validation performed

- Application build and all 21 tests passed, including runtime comparison rejection cases.
- All 2,140 repository files and the assembled dependency workspaces verified against the lock.
- A fresh temporary copy restored and assembled entirely from retained archives; modifying a nested dependency caused verification to fail as expected.
- Offline recompilation reproduced the saved 16-contract comparison report, including its three metadata exceptions.
