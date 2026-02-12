// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title VulnerableVault
 * @notice Benchmark: A simple ETH vault with a reentrancy vulnerability.
 *
 * The withdraw() function sends ETH before updating state, allowing a
 * reentrancy attack via a malicious receive() fallback. This is a classic
 * CEI (Checks-Effects-Interactions) violation.
 *
 * Slither and static analyzers may flag the raw .call(), but the subtle
 * cross-function reentrancy (withdraw → receive → withdraw) is the real
 * issue that Halmos can prove exploitable with a concrete counterexample.
 */
contract VulnerableVault {
    mapping(address => uint256) public balances;
    uint256 public totalDeposits;

    event Deposit(address indexed user, uint256 amount);
    event Withdrawal(address indexed user, uint256 amount);

    function deposit() external payable {
        require(msg.value > 0, "Must deposit > 0");
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "Insufficient balance");

        // BUG: Sends ETH BEFORE updating state (CEI violation)
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        // State update happens AFTER external call — reentrancy window
        balances[msg.sender] -= amount;
        totalDeposits -= amount;

        emit Withdrawal(msg.sender, amount);
    }

    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    function getVaultBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
