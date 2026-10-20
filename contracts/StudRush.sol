// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Stud Rush
/// @notice A three-button STUD shop. Every pack is 100 STUD for 0.001 ETH.
///         Each button adds a bonus on top of the pack, the bonus shrinks with every
///         purchase and slowly recovers, and after ANYONE buys a button it is locked
///         for ALL players for a cooldown. Holding GAME adds an extra perk.
/// @dev    Bonuses are in basis points (100 = 1.00%). block.timestamp is only used for
///         cooldowns and recovery, never for randomness.
contract StudRush {
    struct Offer {
        uint16 startBonus; // best bonus of the button
        uint16 decay;      // bonus lost after every purchase
        uint16 minBonus;   // bonus never drops below this
        uint32 cooldown;   // seconds the button is locked for everyone
    }

    struct OfferState {
        uint16 bonus;      // stored bonus (recovery is added on read)
        uint64 bonusAt;    // when `bonus` was stored
        uint64 readyAt;    // button is locked for everyone until this time
        uint32 sold;       // packs sold through this button
        address lastBuyer;
    }

    struct OfferView {
        uint16 bonus;
        uint16 startBonus;
        uint16 decay;
        uint16 minBonus;
        uint32 cooldown;
        uint64 readyAt;
        uint32 sold;
        address lastBuyer;
    }

    struct PlayerView {
        uint32 purchases;
        uint256 studBought;
        uint256 bonusEarned;
        bool gamePerk;
    }

    uint256 public constant PACK = 100 ether;        // 100 STUD (18 decimals)
    uint256 public constant PRICE = 0.001 ether;     // ETH per pack
    uint256 public constant MAX_BUYS = 10;           // packs per wallet
    uint256 public constant GAME_PERK = 100;         // +1.00% for GAME holders
    uint256 public constant GAME_PERK_MIN = 1 ether; // 1 GAME needed for the perk
    uint256 public constant REGEN_PER_MINUTE = 10;   // +0.10% per idle minute

    IERC20 public immutable stud;
    IERC20 public immutable gameToken; // address(0) disables the GAME perk
    address public immutable owner;

    Offer[3] public offers;
    OfferState[3] public states;

    mapping(address => uint32) public purchases;
    mapping(address => uint256) public studBought;
    mapping(address => uint256) public bonusEarned;
    uint256 public totalPurchases;

    event Purchased(
        address indexed buyer,
        uint8 indexed offerId,
        uint256 studReceived,
        uint256 bonusStud,
        uint16 bonusBps,
        uint64 lockedUntil
    );

    constructor(address studAddress, address gameAddress) {
        require(studAddress != address(0) && studAddress.code.length > 0, "STUD address invalid");
        require(gameAddress == address(0) || gameAddress.code.length > 0, "GAME address invalid");
        stud = IERC20(studAddress);
        gameToken = IERC20(gameAddress);
        owner = msg.sender;

        offers[0] = Offer(500, 50, 100, 30);  // 5.00%, -0.50% per buy, floor 1.00%, 30 s lock
        offers[1] = Offer(300, 25, 50, 60);   // 3.00%, -0.25% per buy, floor 0.50%, 60 s lock
        offers[2] = Offer(100, 10, 10, 120);  // 1.00%, -0.10% per buy, floor 0.10%, 120 s lock
        for (uint256 i = 0; i < 3; i++) {
            states[i].bonus = offers[i].startBonus;
            states[i].bonusAt = uint64(block.timestamp);
        }
    }

    /// @notice Buy one pack through button `offerId` (0, 1 or 2) by sending exactly PRICE.
    function buy(uint8 offerId) external payable {
        require(offerId < 3, "Unknown offer");
        require(msg.value == PRICE, "Send exactly 0.001 ETH");
        require(purchases[msg.sender] < MAX_BUYS, "Wallet limit reached");

        OfferState storage s = states[offerId];
        require(block.timestamp >= s.readyAt, "Offer is cooling down");

        Offer memory o = offers[offerId];
        uint16 bonus = currentBonus(offerId);
        uint256 perk = hasGamePerk(msg.sender) ? GAME_PERK : 0;
        uint256 bonusStud = (PACK * (bonus + perk)) / 10_000;
        uint256 total = PACK + bonusStud;
        require(stud.balanceOf(address(this)) >= total, "Shop is out of STUD");

        // effects
        s.bonus = bonus > o.minBonus + o.decay ? bonus - o.decay : o.minBonus;
        s.bonusAt = uint64(block.timestamp);
        s.readyAt = uint64(block.timestamp + o.cooldown);
        s.sold += 1;
        s.lastBuyer = msg.sender;

        purchases[msg.sender] += 1;
        studBought[msg.sender] += total;
        bonusEarned[msg.sender] += bonusStud;
        totalPurchases += 1;

        emit Purchased(msg.sender, offerId, total, bonusStud, bonus, s.readyAt);

        // interaction
        require(stud.transfer(msg.sender, total), "STUD transfer failed");
    }

    /// @notice Bonus a buyer would get right now (stored bonus plus idle recovery).
    function currentBonus(uint8 offerId) public view returns (uint16) {
        OfferState memory s = states[offerId];
        uint256 regen = ((block.timestamp - s.bonusAt) / 60) * REGEN_PER_MINUTE;
        uint256 b = uint256(s.bonus) + regen;
        uint256 best = offers[offerId].startBonus;
        return uint16(b > best ? best : b);
    }

    function hasGamePerk(address player) public view returns (bool) {
        return address(gameToken) != address(0) && gameToken.balanceOf(player) >= GAME_PERK_MIN;
    }

    function getOffers() external view returns (OfferView[3] memory out) {
        for (uint8 i = 0; i < 3; i++) {
            out[i] = OfferView(
                currentBonus(i),
                offers[i].startBonus,
                offers[i].decay,
                offers[i].minBonus,
                offers[i].cooldown,
                states[i].readyAt,
                states[i].sold,
                states[i].lastBuyer
            );
        }
    }

    function getPlayer(address player) external view returns (PlayerView memory) {
        return PlayerView(purchases[player], studBought[player], bonusEarned[player], hasGamePerk(player));
    }

    function stock() external view returns (uint256) {
        return stud.balanceOf(address(this));
    }

    // --- owner housekeeping -------------------------------------------------

    function withdrawEth() external {
        require(msg.sender == owner, "Only owner");
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "ETH transfer failed");
    }

    function withdrawStud() external {
        require(msg.sender == owner, "Only owner");
        require(stud.transfer(owner, stud.balanceOf(address(this))), "STUD transfer failed");
    }
}
