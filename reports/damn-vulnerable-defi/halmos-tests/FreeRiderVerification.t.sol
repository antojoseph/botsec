// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/**
 * @title FreeRiderNFTMarketplace Formal Verification
 * @notice Verifies two critical vulnerabilities in the marketplace:
 *
 * VULNERABILITY 1 (msg.value reuse):
 *   buyMany() loops through _buyOne(), each checking msg.value < priceToPay.
 *   But msg.value stays the same across iterations, so buying N items at price P
 *   only requires P ETH total, not N*P.
 *
 * VULNERABILITY 2 (payment goes to buyer):
 *   _buyOne() transfers NFT to buyer (line 105), then calls _token.ownerOf(tokenId)
 *   (line 108) which NOW returns the buyer. So the payment goes to the buyer, not seller.
 *
 * We use simplified mock contracts to isolate the logic bugs.
 */

/// @notice Simplified NFT mock
contract MockNFT {
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _approvals;

    function mint(address to, uint256 tokenId) external {
        _owners[tokenId] = to;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owners[tokenId];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _approvals[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        _approvals[tokenId] = to;
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(_owners[tokenId] == from, "Not owner");
        _owners[tokenId] = to;
    }
}

/// @notice Simplified marketplace that replicates the exact bugs
contract BuggyMarketplace {
    MockNFT public token;
    mapping(uint256 => uint256) public offers;
    uint256 public offersCount;

    error TokenNotOffered(uint256);
    error InsufficientPayment();

    constructor(MockNFT _token) {
        token = _token;
    }

    function setOffer(uint256 tokenId, uint256 price) external {
        offers[tokenId] = price;
        offersCount++;
    }

    function buyMany(uint256[] calldata tokenIds) external payable {
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            _buyOne(tokenIds[i]);
        }
    }

    function _buyOne(uint256 tokenId) private {
        uint256 priceToPay = offers[tokenId];
        if (priceToPay == 0) revert TokenNotOffered(tokenId);

        // BUG 1: msg.value is checked per-item but doesn't decrease
        if (msg.value < priceToPay) revert InsufficientPayment();

        --offersCount;

        // BUG 2: Transfer NFT to buyer first
        token.safeTransferFrom(token.ownerOf(tokenId), msg.sender, tokenId);

        // BUG 2: ownerOf now returns msg.sender (buyer), so payment goes to buyer!
        payable(token.ownerOf(tokenId)).call{value: priceToPay}("");
    }

    receive() external payable {}
}

/// @custom:halmos --solver-timeout-assertion 10000
contract FreeRiderVerification is SymTest, Test {
    MockNFT nft;
    BuggyMarketplace marketplace;

    address seller;
    address buyer;

    uint256 constant NFT_PRICE = 10 ether;

    function setUp() public {
        nft = new MockNFT();
        marketplace = new BuggyMarketplace(nft);

        seller = address(0x5E11);
        buyer = address(0xB0B0);

        // Mint NFTs to seller
        nft.mint(seller, 0);
        nft.mint(seller, 1);

        // Seller approves marketplace
        vm.startPrank(seller);
        nft.approve(address(marketplace), 0);
        nft.approve(address(marketplace), 1);
        vm.stopPrank();

        // Seller lists NFTs
        marketplace.setOffer(0, NFT_PRICE);
        marketplace.setOffer(1, NFT_PRICE);

        // Fund marketplace with some ETH (simulating previous sales)
        vm.deal(address(marketplace), 100 ether);
    }

    /**
     * Property: Buying 2 NFTs at 10 ETH each should drain 20 ETH from the marketplace reserves
     * when combined with the msg.value reuse bug and payment-to-buyer bug.
     *
     * With both bugs: buyer sends 10 ETH, gets 2 NFTs, receives 20 ETH back (10 per NFT).
     * Marketplace loses 10 ETH net from reserves (received 10, paid out 20).
     *
     * Expected: FAIL -- marketplace loses reserves.
     */
    function check_msg_value_reuse_drains_reserves() public {
        vm.deal(buyer, NFT_PRICE);  // Only 10 ETH, not 20

        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = 0;
        tokenIds[1] = 1;

        uint256 marketplaceBalBefore = address(marketplace).balance;  // 100 ETH

        vm.prank(buyer);
        marketplace.buyMany{value: NFT_PRICE}(tokenIds);  // Send only 10 ETH for 2 NFTs

        // After: marketplace received 10 ETH (msg.value), but paid 20 ETH to buyer (10 per NFT)
        // Marketplace should have at least its initial reserves after a legitimate purchase
        assertGe(
            address(marketplace).balance,
            marketplaceBalBefore,
            "Marketplace should not lose reserves from purchases"
        );
    }

    /**
     * Property: After buying an NFT, the payment should go to the seller, not the buyer.
     * The seller's balance should increase by the NFT price.
     *
     * Expected: FAIL -- payment goes to buyer due to ownerOf returning buyer after transfer.
     */
    function check_payment_goes_to_seller() public {
        vm.deal(buyer, NFT_PRICE);

        uint256[] memory tokenIds = new uint256[](1);
        tokenIds[0] = 0;

        uint256 sellerBalBefore = seller.balance;
        uint256 buyerBalBefore = buyer.balance;

        vm.prank(buyer);
        marketplace.buyMany{value: NFT_PRICE}(tokenIds);

        uint256 sellerReceived = seller.balance - sellerBalBefore;

        // Property: seller should receive the payment
        assertEq(sellerReceived, NFT_PRICE, "Seller should receive the NFT price");
    }

    /**
     * Property: After buying, the buyer's net cost should be positive (they pay, not get paid).
     *
     * Expected: FAIL -- buyer actually RECEIVES ETH because payment goes to them.
     */
    function check_buyer_net_cost_positive() public {
        vm.deal(buyer, NFT_PRICE);

        uint256[] memory tokenIds = new uint256[](1);
        tokenIds[0] = 0;

        uint256 buyerBalBefore = buyer.balance;

        vm.prank(buyer);
        marketplace.buyMany{value: NFT_PRICE}(tokenIds);

        uint256 buyerBalAfter = buyer.balance;

        // Property: buyer should have less ETH after buying (positive net cost)
        assertLt(buyerBalAfter, buyerBalBefore, "Buyer should spend ETH when buying");
    }
}
