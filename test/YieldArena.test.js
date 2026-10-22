const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const FEE = ethers.parseEther("50");
const P = 1000n * 10n ** 18n;
const ROUND_S = [120, 90, 75, 60, 45];

// Same integer maths as the contract.
function valueJs(rate, periods, feeBps) {
  let a = P;
  for (let i = 0; i < Number(periods); i++) a = (a * (10000n + BigInt(rate))) / 10000n;
  const gross = a - P, fee = (P * BigInt(feeBps)) / 10000n;
  return gross > fee ? gross - fee : 0n;
}

async function setup() {
  const [owner, alice, bob, carol, ...rest] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockToken");
  const stud = await Token.deploy("STUD", "STUD");
  const Arena = await ethers.getContractFactory("YieldArena");
  const arena = await Arena.deploy(await stud.getAddress());
  const arenaAddr = await arena.getAddress();
  for (const s of [alice, bob, carol, ...rest]) {
    await stud.transfer(s.address, ethers.parseEther("1000"));
    await stud.connect(s).approve(arenaAddr, ethers.MaxUint256);
  }
  return { owner, alice, bob, carol, rest, stud, arena, arenaAddr };
}
// Host opens a lobby, the others join (not started yet).
async function lobby(arena, host, others = []) {
  await arena.connect(host).createGame();
  const id = await arena.gameCount();
  for (const o of others) await arena.connect(o).join(id);
  return id;
}
// Lobby + host starts the game: round 1 is open right away.
async function started(arena, host, others) {
  const id = await lobby(arena, host, others);
  await arena.connect(host).start(id);
  return id;
}
async function ranked(arena, id, r) {
  const d = await arena.getRoundDeals(id, r);
  const v = d.map((x) => valueJs(x.rate, x.periods, x.feeBps));
  const best = v.indexOf(v.reduce((a, b) => (a > b ? a : b)));
  const worst = v.indexOf(v.reduce((a, b) => (a < b ? a : b)));
  return { d, v, best, worst };
}
// Move chain time to the first second of a round on the schedule (skipped seconds are already counted).
async function toRound(arena, id, round) {
  const g = (await arena.gameInfo(id)).g;
  let t = Number(g.startTime) - Number(g.skipped) + 1;
  for (let i = 0; i < round - 1; i++) t += ROUND_S[i];
  await time.setNextBlockTimestamp(Math.max(t, (await time.latest()) + 1));
  await ethers.provider.send("evm_mine", []);
}
async function timeoutGame(arena, id) { await time.increase(1000); await arena.finish(id); }

describe("YieldArena", () => {
  it("1. constructor rejects bad token addresses", async () => {
    const Arena = await ethers.getContractFactory("YieldArena");
    await expect(Arena.deploy(ethers.ZeroAddress)).to.be.revertedWith("STUD address invalid");
    const [owner] = await ethers.getSigners();
    await expect(Arena.deploy(owner.address)).to.be.revertedWith("STUD address invalid"); // EOA, no code
  });

  it("2. createGame takes 50 STUD, joins the creator and opens a lobby with NO timer", async () => {
    const { arena, arenaAddr, stud, alice, bob } = await setup();
    await expect(arena.connect(alice).createGame()).to.emit(arena, "GameCreated").and.to.emit(arena, "Joined");
    expect(await stud.balanceOf(arenaAddr)).to.equal(FEE);
    expect(await stud.balanceOf(alice.address)).to.equal(ethers.parseEther("950"));
    let { g, round } = await arena.gameInfo(1);
    expect(g.creator).to.equal(alice.address);
    expect(g.pot).to.equal(FEE);
    expect(g.playerCount).to.equal(1);
    expect(g.startTime).to.equal(0);
    expect(round).to.equal(0);
    expect(await arena.joined(1, alice.address)).to.equal(true);
    // Days later the lobby is still waiting and still open.
    await time.increase(10 * 24 * 3600);
    ({ g, round } = await arena.gameInfo(1));
    expect(g.startTime).to.equal(0);
    expect(round).to.equal(0);
    await expect(arena.connect(bob).join(1)).to.emit(arena, "Joined");
  });

  it("3. join takes 50 STUD; rejects no STUD, no approval, double join, unknown game", async () => {
    const { arena, stud, alice, bob, carol } = await setup();
    await arena.connect(alice).createGame();
    await arena.connect(bob).join(1);
    expect((await arena.gameInfo(1)).g.pot).to.equal(FEE * 2n);
    await expect(arena.connect(bob).join(1)).to.be.revertedWith("Already joined");
    await expect(arena.connect(carol).join(99)).to.be.revertedWith("Unknown game");
    await stud.connect(carol).approve(await arena.getAddress(), 0);
    await expect(arena.connect(carol).join(1)).to.be.revertedWith("Approve STUD first");
    await stud.connect(carol).approve(await arena.getAddress(), FEE);
    await stud.connect(carol).transfer(alice.address, ethers.parseEther("980"));
    await expect(arena.connect(carol).join(1)).to.be.revertedWith("Not enough STUD");
  });

  it("4. only the host can start, and only with at least 2 players", async () => {
    const { arena, alice, bob, carol } = await setup();
    await arena.connect(alice).createGame();
    await expect(arena.connect(alice).start(1)).to.be.revertedWith("Need 2 players");
    await arena.connect(bob).join(1);
    await expect(arena.connect(bob).start(1)).to.be.revertedWith("Only the host");
    await expect(arena.connect(alice).start(99)).to.be.revertedWith("Unknown game");
    await expect(arena.connect(alice).start(1)).to.emit(arena, "GameStarted");
    expect(await arena.currentRound(1)).to.equal(1);
    await expect(arena.connect(alice).start(1)).to.be.revertedWith("Already started");
    await expect(arena.connect(carol).join(1)).to.be.revertedWith("Lobby closed");
  });

  it("5. a full lobby (16 players) starts by itself", async () => {
    const { arena, alice, bob, rest } = await setup();
    await arena.connect(alice).createGame();
    for (let i = 0; i < 14; i++) await arena.connect(rest[i]).join(1);
    expect((await arena.gameInfo(1)).round).to.equal(0);
    await arena.connect(rest[14]).join(1); // 16th player
    const { g, round } = await arena.gameInfo(1);
    expect(g.playerCount).to.equal(16);
    expect(g.startTime).to.be.greaterThan(0);
    expect(round).to.equal(1);
    await expect(arena.connect(bob).join(1)).to.be.revertedWith("Lobby closed");
  });

  it("6. contract value equals the page formula for every deal, over many games", async () => {
    const { arena, rest } = await setup();
    for (let n = 0; n < 12; n++) {
      const id = await started(arena, rest[n], [rest[n + 1]]);
      for (let r = 0; r < 5; r++) {
        const { d } = await ranked(arena, id, r);
        for (const x of d) expect(await arena.dealValue([x.rate, x.periods, x.feeBps])).to.equal(valueJs(x.rate, x.periods, x.feeBps));
      }
    }
  });

  it("7. every round always has one clear best deal, and it is never the highest rate", async () => {
    const { arena, rest } = await setup();
    for (let n = 0; n < 40; n++) {
      const id = await started(arena, rest[n % 15], [rest[(n % 15) + 1]]);
      for (let r = 0; r < 5; r++) {
        const { d, v, best } = await ranked(arena, id, r);
        const top = d.reduce((m, x, i) => (x.rate > d[m].rate ? i : m), 0);
        expect(best, `game ${id} round ${r}`).to.not.equal(top);
        expect(v.filter((x) => x === v[best]).length).to.equal(1);
      }
    }
  });

  it("8. deals stay hidden until the game starts", async () => {
    const { arena, alice, bob } = await setup();
    const id = await lobby(arena, alice, [bob]);
    await expect(arena.getRoundDeals(id, 0)).to.be.revertedWith("Game not started");
    await arena.connect(alice).start(id);
    await arena.getRoundDeals(id, 0);
  });

  it("9. pick is scored on-chain with compound interest and stored per player", async () => {
    const { arena, alice, bob } = await setup();
    const id = await started(arena, alice, [bob]);
    const { v, best } = await ranked(arena, id, 0);
    await expect(arena.connect(alice).pick(id, best)).to.emit(arena, "Picked");
    expect(await arena.totalValue(id, alice.address)).to.equal(v[best]);
    expect(await arena.score(alice.address)).to.equal(v[best]);
    const [w, bv] = await arena.getRoundWinners(id);
    expect(w[0]).to.equal(alice.address);
    expect(bv[0]).to.equal(v[best]);
    expect((await arena.getPicks(id, alice.address))[0]).to.equal(best + 1);
    expect(await arena.picksMade(id, 0)).to.equal(1);
  });

  it("10. rejects picks: lobby, unknown deal, not joined, twice, after the round", async () => {
    const { arena, alice, bob, carol } = await setup();
    const id = await lobby(arena, alice, [bob]);
    await expect(arena.connect(alice).pick(id, 0)).to.be.revertedWith("No round is open"); // lobby
    await arena.connect(alice).start(id);
    await expect(arena.connect(alice).pick(id, 4)).to.be.revertedWith("Unknown deal");
    await expect(arena.connect(carol).pick(id, 0)).to.be.revertedWith("Join first");
    await arena.connect(alice).pick(id, 0);
    await expect(arena.connect(alice).pick(id, 1)).to.be.revertedWith("Already picked this round");
    await toRound(arena, id, 2); // bob never picked: round 1 times out
    await arena.connect(alice).pick(id, 0); // round 2 is a fresh pick
    expect((await arena.getPicks(id, alice.address))[0]).to.equal(1);
    expect((await arena.getPicks(id, alice.address))[1]).to.equal(1);
    await time.increase(1000);
    await expect(arena.connect(alice).pick(id, 0)).to.be.revertedWith("No round is open");
  });

  it("11. better deal wins the round, a tie goes to the earlier pick", async () => {
    const { arena, alice, bob } = await setup();
    const id = await started(arena, alice, [bob]);
    const { best, worst } = await ranked(arena, id, 0);
    await arena.connect(alice).pick(id, worst);
    await arena.connect(bob).pick(id, best);
    expect((await arena.getRoundWinners(id))[0][0]).to.equal(bob.address);
    expect(await arena.currentRound(id)).to.equal(2); // both picked: round 2 is open already
    await arena.connect(alice).pick(id, 0);
    await arena.connect(bob).pick(id, 0); // same deal, same value
    expect((await arena.getRoundWinners(id))[0][1]).to.equal(alice.address);
  });

  it("12. the round ends at once when every player has picked", async () => {
    const { arena, alice, bob, carol } = await setup();
    const id = await started(arena, alice, [bob, carol]);
    await arena.connect(alice).pick(id, 0);
    await arena.connect(bob).pick(id, 0);
    expect(await arena.currentRound(id)).to.equal(1); // carol has not picked yet
    expect((await arena.gameInfo(id)).g.skipped).to.equal(0);
    await arena.connect(carol).pick(id, 0);
    expect(await arena.currentRound(id)).to.equal(2); // everybody picked: next round now
    const skipped = Number((await arena.gameInfo(id)).g.skipped);
    expect(skipped).to.be.within(ROUND_S[0] - 10, ROUND_S[0] - 1); // almost the whole round was skipped
    // The next round is open for picks immediately and has its full time.
    await arena.connect(alice).pick(id, 0);
    expect(await arena.picksMade(id, 1)).to.equal(1);
    await time.increase(ROUND_S[1] - 10);
    expect(await arena.currentRound(id)).to.equal(2);
  });

  it("13. if somebody does not pick, the round still ends when its time is up (no skipping)", async () => {
    const { arena, alice, bob } = await setup();
    const id = await started(arena, alice, [bob]);
    await arena.connect(alice).pick(id, 0);
    await time.increase(ROUND_S[0] - 5);
    expect(await arena.currentRound(id)).to.equal(1);
    await time.increase(10);
    expect(await arena.currentRound(id)).to.equal(2);
    expect((await arena.gameInfo(id)).g.skipped).to.equal(0);
    await expect(arena.connect(bob).pick(id, 0)).to.emit(arena, "Picked"); // late player can still pick round 2
    expect(await arena.picksMade(id, 0)).to.equal(1);
  });

  it("14. cannot finish early; when everyone picks every round the game is over at once and the winner takes the pot", async () => {
    const { arena, stud, alice, bob } = await setup();
    const id = await started(arena, alice, [bob]);
    await expect(arena.finish(id)).to.be.revertedWith("Game not over");
    for (let r = 1; r <= 5; r++) {
      expect(await arena.currentRound(id)).to.equal(r);
      const { best, worst } = await ranked(arena, id, r - 1);
      await arena.connect(alice).pick(id, best);
      await arena.connect(bob).pick(id, worst);
      if (r === 4) await expect(arena.finish(id)).to.be.revertedWith("Game not over");
    }
    expect(await arena.currentRound(id)).to.equal(6); // no waiting
    const before = await stud.balanceOf(alice.address);
    await expect(arena.finish(id)).to.emit(arena, "GameFinished").withArgs(id, alice.address, 5, FEE * 2n);
    expect((await stud.balanceOf(alice.address)) - before).to.equal(FEE * 2n);
    expect(await arena.gamesWon(alice.address)).to.equal(1);
    expect(await arena.gamesWon(bob.address)).to.equal(0);
    await expect(arena.finish(id)).to.be.revertedWith("Already finished");
  });

  it("15. equal round wins are decided by total value", async () => {
    const { arena, alice, bob } = await setup();
    const id = await started(arena, alice, [bob]);
    for (let r = 1; r <= 4; r++) {
      const { best, worst } = await ranked(arena, id, r - 1);
      if (r <= 2) { await arena.connect(alice).pick(id, worst); await arena.connect(bob).pick(id, best); }
      else { await arena.connect(bob).pick(id, worst); await arena.connect(alice).pick(id, best); }
    }
    await timeoutGame(arena, id); // round 5 nobody picks
    const g = (await arena.gameInfo(id)).g;
    const ta = await arena.totalValue(id, alice.address), tb = await arena.totalValue(id, bob.address);
    expect(await arena.wins(id, alice.address)).to.equal(2);
    expect(await arena.wins(id, bob.address)).to.equal(2);
    expect(g.winner).to.equal(ta > tb ? alice.address : bob.address);
  });

  it("16. a game where nobody picks refunds every entry fee", async () => {
    const { arena, stud, alice, bob } = await setup();
    const id = await started(arena, alice, [bob]);
    await timeoutGame(arena, id);
    expect(await stud.balanceOf(alice.address)).to.equal(ethers.parseEther("1000"));
    expect(await stud.balanceOf(bob.address)).to.equal(ethers.parseEther("1000"));
    expect(await stud.balanceOf(await arena.getAddress())).to.equal(0);
    expect((await arena.gameInfo(id)).g.winner).to.equal(ethers.ZeroAddress);
  });

  it("17. host cancels a lobby: everybody is refunded and the game is dead", async () => {
    const { arena, stud, alice, bob, carol } = await setup();
    const id = await lobby(arena, alice, [bob, carol]);
    await expect(arena.connect(bob).cancel(id)).to.be.revertedWith("Only the host");
    await expect(arena.connect(alice).cancel(99)).to.be.revertedWith("Unknown game");
    await expect(arena.connect(alice).cancel(id)).to.emit(arena, "GameCancelled").withArgs(id);
    for (const p of [alice, bob, carol]) expect(await stud.balanceOf(p.address)).to.equal(ethers.parseEther("1000"));
    expect(await stud.balanceOf(await arena.getAddress())).to.equal(0);
    const { g, round } = await arena.gameInfo(id);
    expect(g.cancelled).to.equal(true);
    expect(g.settled).to.equal(true);
    expect(g.pot).to.equal(0);
    expect(g.playerCount).to.equal(0);
    expect(round).to.equal(0);
    await expect(arena.connect(alice).cancel(id)).to.be.revertedWith("Game cancelled");
    await expect(arena.connect(bob).join(id)).to.be.revertedWith("Game cancelled");
    await expect(arena.connect(alice).start(id)).to.be.revertedWith("Game cancelled");
    await expect(arena.connect(bob).leave(id)).to.be.revertedWith("Game cancelled");
    await expect(arena.finish(id)).to.be.revertedWith("Game not over");
    // Nobody can be refunded twice, and players can play again.
    await arena.connect(bob).createGame();
    expect(await stud.balanceOf(await arena.getAddress())).to.equal(FEE);
  });

  it("18. a started game can no longer be cancelled", async () => {
    const { arena, alice, bob } = await setup();
    const id = await started(arena, alice, [bob]);
    await expect(arena.connect(alice).cancel(id)).to.be.revertedWith("Already started");
  });

  it("19. a player can leave the lobby and gets the entry fee back (the host cannot)", async () => {
    const { arena, stud, alice, bob, carol } = await setup();
    const id = await lobby(arena, alice, [bob, carol]);
    await expect(arena.connect(alice).leave(id)).to.be.revertedWith("Host must cancel");
    await expect(arena.connect(alice).leave(99)).to.be.revertedWith("Unknown game");
    const [, , , , dave] = await ethers.getSigners();
    await expect(arena.connect(dave).leave(id)).to.be.revertedWith("Not in this game");
    await expect(arena.connect(bob).leave(id)).to.emit(arena, "Left").withArgs(id, bob.address);
    expect(await stud.balanceOf(bob.address)).to.equal(ethers.parseEther("1000"));
    expect(await arena.getPlayers(id)).to.deep.equal([alice.address, carol.address]); // order kept
    expect(await arena.joined(id, bob.address)).to.equal(false);
    const g = (await arena.gameInfo(id)).g;
    expect(g.playerCount).to.equal(2);
    expect(g.pot).to.equal(FEE * 2n);
    await expect(arena.connect(bob).leave(id)).to.be.revertedWith("Not in this game");
    await arena.connect(bob).join(id); // can come back
    expect(await arena.getPlayers(id)).to.deep.equal([alice.address, carol.address, bob.address]);
    await arena.connect(alice).start(id);
    await expect(arena.connect(carol).leave(id)).to.be.revertedWith("Lobby closed");
  });

  it("20. a lobby that dropped back to one player cannot start", async () => {
    const { arena, alice, bob } = await setup();
    const id = await lobby(arena, alice, [bob]);
    await arena.connect(bob).leave(id);
    await expect(arena.connect(alice).start(id)).to.be.revertedWith("Need 2 players");
  });

  it("21. games are independent: separate lobbies, pots and player state", async () => {
    const { arena, alice, bob, carol } = await setup();
    await arena.connect(alice).createGame();
    await arena.connect(bob).createGame();
    await arena.connect(carol).join(2);
    expect(await arena.joined(1, bob.address)).to.equal(false);
    expect((await arena.gameInfo(1)).g.pot).to.equal(FEE);
    expect((await arena.gameInfo(2)).g.pot).to.equal(FEE * 2n);
    expect(await arena.getPlayers(2)).to.deep.equal([bob.address, carol.address]);
  });
});
