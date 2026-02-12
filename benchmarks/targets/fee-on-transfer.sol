// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title FeePool
 * @notice Benchmark: A staking pool that doesn't account for fee-on-transfer tokens.
 *
 * Many tokens (like USDT, STA, PAXG) charge a transfer fee. When the pool
 * calls transferFrom(), the actual amount received is less than the amount
 * parameter. But the pool credits the full amount to the user's balance.
 *
 * This means:
 * - User stakes 100 tokens, pool receives 98 (2% fee), credits 100
 * - User withdraws 100, pool sends 100 but only has 98
 * - Last staker can't withdraw — pool is insolvent
 *
 * Halmos can prove the insolvency invariant violation:
 *   assert(token.balanceOf(pool) >= totalStaked)
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract FeePool {
    IERC20 public immutable stakingToken;

    mapping(address => uint256) public staked;
    uint256 public totalStaked;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);

    constructor(address _token) {
        stakingToken = IERC20(_token);
    }

    /**
     * @notice Stake tokens into the pool.
     * BUG: Credits `amount` to user, but if the token has a transfer fee,
     * the pool receives less than `amount`. Should check balance before/after.
     */
    function stake(uint256 amount) external {
        require(amount > 0, "Cannot stake 0");

        // BUG: Doesn't check actual received amount
        stakingToken.transferFrom(msg.sender, address(this), amount);

        // Credits the full requested amount, not the actual received amount
        staked[msg.sender] += amount;
        totalStaked += amount;

        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Unstake and receive tokens back.
     */
    function unstake(uint256 amount) external {
        require(staked[msg.sender] >= amount, "Insufficient stake");

        staked[msg.sender] -= amount;
        totalStaked -= amount;

        // This will fail for the last unstaker if token has transfer fees
        stakingToken.transfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    /**
     * @notice Get the pool's actual token balance.
     */
    function poolBalance() external view returns (uint256) {
        return stakingToken.balanceOf(address(this));
    }
}
