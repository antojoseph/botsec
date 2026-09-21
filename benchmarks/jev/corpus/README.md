# Historical protocol source snapshots

Fetched on 2026-09-21 from the protocols' public GitHub repositories. This first batch covers Euler, Sentiment, and Socket. It acquires real implementation source for a later benchmark; it does not run that benchmark or claim that every deployment has been reconstructed.

| Target | Public repository commit | Evidence and qualification |
|---|---|---|
| Euler EToken module | [euler-contracts `d7f62927`](https://github.com/euler-legacy-xyz/euler-contracts/tree/d7f62927eb58592d82302c87205490c26cccca7c), 2022-08-09 | The module's explorer-decoded constructor records this Git commit. All 13 Solidity files published with that verified module match exactly. Historical active-module mapping and other modules remain to be checked. |
| Sentiment protocol | [protocol `3d469a46`](https://github.com/sentimentxyz/protocol/tree/3d469a46b670dd02167bc0c5d395b092b7db1229), 2023-02-07 | Last default-branch commit before the incident-day cutoff. Deployment source/bytecode correspondence is not yet established. |
| Sentiment oracle | [oracle `815233ad`](https://github.com/sentimentxyz/oracle/tree/815233add2d23a7e2a2c5136504537b234a65c47), 2023-02-07 | Vulnerable `getPrice()` matches the protocol's postmortem snippet after whitespace removal. It is the view function without the later reentrancy-context check. Deployment source/bytecode correspondence is not yet established. |
| Socket route | [bungee-contracts-public `657b7a56`](https://github.com/SocketDotTech/bungee-contracts-public/tree/657b7a5600e6ac24360976d496dc6de8df77ec22), 2024-06-05 | First public snapshot, published after the January incident. It retains the vulnerable call but differs from the verified deployed source. Preserved as a qualified candidate, not an exact historical deployment snapshot. |

## Retrieve and verify

```sh
node benchmarks/jev/corpus/fetch-sources.mjs
node benchmarks/jev/corpus/fetch-sources.mjs --verify
# Optional: --only euler-deployed-module
```

`archives/` contains the original GitHub archives so retrieval remains possible without network access. If an archive is absent, the fetch command downloads its pinned URL and checks its SHA-256 before extraction. `sources.lock.json` records every file's SHA-256 and Git blob SHA-1, archive hashes, commits, incident identifiers, evidence, and outstanding checks. The verify command checks all extracted files and retained evidence without making network calls. Snapshots are extracted under ignored `cache/<repository-id>/source/`; they are not modified in place or used as the application source.

Original repository files, license notices, dependency declarations, and tests are retained in the archives. No dependency installation, build script, or deployment script has been executed. Sentiment's Git submodules are pinned in the lock but not expanded. Its protocol snapshot pins a different oracle commit from the standalone incident-time oracle snapshot; those must not be silently substituted. Euler's package lock is preserved; npm dependencies are not installed. Socket's initial public archive already includes library files despite retaining a `.gitmodules` file.

## Why date alone was not enough

Euler's last default-branch commit before the incident, `dfaa7788`, matched only nine of the 13 verified EToken Solidity files. The module constructor's `moduleGitCommit_` identified `d7f62927`, which matched all 13. This is evidence for the module source, not proof that every module in the protocol used the same commit. See the [verified module](https://etherscan.io/address/0xbb0D4bb654a21054aF95456a3B29c63e8D1F4c0a#code).

For Sentiment, the [protocol postmortem](https://hackmd.io/@sentimentxyz/SJCySo1z2) gives the vulnerable function and later mitigation. The downloaded old oracle matches that vulnerable function; the later Git change is `17510cd8`. Direct Arbiscan source retrieval returned HTTP 403 and the queried Sourcify paths had no metadata, so exact deployment matching remains unverified.

For Socket, the public GitHub history starts in June 2024. Its [verified vulnerable route](https://etherscan.io/address/0xCC5fDA5e3cA925bd0bb428C8b2669496eE43067e#code) uses a different ERC20 import path and calls `transfer` where the public version calls `safeTransfer` in the native-to-wrapped branch. Both retain the caller-supplied external call in the exploited wrapped-to-native branch. The actual explorer-published source is retained separately under `evidence/socket-route.verified.json`; it must not be misrepresented as an incident-time Git commit. No public source was patched to manufacture a match.

The explorer JSON snapshots preserve decoded source content and the explorer's settings entry where present. They are evidence exports, not a claim that we independently recompiled and matched runtime bytecode. `explorer-source.mjs` decodes the page data without evaluating page JavaScript.

## Before benchmark use

Complete each target's `pending` checks in the lock, including historical proxy/module/route resolution, necessary dependencies, compiler settings, and exploit reproduction with explicit economic assertions. All targets currently have `deploymentBenchmarkEligible: false` so a future runner can fail closed until these checks are complete.

Build a separate analysis workspace containing target source and required dependencies. Keep exploit scripts, postmortems, benchmark labels, and this provenance directory outside the analyzer's accessible context. The full archives intentionally retain upstream tests and documentation for provenance, so pointing the analyzer at the unfiltered archive would not satisfy the evaluation design.

The previous Jev pilot remains unchanged. This acquisition does not produce new accuracy, price, or adoption claims. See the [decision record](../../../docs/decisions/2026-09-21-jev-evaluation.md) for the broader validation requirements.
