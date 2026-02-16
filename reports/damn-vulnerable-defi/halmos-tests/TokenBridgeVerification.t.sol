// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/**
 * @title TokenBridge Formal Verification
 * @notice Verifies the access control logic in TokenBridge.executeTokenWithdrawal
 *
 * VULNERABILITY: The authorization check is INVERTED.
 *   if (msg.sender != address(l1Forwarder) || l1Forwarder.getSender() == otherBridge) revert Unauthorized();
 *
 * This REVERTS when getSender() returns otherBridge (the LEGITIMATE sender).
 * This ALLOWS execution when getSender() returns anything ELSE (unauthorized senders).
 * Correct logic should be: != otherBridge (revert if NOT the bridge)
 */

/// @notice Minimal mock of the L1Forwarder -- just stores a sender context
contract MockL1Forwarder {
    address public senderContext;

    function setSender(address _sender) external {
        senderContext = _sender;
    }

    function getSender() external view returns (address) {
        return senderContext;
    }
}

/// @notice Minimal mock of DamnValuableToken for the bridge test
contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Simplified TokenBridge that replicates the exact buggy logic
contract BuggyTokenBridge {
    MockToken public immutable token;
    MockL1Forwarder public immutable l1Forwarder;
    address public immutable otherBridge;
    uint256 public totalDeposits;

    error Unauthorized();

    constructor(MockToken _token, MockL1Forwarder _forwarder, address _otherBridge) {
        token = _token;
        l1Forwarder = _forwarder;
        otherBridge = _otherBridge;
    }

    function executeTokenWithdrawal(address receiver, uint256 amount) external {
        // BUG: This is the exact code from the real contract
        // It reverts when getSender() == otherBridge (the legitimate case!)
        if (msg.sender != address(l1Forwarder) || l1Forwarder.getSender() == otherBridge) revert Unauthorized();
        totalDeposits -= amount;
        token.transfer(receiver, amount);
    }
}

/// @custom:halmos --solver-timeout-assertion 10000
contract TokenBridgeVerification is SymTest, Test {
    MockToken token;
    MockL1Forwarder forwarder;
    BuggyTokenBridge bridge;
    address otherBridgeAddr;

    uint256 constant BRIDGE_INITIAL_BALANCE = 1000 ether;
    uint256 constant INITIAL_DEPOSITS = 1000 ether;

    function setUp() public {
        token = new MockToken();
        forwarder = new MockL1Forwarder();
        otherBridgeAddr = address(0xBEEF);

        bridge = new BuggyTokenBridge(token, forwarder, otherBridgeAddr);

        // Give the bridge tokens
        token.mint(address(bridge), BRIDGE_INITIAL_BALANCE);

        // Set totalDeposits via a direct storage write since it's internal
        // Use vm.store to set totalDeposits (slot depends on layout)
        // Actually, totalDeposits is after 3 immutables, so it's at slot 0
        vm.store(address(bridge), bytes32(uint256(0)), bytes32(INITIAL_DEPOSITS));
    }

    /**
     * Property: When msg.sender IS the l1Forwarder AND getSender() returns otherBridge,
     * the withdrawal SHOULD succeed. But due to the inverted logic, it reverts.
     *
     * We use try/catch to detect the revert. If the legitimate path reverts, that's the bug.
     * Expected: FAIL -- assert(false) fires because the legitimate path always reverts.
     */
    function check_legitimate_bridge_can_withdraw(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 100 ether);

        address receiver = address(0x1234);

        // Set up the legitimate call path
        forwarder.setSender(otherBridgeAddr);

        // Call from the forwarder (legitimate sender)
        vm.prank(address(forwarder));
        try bridge.executeTokenWithdrawal(receiver, amount) {
            // If we reach here, the legitimate call succeeded (correct behavior)
            assert(true);
        } catch {
            // BUG: The legitimate call path reverts due to inverted logic
            assert(false); // "Legitimate bridge call should not revert"
        }
    }

    /**
     * Property: When getSender() returns something OTHER than otherBridge,
     * the withdrawal SHOULD revert (unauthorized). But due to the inverted logic,
     * it actually SUCCEEDS.
     *
     * Expected: FAIL -- unauthorized calls are allowed through.
     */
    function check_unauthorized_sender_blocked(address fakeSender) public {
        vm.assume(fakeSender != otherBridgeAddr);
        vm.assume(fakeSender != address(0));

        // Set up an unauthorized sender context
        forwarder.setSender(fakeSender);

        address receiver = address(0x1234);
        uint256 amount = 1 ether;
        uint256 receiverBalBefore = token.balanceOf(receiver);

        // Call from the forwarder but with wrong context sender
        vm.prank(address(forwarder));
        // This should revert for unauthorized senders
        // We use try/catch: if it succeeds, that's a bug
        try bridge.executeTokenWithdrawal(receiver, amount) {
            // If we reach here, the unauthorized call succeeded -- BUG!
            assert(false); // "Unauthorized sender should be blocked"
        } catch {
            // Expected: should revert for unauthorized senders
            assert(true);
        }
    }

    /**
     * Property: A caller that is NOT the l1Forwarder should always be blocked.
     * This property SHOULD hold even with the bug (the first condition catches it).
     */
    function check_non_forwarder_always_blocked(address caller, uint256 amount) public {
        vm.assume(caller != address(forwarder));
        vm.assume(amount > 0 && amount <= 100 ether);

        address receiver = address(0x5678);

        vm.prank(caller);
        try bridge.executeTokenWithdrawal(receiver, amount) {
            assert(false); // Should never succeed for non-forwarder callers
        } catch {
            assert(true); // Expected revert
        }
    }
}
