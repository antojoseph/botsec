// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";

/**
 * @title UnstoppableVault Formal Verification
 * @notice Verifies that direct token transfers break the flash loan invariant.
 *
 * VULNERABILITY: The flash loan function checks:
 *   if (convertToShares(totalSupply) != balanceBefore) revert InvalidBalance();
 *
 * where balanceBefore = totalAssets() = asset.balanceOf(address(this))
 * and convertToShares(totalSupply) = totalSupply * totalSupply / totalAssets()
 *
 * When totalAssets() == totalSupply (1:1 ratio after clean deposits), this holds.
 * But a direct transfer (donation) increases totalAssets() without increasing totalSupply,
 * breaking the invariant permanently and DOSing all flash loans.
 *
 * Simplified check: totalSupply == token.balanceOf(vault) must hold for flash loans.
 * A direct transfer breaks this because balanceOf increases but totalSupply does not.
 */

/// @notice Simplified mock vault that captures the essential invariant
contract MockVault {
    ERC20 public asset;
    uint256 public totalSupply;

    error InvalidBalance();

    constructor(ERC20 _asset) {
        asset = _asset;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Simplified deposit: 1:1 ratio
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = assets; // 1:1 when totalSupply == totalAssets or first deposit
        totalSupply += shares;
        asset.transferFrom(msg.sender, address(this), assets);
    }

    /// @notice The invariant check from UnstoppableVault.flashLoan
    function checkInvariant() external view returns (bool) {
        if (totalSupply == 0) return true;
        // convertToShares(totalSupply) = totalSupply.mulDivDown(totalSupply, totalAssets())
        // For this to equal totalAssets(), we need:
        // totalSupply * totalSupply / totalAssets() == totalAssets()
        // Which simplifies to: totalSupply^2 == totalAssets()^2
        // i.e., totalSupply == totalAssets() (assuming positive values)
        return totalSupply == totalAssets();
    }
}

/// @notice Simple ERC20 for testing
contract SimpleToken is ERC20 {
    constructor() ERC20("Test", "TST", 18) {
        _mint(msg.sender, type(uint128).max);
    }
}

/// @custom:halmos --solver-timeout-assertion 10000
contract UnstoppableVerification is SymTest, Test {
    SimpleToken token;
    MockVault vault;

    address depositor;
    address attacker;

    uint256 constant INITIAL_DEPOSIT = 100 ether;
    uint256 constant ATTACKER_BALANCE = 10 ether;

    function setUp() public {
        token = new SimpleToken();
        vault = new MockVault(token);

        depositor = address(0x1);
        attacker = address(0x2);

        // Fund depositor and have them deposit into vault
        token.transfer(depositor, INITIAL_DEPOSIT);
        vm.startPrank(depositor);
        token.approve(address(vault), INITIAL_DEPOSIT);
        vault.deposit(INITIAL_DEPOSIT, depositor);
        vm.stopPrank();

        // Fund attacker
        token.transfer(attacker, ATTACKER_BALANCE);
    }

    /**
     * Property: Before any attack, the invariant holds.
     * Expected: PASS
     */
    function check_invariant_holds_after_clean_deposit() public view {
        assert(vault.checkInvariant());
    }

    /**
     * Property: After a direct token transfer (donation), the invariant breaks.
     * This is the core vulnerability: totalAssets() increases but totalSupply does not.
     *
     * Expected: FAIL -- the invariant no longer holds after donation.
     */
    function check_donation_breaks_flashloan_invariant(uint256 amount) public {
        vm.assume(amount > 0 && amount <= ATTACKER_BALANCE);

        // Verify invariant holds before attack
        assert(vault.checkInvariant());

        // Attack: direct transfer bypasses deposit(), increasing totalAssets
        // without increasing totalSupply
        vm.prank(attacker);
        token.transfer(address(vault), amount);

        // After donation: totalAssets = INITIAL_DEPOSIT + amount, totalSupply = INITIAL_DEPOSIT
        // These are no longer equal, so the invariant is broken
        assert(vault.checkInvariant()); // This SHOULD hold but WILL FAIL
    }

    /**
     * Property: After a legitimate deposit (not a direct transfer), the invariant
     * should still hold.
     *
     * Expected: PASS
     */
    function check_deposit_preserves_invariant(uint256 amount) public {
        vm.assume(amount > 0 && amount <= ATTACKER_BALANCE);

        // Invariant holds before
        assert(vault.checkInvariant());

        // Legitimate deposit
        vm.startPrank(attacker);
        token.approve(address(vault), amount);
        vault.deposit(amount, attacker);
        vm.stopPrank();

        // Invariant should still hold after legitimate deposit
        assert(vault.checkInvariant());
    }
}
