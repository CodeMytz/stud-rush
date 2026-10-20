// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Stud Rush
/// @notice A STUD shop with three tiers (Rush, Steady, Bargain bin) and four options in each.
///         Every pack is 100 STUD for 0.001 ETH. Each option pays a bonus built with COMPOUND
///         interest ("salikti procenti"): the pack grows by `rate` percent for `rounds` rounds,
///         and then a flat fee is taken off the bonus:
///
///             bonus = PACK * (1 + rate)^rounds - PACK - fee
///
///         The rate of an option shrinks with every purchase and slowly recovers, and after
///         ANYONE buys an option it is locked for ALL players for a cooldown that depends on
///         the tier. Holding GAME adds an extra flat perk.
/// @dev    Rates are in basis points (100 = 1.00%). The compound loop runs at most MAX_ROUNDS
///         times and uses integer maths, so the page can reproduce the result exactly.
///         block.timestamp is only used for cooldowns and recovery, never for randomness.
contract StudRush {
    struct Offer {
        uint16 startRate;  // best rate per round of the option (bps)
        uint16 decay;      // rate lost after every purchase (bps)
        uint16 minRate;    // rate never drops below this (bps)
        uint8 rounds;      // how many times the rate is compounded
        uint16 feeBps;     // flat fee taken from the bonus, in bps of PACK (100 = 1 STUD)
        uint32 cooldown;   // seconds the option is locked for everyone
    }

    struct OfferState {
        uint16 rate;       // stored rate (recovery is added on read)
        uint64 rateAt;     // when `rate` was stored
        uint64 readyAt;    // option is locked for everyone until this time
        uint32 sold;       // packs sold through this option
        address lastBuyer;
    }

    struct OfferView {
        uint16 rate;
        uint16 startRate;
        uint16 decay;
        uint16 minRate;
        uint8 rounds;
        uint16 feeBps;
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

    uint256 public constant OFFER_COUNT = 12;        // 3 tiers x 4 options
    uint256 public constant TIER_SIZE = 4;
    uint256 public constant PACK = 100 ether;        // 100 STUD (18 decimals)
    uint256 public constant PRICE = 0.001 ether;     // ETH per pack
    uint256 public constant MAX_BUYS = 10;           // packs per wallet
    uint256 public constant MAX_ROUNDS = 30;
    uint256 public constant GAME_PERK = 100;         // +1.00% of a pack (flat) for GAME holders
    uint256 public constant GAME_PERK_MIN = 1 ether; // 1 GAME needed for the perk
    uint256 public constant REGEN_PER_MINUTE = 5;    // +0.05% rate per idle minute

    IERC20 public immutable stud;
    IERC20 public immutable gameToken; // address(0) disables the GAME perk
    address public immutable owner;

    Offer[12] public offers;
    OfferState[12] public states;

    mapping(address => uint32) public purchases;
    mapping(address => uint256) public studBought;
    mapping(address => uint256) public bonusEarned;
    uint256 public totalPurchases;

    event Purchased(
        address indexed buyer,
        uint8 indexed offerId,
        uint256 studReceived,
        uint256 bonusStud,
        uint16 rateBps,
        uint64 lockedUntil
    );

    constructor(address studAddress, address gameAddress) {
        require(studAddress != address(0) && studAddress.code.length > 0, "STUD address invalid");
        require(gameAddress == address(0) || gameAddress.code.length > 0, "GAME address invalid");
        stud = IERC20(studAddress);
        gameToken = IERC20(gameAddress);
        owner = msg.sender;

        //                  start  decay  floor rounds fee   lock
        // Tier 0: Rush (30 s). Big rates, few rounds.
        offers[0]  = Offer(500,   50,   100,  2,   0,    30);  // 5.00% x 2
        offers[1]  = Offer(300,   30,    60,  4,   50,   30);  // 3.00% x 4, fee 0.50 STUD
        offers[2]  = Offer(200,   20,    40,  6,   100,  30);  // 2.00% x 6, fee 1.00 STUD
        offers[3]  = Offer(125,   12,    25,  10,  150,  30);  // 1.25% x 10, fee 1.50 STUD
        // Tier 1: Steady (60 s).
        offers[4]  = Offer(350,   35,    70,  2,   0,    60);  // 3.50% x 2
        offers[5]  = Offer(180,   18,    36,  5,   25,   60);  // 1.80% x 5, fee 0.25 STUD
        offers[6]  = Offer(70,     7,    14,  12,  50,   60);  // 0.70% x 12, fee 0.50 STUD
        offers[7]  = Offer(45,     5,    10,  24,  250,  60);  // 0.45% x 24, fee 2.50 STUD
        // Tier 2: Bargain bin (120 s). Small rates, many rounds, tiny fees.
        offers[8]  = Offer(150,   15,    30,  3,   0,    120); // 1.50% x 3
        offers[9]  = Offer(80,     8,    16,  6,   10,   120); // 0.80% x 6, fee 0.10 STUD
        offers[10] = Offer(40,     4,     8,  12,  25,   120); // 0.40% x 12, fee 0.25 STUD
        offers[11] = Offer(25,     3,     5,  20,  40,   120); // 0.25% x 20, fee 0.40 STUD
        for (uint256 i = 0; i < OFFER_COUNT; i++) {
            require(offers[i].rounds <= MAX_ROUNDS, "Too many rounds");
            states[i].rate = offers[i].startRate;
            states[i].rateAt = uint64(block.timestamp);
        }
    }

    /// @notice Buy one pack through option `offerId` (0..11) by sending exactly PRICE.
    function buy(uint8 offerId) external payable {
        require(offerId < OFFER_COUNT, "Unknown offer");
        require(msg.value == PRICE, "Send exactly 0.001 ETH");
        require(purchases[msg.sender] < MAX_BUYS, "Wallet limit reached");

        OfferState storage s = states[offerId];
        require(block.timestamp >= s.readyAt, "Offer is cooling down");

        Offer memory o = offers[offerId];
        uint16 rate = currentRate(offerId);
        uint256 bonusStud = bonusFor(rate, o.rounds, o.feeBps, hasGamePerk(msg.sender));
        uint256 total = PACK + bonusStud;
        require(stud.balanceOf(address(this)) >= total, "Shop is out of STUD");

        // effects
        s.rate = rate > o.minRate + o.decay ? rate - o.decay : o.minRate;
        s.rateAt = uint64(block.timestamp);
        s.readyAt = uint64(block.timestamp + o.cooldown);
        s.sold += 1;
        s.lastBuyer = msg.sender;

        purchases[msg.sender] += 1;
        studBought[msg.sender] += total;
        bonusEarned[msg.sender] += bonusStud;
        totalPurchases += 1;

        emit Purchased(msg.sender, offerId, total, bonusStud, rate, s.readyAt);

        // interaction
        require(stud.transfer(msg.sender, total), "STUD transfer failed");
    }

    /// @notice Compound interest: PACK * (1 + rate)^rounds, minus PACK and the flat fee
    ///         (never below zero), plus the flat GAME perk when `perk` is true.
    function bonusFor(uint256 rateBps, uint8 rounds, uint16 feeBps, bool perk) public pure returns (uint256) {
        uint256 amount = PACK;
        for (uint256 i = 0; i < rounds; i++) {
            amount = (amount * (10_000 + rateBps)) / 10_000;
        }
        uint256 gross = amount - PACK;
        uint256 fee = (PACK * feeBps) / 10_000;
        uint256 net = gross > fee ? gross - fee : 0;
        return perk ? net + (PACK * GAME_PERK) / 10_000 : net;
    }

    /// @notice Bonus STUD a buyer would get from `offerId` right now.
    function quote(uint8 offerId, bool perk) external view returns (uint256) {
        require(offerId < OFFER_COUNT, "Unknown offer");
        Offer memory o = offers[offerId];
        return bonusFor(currentRate(offerId), o.rounds, o.feeBps, perk);
    }

    /// @notice Rate per round a buyer would get right now (stored rate plus idle recovery).
    function currentRate(uint8 offerId) public view returns (uint16) {
        OfferState memory s = states[offerId];
        uint256 regen = ((block.timestamp - s.rateAt) / 60) * REGEN_PER_MINUTE;
        uint256 r = uint256(s.rate) + regen;
        uint256 best = offers[offerId].startRate;
        return uint16(r > best ? best : r);
    }

    function hasGamePerk(address player) public view returns (bool) {
        return address(gameToken) != address(0) && gameToken.balanceOf(player) >= GAME_PERK_MIN;
    }

    function getOffers() external view returns (OfferView[12] memory out) {
        for (uint8 i = 0; i < OFFER_COUNT; i++) {
            Offer memory o = offers[i];
            OfferState memory s = states[i];
            out[i] = OfferView(
                currentRate(i), o.startRate, o.decay, o.minRate, o.rounds, o.feeBps,
                o.cooldown, s.readyAt, s.sold, s.lastBuyer
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
