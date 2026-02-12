// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {VulnerableVault} from "../../benchmarks/targets/reentrancy-vault.sol";

/**
 * @title VaultVerification
 * @notice Manual Halmos test for the reentrancy vault benchmark.
 *         Validates the toolchain works end-to-end.
 */
contract VaultVerification is SymTest, Test {
    VulnerableVault vault;

    function setUp() public {
        vault = new VulnerableVault();
    }

    /// @notice After deposit, user balance should equal deposited amount
    function check_deposit_increases_balance(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 100 ether);
        address user = svm.createAddress("user");
        vm.deal(user, amount);

        vm.prank(user);
        vault.deposit{value: amount}();

        assertEq(vault.balances(user), amount);
    }

    /// @notice Total deposits should equal sum of all deposits
    function check_total_deposits_consistent(uint256 a, uint256 b) public {
        vm.assume(a > 0 && a <= 50 ether);
        vm.assume(b > 0 && b <= 50 ether);

        address alice = svm.createAddress("alice");
        address bob = svm.createAddress("bob");
        vm.assume(alice != bob);

        vm.deal(alice, a);
        vm.deal(bob, b);

        vm.prank(alice);
        vault.deposit{value: a}();
        vm.prank(bob);
        vault.deposit{value: b}();

        assertEq(vault.totalDeposits(), a + b);
    }

    /// @notice Vault balance should always be >= totalDeposits (solvency)
    /// This SHOULD pass for normal operations but can be violated via reentrancy
    function check_solvency_after_deposit_withdraw(uint256 depositAmt, uint256 withdrawAmt) public {
        vm.assume(depositAmt > 0 && depositAmt <= 100 ether);
        vm.assume(withdrawAmt > 0 && withdrawAmt <= depositAmt);

        address user = svm.createAddress("user");
        vm.deal(user, depositAmt);

        vm.prank(user);
        vault.deposit{value: depositAmt}();

        vm.prank(user);
        vault.withdraw(withdrawAmt);

        // Solvency: vault's ETH balance should match accounting
        assertGe(address(vault).balance, vault.totalDeposits());
    }

    /// @notice No user can withdraw more than their balance
    function check_no_over_withdrawal(uint256 depositAmt, uint256 withdrawAmt) public {
        vm.assume(depositAmt > 0 && depositAmt <= 100 ether);
        vm.assume(withdrawAmt > depositAmt); // Intentionally try to withdraw more

        address user = svm.createAddress("user");
        vm.deal(user, depositAmt);

        vm.prank(user);
        vault.deposit{value: depositAmt}();

        // This should revert — Halmos will confirm the revert path
        // (Halmos ignores reverting paths, so if this passes, it means
        //  there's NO non-reverting path where withdrawAmt > depositAmt succeeds)
        vm.prank(user);
        vault.withdraw(withdrawAmt);

        // If we reach here, the withdraw didn't revert — that's a bug
        assert(false);
    }
}
