// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DealTable} from "./DealTable.sol";

/// @title Yield Arena
/// @notice Compound-interest duel game on Ethereum Sepolia.
///  - Anyone can open a lobby with `createGame()`; other players `join(id)`. Creating and joining both cost
///    ENTRY STUD (50) pulled with approve + transferFrom. The lobby has NO timer: it waits for players.
///  - The host calls `start(id)` once at least 2 players are in (a full lobby of 16 starts by itself).
///    Before the start, a joiner can `leave(id)` and the host can `cancel(id)`: everybody gets their STUD back.
///  - 5 timed rounds (120/90/75/60/45 s). Each round shows 4 deals. A deal grows 1000 points with compound
///    interest and then a flat fee is taken off:
///        value = 1000 * (1 + rate)^periods - 1000 - fee
///  - Every player makes ONE pick per round. As soon as ALL players have picked, the round ends at once and
///    the next one starts (the unused seconds are skipped). Otherwise the round ends when its time is up.
///  - The contract scores each pick, so the best deal of the round is decided on-chain, never by the web page.
///  - Winner = most round wins (tiebreak: higher total value, then earlier join) and takes the whole pot.
///    If nobody picked at all, every entry fee is refunded.
contract YieldArena {
    using SafeERC20 for IERC20;

    struct Deal { uint16 rate; uint8 periods; uint16 feeBps; } // rate / fee in bps (100 = 1%)

    struct Game {
        address creator;
        uint64 startTime;   // 0 while the lobby is open; set when the game starts (round 1 begins)
        uint32 skipped;     // seconds cut from the schedule because every player had already picked
        uint16 playerCount;
        bool settled;       // paid out, refunded or cancelled
        bool cancelled;     // host cancelled the lobby, everyone was refunded
        address winner;
        uint8 winnerWins;
        uint256 pot;        // STUD collected
        bytes32 seed;       // picks the deal variant and slot order of every round (set at start)
    }

    uint256 public constant ROUNDS = 5;
    uint256 public constant DEALS = 4;
    uint256 public constant PRINCIPAL = 1000 ether; // 1000 points (18-decimal fixed point, not a token)
    uint256 public constant MIN_PLAYERS = 2;
    uint256 public constant MAX_PLAYERS = 16;

    IERC20 public immutable stud;
    uint256 public immutable entryFee;  // 50 STUD in base units

    uint32[5] public roundSeconds = [120, 90, 75, 60, 45];

    uint256 public gameCount;
    mapping(uint256 => Game) public games;
    mapping(uint256 => address[]) internal players;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => uint8[5])) internal picks; // slot + 1, 0 = no pick
    mapping(uint256 => mapping(address => uint256)) public totalValue;
    mapping(uint256 => mapping(address => uint8)) public wins;
    mapping(uint256 => uint256[5]) public bestValue;
    mapping(uint256 => uint16[5]) public picksMade;   // how many players have picked in each round
    mapping(uint256 => address[5]) public roundWinner;

    // lifetime stats per wallet (persist across games and page reloads)
    mapping(address => uint256) public score;    // total points ever earned
    mapping(address => uint256) public gamesWon;

    event GameCreated(uint256 indexed id, address indexed creator);
    event Joined(uint256 indexed id, address indexed player);
    event Left(uint256 indexed id, address indexed player);
    event GameStarted(uint256 indexed id, uint64 startTime);
    event GameCancelled(uint256 indexed id);
    event Picked(uint256 indexed id, address indexed player, uint8 round, uint8 slot, uint256 value);
    event GameFinished(uint256 indexed id, address indexed winner, uint8 roundsWon, uint256 payout);

    constructor(address studAddress) {
        require(studAddress != address(0) && studAddress.code.length > 0, "STUD address invalid");
        stud = IERC20(studAddress);
        entryFee = 50 * 10 ** IERC20Metadata(studAddress).decimals();
    }

    // ---------- game flow ----------

    /// @notice Open a new lobby and join it. Costs `entryFee` STUD (approve first). The lobby waits for players.
    function createGame() external returns (uint256 id) {
        id = ++gameCount;
        Game storage g = games[id];
        g.creator = msg.sender;
        emit GameCreated(id, msg.sender);
        _enter(id, g);
    }

    /// @notice Join a lobby that has not started yet. Costs `entryFee` STUD (approve first).
    function join(uint256 id) external {
        Game storage g = games[id];
        require(g.creator != address(0), "Unknown game");
        require(!g.cancelled, "Game cancelled");
        require(g.startTime == 0, "Lobby closed");
        _enter(id, g);
        if (g.playerCount == MAX_PLAYERS) _start(id, g); // a full lobby starts by itself
    }

    function _enter(uint256 id, Game storage g) internal {
        require(!joined[id][msg.sender], "Already joined");
        require(g.playerCount < MAX_PLAYERS, "Game is full");
        require(stud.balanceOf(msg.sender) >= entryFee, "Not enough STUD");
        require(stud.allowance(msg.sender, address(this)) >= entryFee, "Approve STUD first");
        joined[id][msg.sender] = true;
        players[id].push(msg.sender);
        g.playerCount += 1;
        g.pot += entryFee;
        emit Joined(id, msg.sender);
        stud.safeTransferFrom(msg.sender, address(this), entryFee);
    }

    /// @notice Host only: start round 1. Needs at least MIN_PLAYERS (2) players in the lobby.
    function start(uint256 id) external {
        Game storage g = games[id];
        require(g.creator != address(0), "Unknown game");
        require(msg.sender == g.creator, "Only the host");
        require(!g.cancelled, "Game cancelled");
        require(g.startTime == 0, "Already started");
        require(g.playerCount >= MIN_PLAYERS, "Need 2 players");
        _start(id, g);
    }

    function _start(uint256 id, Game storage g) internal {
        g.startTime = uint64(block.timestamp);
        // Seed only varies the deals; it is NOT secure randomness (a validator could bias prevrandao).
        g.seed = keccak256(abi.encodePacked(block.prevrandao, id, g.creator, block.number));
        emit GameStarted(id, g.startTime);
    }

    /// @notice Leave a lobby that has not started and get your entry fee back. The host uses `cancel` instead.
    function leave(uint256 id) external {
        Game storage g = games[id];
        require(g.creator != address(0), "Unknown game");
        require(!g.cancelled, "Game cancelled");
        require(g.startTime == 0, "Lobby closed");
        require(joined[id][msg.sender], "Not in this game");
        require(msg.sender != g.creator, "Host must cancel");
        address[] storage ps = players[id];
        uint256 n = ps.length;
        for (uint256 i = 0; i < n; i++) { // remove while keeping the join order
            if (ps[i] == msg.sender) {
                for (uint256 j = i; j + 1 < n; j++) ps[j] = ps[j + 1];
                ps.pop();
                break;
            }
        }
        joined[id][msg.sender] = false;
        g.playerCount -= 1;
        g.pot -= entryFee;
        emit Left(id, msg.sender);
        stud.safeTransfer(msg.sender, entryFee);
    }

    /// @notice Host only: close a lobby that has not started and refund every player.
    function cancel(uint256 id) external {
        Game storage g = games[id];
        require(g.creator != address(0), "Unknown game");
        require(msg.sender == g.creator, "Only the host");
        require(!g.cancelled, "Game cancelled");
        require(g.startTime == 0, "Already started");
        g.cancelled = true;
        g.settled = true;
        g.pot = 0;
        g.playerCount = 0;
        address[] memory ps = players[id];
        delete players[id];
        emit GameCancelled(id);
        for (uint256 i = 0; i < ps.length; i++) {
            joined[id][ps[i]] = false;
            stud.safeTransfer(ps[i], entryFee);
        }
    }

    /// @notice Pick deal `slot` (0..3) in the current round. One pick per round, final.
    function pick(uint256 id, uint8 slot) external {
        require(slot < DEALS, "Unknown deal");
        require(joined[id][msg.sender], "Join first");
        uint256 r = currentRound(id);
        require(r >= 1 && r <= ROUNDS, "No round is open");
        uint256 ri = r - 1;
        require(picks[id][msg.sender][ri] == 0, "Already picked this round");

        uint256 v = dealValue(dealAt(id, ri, slot));

        picks[id][msg.sender][ri] = slot + 1;
        totalValue[id][msg.sender] += v;
        score[msg.sender] += v;
        if (v > bestValue[id][ri]) { // strictly better only: the earlier pick wins ties
            bestValue[id][ri] = v;
            roundWinner[id][ri] = msg.sender;
        }
        emit Picked(id, msg.sender, uint8(ri), slot, v);

        // Everyone has picked: end this round now by skipping the time that is left in it.
        Game storage g = games[id];
        picksMade[id][ri] += 1;
        if (picksMade[id][ri] == g.playerCount) {
            uint256 roundEnd;
            for (uint256 i = 0; i <= ri; i++) roundEnd += roundSeconds[i];
            g.skipped += uint32(roundEnd - (block.timestamp - g.startTime + g.skipped));
        }
    }

    /// @notice After round 5 anyone can settle: pays the pot to the winner, or refunds all entry fees if nobody picked.
    function finish(uint256 id) external {
        Game storage g = games[id];
        require(g.startTime != 0 && currentRound(id) > ROUNDS, "Game not over");
        require(!g.settled, "Already finished");
        g.settled = true;

        for (uint256 r = 0; r < ROUNDS; r++) {
            address w = roundWinner[id][r];
            if (w != address(0)) wins[id][w] += 1;
        }
        address[] storage ps = players[id];
        address best;
        for (uint256 i = 0; i < ps.length; i++) {
            address p = ps[i];
            if (wins[id][p] == 0) continue;
            if (
                best == address(0) || wins[id][p] > wins[id][best] ||
                (wins[id][p] == wins[id][best] && totalValue[id][p] > totalValue[id][best])
            ) best = p;
        }

        uint256 payout;
        if (best != address(0) && ps.length >= 2) {
            g.winner = best;
            g.winnerWins = wins[id][best];
            gamesWon[best] += 1;
            payout = g.pot;
            stud.safeTransfer(best, payout);
        } else {
            for (uint256 i = 0; i < ps.length; i++) stud.safeTransfer(ps[i], entryFee);
            payout = g.pot;
        }
        emit GameFinished(id, g.winner, g.winnerWins, payout);
    }

    // ---------- views ----------

    /// @return 0 = lobby (not started, cancelled or unknown), 1..5 = round number, 6 = game over
    function currentRound(uint256 id) public view returns (uint256) {
        Game storage g = games[id];
        if (g.startTime == 0) return 0;
        uint256 t = block.timestamp - g.startTime + g.skipped;
        uint256 end;
        for (uint256 r = 0; r < ROUNDS; r++) {
            end += roundSeconds[r];
            if (t < end) return r + 1;
        }
        return ROUNDS + 1;
    }

    /// @notice The deal shown in position `slot` of round `r` (0-based). Variant and order depend on the seed.
    function dealAt(uint256 id, uint256 r, uint256 slot) public view returns (Deal memory d) {
        require(games[id].startTime != 0, "Game not started");
        bytes32 seed = games[id].seed;
        uint256 variant = uint256(keccak256(abi.encodePacked(seed, r, "v"))) % DealTable.VARIANTS;
        uint256 shift = uint256(keccak256(abi.encodePacked(seed, r, "s"))) % DEALS;
        (d.rate, d.periods, d.feeBps) = DealTable.read(r, variant, (slot + shift) % DEALS);
    }

    /// @notice Compound interest: PRINCIPAL * (1 + rate)^periods - PRINCIPAL - fee (min 0), in points (1e18).
    function dealValue(Deal memory d) public pure returns (uint256) {
        uint256 a = PRINCIPAL;
        for (uint256 i = 0; i < d.periods; i++) a = (a * (10_000 + d.rate)) / 10_000;
        uint256 gross = a - PRINCIPAL;
        uint256 fee = (PRINCIPAL * d.feeBps) / 10_000;
        return gross > fee ? gross - fee : 0;
    }

    function gameInfo(uint256 id) external view returns (Game memory g, uint256 round) {
        return (games[id], currentRound(id));
    }

    function getRoundDeals(uint256 id, uint256 r) external view returns (Deal[4] memory out) {
        for (uint256 s = 0; s < DEALS; s++) out[s] = dealAt(id, r, s);
    }

    function getPlayers(uint256 id) external view returns (address[] memory) { return players[id]; }

    function getPicks(uint256 id, address p) external view returns (uint8[5] memory) { return picks[id][p]; }

    function getRoundWinners(uint256 id) external view returns (address[5] memory, uint256[5] memory) {
        return (roundWinner[id], bestValue[id]);
    }
}
