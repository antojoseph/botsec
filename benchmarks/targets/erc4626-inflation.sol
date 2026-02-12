// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title InflatableVault
 * @notice Benchmark: ERC4626-style vault vulnerable to the inflation/donation attack.
 *
 * The first depositor attack works as follows:
 * 1. Attacker deposits 1 wei → gets 1 share
 * 2. Attacker "donates" a large amount directly to the vault (transfer, not deposit)
 * 3. Victim deposits — due to rounding in share calculation, they get 0 shares
 * 4. Attacker withdraws all funds (including victim's deposit)
 *
 * This is a real vulnerability pattern seen in many ERC4626 implementations.
 * The fix is to use virtual shares/assets (OpenZeppelin's approach) or enforce
 * a minimum deposit.
 */

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract InflatableVault {
    IERC20 public immutable asset;

    mapping(address => uint256) public shareBalances;
    uint256 public totalShares;

    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed caller,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    constructor(address _asset) {
        asset = IERC20(_asset);
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /**
     * @notice Convert asset amount to share amount.
     * BUG: No virtual offset — when totalShares is low and totalAssets is
     * inflated via donation, this rounds down to 0 for the victim.
     */
    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalShares;
        if (supply == 0) {
            return assets; // 1:1 for first deposit
        }
        return (assets * supply) / totalAssets();
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalShares;
        if (supply == 0) {
            return shares;
        }
        return (shares * totalAssets()) / supply;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        // BUG: No check for shares > 0 — victim gets 0 shares
        asset.transferFrom(msg.sender, address(this), assets);
        shareBalances[receiver] += shares;
        totalShares += shares;
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) external returns (uint256 shares) {
        shares = convertToShares(assets);
        if (msg.sender != owner) {
            revert("Not owner");
        }
        require(shareBalances[owner] >= shares, "Insufficient shares");
        shareBalances[owner] -= shares;
        totalShares -= shares;
        asset.transfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) external returns (uint256 assets) {
        if (msg.sender != owner) {
            revert("Not owner");
        }
        require(shareBalances[owner] >= shares, "Insufficient shares");
        assets = convertToAssets(shares);
        shareBalances[owner] -= shares;
        totalShares -= shares;
        asset.transfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }
}
