// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/**
 * @title TheRewarderDistributor Formal Verification
 * @notice Verifies the bitmap bypass vulnerability in claimRewards().
 *
 * VULNERABILITY: _setClaimed() is only called in two cases:
 *   1. When the token changes (line 93-96)
 *   2. On the last claim (line 107-109)
 *
 * If two claims have the SAME token but DIFFERENT wordPositions (batchNumber / 256),
 * only the LAST wordPosition gets its bits set. The first wordPosition's bits
 * are accumulated in `bitsSet` but then OVERWRITTEN when a new wordPosition is encountered
 * (since the token hasn't changed, code goes to else branch and just ORs bits).
 *
 * Actually, looking more carefully: the bug is that _setClaimed is called with the
 * CURRENT wordPosition, not all accumulated wordPositions. When claims span multiple
 * wordPositions for the same token, only the last wordPosition gets marked as claimed.
 *
 * We verify this with a simplified mock that captures the exact logic.
 */

/// @notice Simplified rewarder that replicates the bitmap logic bug
contract BuggyRewarder {
    mapping(uint256 tokenId => mapping(address claimer => mapping(uint256 word => uint256 bits))) public claims;

    struct Claim {
        uint256 batchNumber;
        uint256 amount;
        uint256 tokenIndex;
    }

    event ClaimProcessed(uint256 tokenId, uint256 wordPosition, uint256 bitsSet, uint256 amount);

    /**
     * @notice Simplified claim logic that replicates the exact bug.
     * We skip merkle proof verification to focus on the bitmap logic.
     */
    function claimRewards(Claim[] memory inputClaims, uint256[] memory inputTokens) external {
        uint256 token;
        uint256 bitsSet;
        uint256 amount;

        for (uint256 i = 0; i < inputClaims.length; i++) {
            Claim memory inputClaim = inputClaims[i];

            uint256 wordPosition = inputClaim.batchNumber / 256;
            uint256 bitPosition = inputClaim.batchNumber % 256;

            if (token != inputTokens[inputClaim.tokenIndex]) {
                if (token != 0) {
                    // Flush previous token's claims
                    require(_setClaimed(token, amount, wordPosition, bitsSet), "Already claimed");
                }

                token = inputTokens[inputClaim.tokenIndex];
                bitsSet = 1 << bitPosition;
                amount = inputClaim.amount;
            } else {
                // Same token: accumulate bits and amount
                // BUG: wordPosition may differ, but we only store bits for ONE wordPosition
                bitsSet = bitsSet | (1 << bitPosition);
                amount += inputClaim.amount;
            }

            // For the last claim
            if (i == inputClaims.length - 1) {
                require(_setClaimed(token, amount, wordPosition, bitsSet), "Already claimed");
            }
        }
    }

    function _setClaimed(uint256 token, uint256 amount, uint256 wordPosition, uint256 newBits) private returns (bool) {
        uint256 currentWord = claims[token][msg.sender][wordPosition];
        if ((currentWord & newBits) != 0) return false;
        claims[token][msg.sender][wordPosition] = currentWord | newBits;
        return true;
    }

    function isClaimed(uint256 token, address claimer, uint256 batchNumber) external view returns (bool) {
        uint256 wordPosition = batchNumber / 256;
        uint256 bitPosition = batchNumber % 256;
        return (claims[token][claimer][wordPosition] & (1 << bitPosition)) != 0;
    }
}

/// @custom:halmos --solver-timeout-assertion 10000
contract RewarderVerification is SymTest, Test {
    BuggyRewarder rewarder;
    address claimer;

    function setUp() public {
        rewarder = new BuggyRewarder();
        claimer = address(0xC1A1);
    }

    /**
     * Property: After claiming batch 0, the bit for batch 0 should be set.
     * This is the basic case that SHOULD work.
     *
     * Expected: PASS
     */
    function check_single_claim_sets_bit() public {
        BuggyRewarder.Claim[] memory inputClaims = new BuggyRewarder.Claim[](1);
        inputClaims[0] = BuggyRewarder.Claim({
            batchNumber: 0,
            amount: 100,
            tokenIndex: 0
        });

        uint256[] memory tokens = new uint256[](1);
        tokens[0] = 1; // token ID 1

        vm.prank(claimer);
        rewarder.claimRewards(inputClaims, tokens);

        // Check: bit for batch 0 should be set
        bool claimed = rewarder.isClaimed(1, claimer, 0);
        assert(claimed);
    }

    /**
     * Property: After claiming batches in DIFFERENT wordPositions for the SAME token,
     * ALL claimed bits should be set.
     *
     * batch 0 -> wordPosition 0, bitPosition 0
     * batch 256 -> wordPosition 1, bitPosition 0
     *
     * BUG: Only the LAST wordPosition (1) gets its bits set properly.
     * WordPosition 0's bits get accumulated in bitsSet but _setClaimed is only
     * called with the LAST wordPosition.
     *
     * Expected: FAIL -- batch 0's bit is NOT set after claiming both.
     */
    function check_claimed_bits_set_across_word_positions() public {
        BuggyRewarder.Claim[] memory inputClaims = new BuggyRewarder.Claim[](2);

        // Claim batch 0 (wordPosition=0, bitPosition=0)
        inputClaims[0] = BuggyRewarder.Claim({
            batchNumber: 0,
            amount: 100,
            tokenIndex: 0
        });

        // Claim batch 256 (wordPosition=1, bitPosition=0)
        inputClaims[1] = BuggyRewarder.Claim({
            batchNumber: 256,
            amount: 200,
            tokenIndex: 0
        });

        uint256[] memory tokens = new uint256[](1);
        tokens[0] = 1; // same token

        vm.prank(claimer);
        rewarder.claimRewards(inputClaims, tokens);

        // Check: bit for batch 256 should be set (last wordPosition -- this should work)
        bool claimed256 = rewarder.isClaimed(1, claimer, 256);
        assert(claimed256); // PASS

        // Check: bit for batch 0 should ALSO be set
        // BUG: This fails because _setClaimed was only called with wordPosition=1
        bool claimed0 = rewarder.isClaimed(1, claimer, 0);
        assert(claimed0); // FAIL -- batch 0's bit was not set!
    }

    /**
     * Property: After claiming, re-claiming the same batch should fail.
     * For the buggy word position case, the first batch can be re-claimed.
     *
     * Expected: FAIL -- the second claimRewards call succeeds because batch 0
     * was never marked as claimed.
     */
    function check_double_claim_prevented() public {
        BuggyRewarder.Claim[] memory inputClaims = new BuggyRewarder.Claim[](2);

        // First call: claim batches 0 and 256 (different word positions)
        inputClaims[0] = BuggyRewarder.Claim({
            batchNumber: 0,
            amount: 100,
            tokenIndex: 0
        });
        inputClaims[1] = BuggyRewarder.Claim({
            batchNumber: 256,
            amount: 200,
            tokenIndex: 0
        });

        uint256[] memory tokens = new uint256[](1);
        tokens[0] = 1;

        vm.prank(claimer);
        rewarder.claimRewards(inputClaims, tokens);

        // Second call: try to re-claim batch 0
        BuggyRewarder.Claim[] memory reClaims = new BuggyRewarder.Claim[](1);
        reClaims[0] = BuggyRewarder.Claim({
            batchNumber: 0,
            amount: 100,
            tokenIndex: 0
        });

        // This should revert ("Already claimed"), but the bug allows it
        vm.prank(claimer);
        try rewarder.claimRewards(reClaims, tokens) {
            // If we reach here, the double claim succeeded -- BUG!
            assert(false); // "Double claim should be prevented"
        } catch {
            // Expected: should revert
            assert(true);
        }
    }
}
