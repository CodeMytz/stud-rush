// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Stud Rush (game edition)
/// @notice 5 timed rounds (30/45/60/75/90 s). Every round shows 4 deals. A deal grows a 1000-point
///         principal with COMPOUND interest ("salikti procenti") and then a flat fee is taken off:
///             value = 1000 * (1 + rate)^periods - 1000 - fee
///         Each player picks ONE deal per round. The contract (the "server") scores every pick,
///         so the best deal of the round is decided on-chain. Winner of the game = most round wins
///         (tiebreak: higher total value, then earlier join) and receives PRIZE STUD.
contract StudRush {
    struct Deal { uint16 rate; uint8 periods; uint16 feeBps; } // rate/fee in bps (100 = 1%)

    struct Game {
        uint64 startTime;
        bytes32 seed;      // rotates the order of the 4 deals in each round
        bool finished;
        address winner;
        uint8 winnerWins;
        uint16 playerCount;
    }

    uint256 public constant ROUNDS = 5;
    uint256 public constant DEALS = 4;
    uint256 public constant PRINCIPAL = 1000 ether; // 1000 points (18 decimals)
    uint256 public constant ENTRY_FEE = 0.001 ether;
    uint256 public constant PRIZE = 500 ether;      // 500 STUD for the winner
    uint256 public constant MAX_PLAYERS = 16;

    IERC20 public immutable stud;
    address public immutable owner;

    uint32[5] public roundSeconds = [30, 45, 60, 75, 90];
    Deal[4][5] internal base;

    uint256 public gameId; // 0 = no game yet
    mapping(uint256 => Game) public games;
    mapping(uint256 => address[]) internal players;
    mapping(uint256 => mapping(address => bool)) public joined;
    // picks[game][player][round] = slot + 1 (0 = no pick)
    mapping(uint256 => mapping(address => uint8[5])) internal picks;
    mapping(uint256 => mapping(address => uint256)) public totalValue;
    mapping(uint256 => mapping(address => uint8)) public wins;
    mapping(uint256 => uint256[5]) public bestValue;
    mapping(uint256 => address[5]) public roundWinner;

    event GameStarted(uint256 indexed id, uint64 startTime);
    event Joined(uint256 indexed id, address indexed player);
    event Picked(uint256 indexed id, address indexed player, uint8 round, uint8 slot, uint256 value, bool leading);
    event GameFinished(uint256 indexed id, address indexed winner, uint8 roundsWon, uint256 prize);

    constructor(address studAddress) {
        require(studAddress != address(0) && studAddress.code.length > 0, "STUD address invalid");
        stud = IERC20(studAddress);
        owner = msg.sender;
        //            rate  periods fee
        base[0][0] = Deal(1300, 2, 225); base[0][1] = Deal(1100, 6, 550);
        base[0][2] = Deal(875, 5, 525);  base[0][3] = Deal(1575, 4, 25);
        base[1][0] = Deal(1275, 2, 0);   base[1][1] = Deal(1325, 8, 100);
        base[1][2] = Deal(550, 7, 125);  base[1][3] = Deal(1100, 10, 525);
        base[2][0] = Deal(1175, 11, 300); base[2][1] = Deal(1425, 9, 125);
        base[2][2] = Deal(1200, 9, 300); base[2][3] = Deal(450, 11, 400);
        base[3][0] = Deal(1150, 2, 50);  base[3][1] = Deal(1375, 14, 525);
        base[3][2] = Deal(1475, 13, 25); base[3][3] = Deal(450, 14, 325);
        base[4][0] = Deal(1550, 14, 325); base[4][1] = Deal(1075, 11, 125);
        base[4][2] = Deal(975, 22, 525); base[4][3] = Deal(1275, 2, 525);
    }

    // ---------- game flow ----------

    /// @notice Start a new game (only when no game is running). Round 1 begins now.
    function startGame() external {
        if (gameId != 0) require(isOver(gameId), "Game still running");
        if (gameId != 0) require(games[gameId].finished, "Finish the last game first");
        require(stud.balanceOf(address(this)) >= PRIZE, "Prize pool empty");
        gameId += 1;
        Game storage g = games[gameId];
        g.startTime = uint64(block.timestamp);
        g.seed = keccak256(abi.encodePacked(blockhash(block.number - 1), gameId));
        emit GameStarted(gameId, g.startTime);
    }

    /// @notice Join the running game. Allowed until round 2 begins.
    function join() external payable {
        require(gameId != 0, "No game");
        require(msg.value == ENTRY_FEE, "Send exactly 0.001 ETH");
        require(currentRound(gameId) <= 1, "Joining closed");
        require(!joined[gameId][msg.sender], "Already joined");
        Game storage g = games[gameId];
        require(g.playerCount < MAX_PLAYERS, "Game is full");
        joined[gameId][msg.sender] = true;
        players[gameId].push(msg.sender);
        g.playerCount += 1;
        emit Joined(gameId, msg.sender);
    }

    /// @notice Pick deal `slot` (0..3) in the current round. One pick per round, final.
    function pick(uint8 slot) external {
        require(slot < DEALS, "Unknown deal");
        require(gameId != 0 && joined[gameId][msg.sender], "Join first");
        uint256 r = currentRound(gameId);
        require(r >= 1 && r <= ROUNDS, "No round is open");
        uint256 ri = r - 1;
        require(picks[gameId][msg.sender][ri] == 0, "Already picked this round");

        picks[gameId][msg.sender][ri] = slot + 1;
        uint256 v = dealValue(dealAt(gameId, ri, slot));
        totalValue[gameId][msg.sender] += v;
        bool leading = v > bestValue[gameId][ri]; // strictly better only: earlier pick wins ties
        if (leading) {
            bestValue[gameId][ri] = v;
            roundWinner[gameId][ri] = msg.sender;
        }
        emit Picked(gameId, msg.sender, uint8(ri), slot, v, leading);
    }

    /// @notice After round 5 ends anyone can finish the game; the contract pays the winner.
    function finish() external {
        uint256 id = gameId;
        require(id != 0 && isOver(id), "Game not over");
        Game storage g = games[id];
        require(!g.finished, "Already finished");
        g.finished = true;

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
        g.winner = best;
        uint256 paid;
        if (best != address(0)) {
            g.winnerWins = wins[id][best];
            paid = PRIZE;
            require(stud.transfer(best, PRIZE), "STUD transfer failed");
        }
        emit GameFinished(id, best, g.winnerWins, paid);
    }

    // ---------- views ----------

    /// @return 0 = not started, 1..5 = round number, 6 = game over
    function currentRound(uint256 id) public view returns (uint256) {
        Game storage g = games[id];
        if (g.startTime == 0) return 0;
        uint256 t = block.timestamp - g.startTime;
        uint256 end;
        for (uint256 r = 0; r < ROUNDS; r++) {
            end += roundSeconds[r];
            if (t < end) return r + 1;
        }
        return ROUNDS + 1;
    }

    function isOver(uint256 id) public view returns (bool) { return currentRound(id) > ROUNDS; }

    /// @notice Timestamp when round `r` (0-based) ends.
    function roundEnd(uint256 id, uint256 r) public view returns (uint256 end) {
        end = games[id].startTime;
        for (uint256 i = 0; i <= r; i++) end += roundSeconds[i];
    }

    /// @notice The deal shown in position `slot` of round `r` (order is shuffled per game).
    function dealAt(uint256 id, uint256 r, uint256 slot) public view returns (Deal memory) {
        uint256 shift = uint256(keccak256(abi.encodePacked(games[id].seed, r))) % DEALS;
        return base[r][(slot + shift) % DEALS];
    }

    /// @notice Compound interest: PRINCIPAL * (1 + rate)^periods - PRINCIPAL - fee (min 0).
    function dealValue(Deal memory d) public pure returns (uint256) {
        uint256 a = PRINCIPAL;
        for (uint256 i = 0; i < d.periods; i++) a = (a * (10_000 + d.rate)) / 10_000;
        uint256 gross = a - PRINCIPAL;
        uint256 fee = (PRINCIPAL * d.feeBps) / 10_000;
        return gross > fee ? gross - fee : 0;
    }

    function getRoundDeals(uint256 id, uint256 r) external view returns (Deal[4] memory out) {
        for (uint256 s = 0; s < DEALS; s++) out[s] = dealAt(id, r, s);
    }

    function getPlayers(uint256 id) external view returns (address[] memory) { return players[id]; }

    function getPicks(uint256 id, address p) external view returns (uint8[5] memory) { return picks[id][p]; }

    function getRoundWinners(uint256 id) external view returns (address[5] memory, uint256[5] memory) {
        return (roundWinner[id], bestValue[id]);
    }

    function stock() external view returns (uint256) { return stud.balanceOf(address(this)); }

    // ---------- owner ----------

    function withdrawEth() external {
        require(msg.sender == owner, "Only owner");
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "ETH transfer failed");
    }

    /// @dev Only when no game is mid-way, so a running prize can not be pulled.
    function withdrawStud() external {
        require(msg.sender == owner, "Only owner");
        require(gameId == 0 || games[gameId].finished, "Game running");
        require(stud.transfer(owner, stud.balanceOf(address(this))), "STUD transfer failed");
    }
}
