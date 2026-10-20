const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const FEE = ethers.parseEther("0.001");
const PRIZE = ethers.parseEther("500");
const P = 1000n * 10n ** 18n;
const ROUND_S = [30, 45, 60, 75, 90];

// Same integer maths as the contract.
function valueJs(rate, periods, feeBps) {
  let a = P;
  for (let i = 0; i < periods; i++) a = (a * (10000n + BigInt(rate))) / 10000n;
  const gross = a - P, fee = (P * BigInt(feeBps)) / 10000n;
  return gross > fee ? gross - fee : 0n;
}

async function setup() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockToken");
  const stud = await Token.deploy("STUD", "STUD");
  const Game = await ethers.getContractFactory("StudRush");
  const game = await Game.deploy(await stud.getAddress());
  await stud.transfer(await game.getAddress(), ethers.parseEther("5000"));
  return { owner, alice, bob, carol, stud, game };
}
// Slot of best / worst deal in a round, as the page would work it out.
async function ranked(game, id, r) {
  const d = await game.getRoundDeals(id, r);
  const v = d.map((x) => valueJs(x.rate, x.periods, x.feeBps));
  const best = v.indexOf(v.reduce((a, b) => (a > b ? a : b)));
  const worst = v.indexOf(v.reduce((a, b) => (a < b ? a : b)));
  return { v, best, worst };
}
async function toRound(game, id, round) { // round 1..5; jump to its first second
  const g = await game.games(id);
  let t = Number(g.startTime) + 1;
  for (let i = 0; i < round - 1; i++) t += ROUND_S[i];
  const latest = await time.latest();
  await time.setNextBlockTimestamp(Math.max(t, latest + 1));
  await ethers.provider.send("evm_mine", []);
}

describe("StudRush game", () => {
  it("1. start, join and pick: contract scores the pick with compound interest", async () => {
    const { game, alice } = await setup();
    await game.startGame();
    await game.connect(alice).join({ value: FEE });
    const { v, best } = await ranked(game, 1, 0);
    await game.connect(alice).pick(best);
    expect(await game.totalValue(1, alice.address)).to.equal(v[best]);
    const [w, bv] = await game.getRoundWinners(1);
    expect(w[0]).to.equal(alice.address);
    expect(bv[0]).to.equal(v[best]);
  });

  it("2. contract value equals the page formula for every deal of every round", async () => {
    const { game } = await setup();
    await game.startGame();
    for (let r = 0; r < 5; r++) {
      const d = await game.getRoundDeals(1, r);
      for (const x of d) expect(await game.dealValue([x.rate, x.periods, x.feeBps])).to.equal(valueJs(x.rate, x.periods, x.feeBps));
    }
  });

  it("3. every round has a unique best deal that is not the highest rate", async () => {
    const { game } = await setup();
    await game.startGame();
    for (let r = 0; r < 5; r++) {
      const d = await game.getRoundDeals(1, r);
      const { v, best } = await ranked(game, 1, r);
      const top = d.reduce((m, x, i) => (x.rate > d[m].rate ? i : m), 0);
      expect(best).to.not.equal(top);
      expect(v.filter((x) => x === v[best]).length).to.equal(1);
    }
  });

  it("4. rejects wrong entry fee, double join, unknown deal, pick without join, double pick", async () => {
    const { game, alice, bob } = await setup();
    await expect(game.connect(alice).join({ value: FEE })).to.be.revertedWith("No game");
    await game.startGame();
    await expect(game.connect(alice).join({ value: 1 })).to.be.revertedWith("Send exactly 0.001 ETH");
    await game.connect(alice).join({ value: FEE });
    await expect(game.connect(alice).join({ value: FEE })).to.be.revertedWith("Already joined");
    await expect(game.connect(bob).pick(0)).to.be.revertedWith("Join first");
    await expect(game.connect(alice).pick(4)).to.be.revertedWith("Unknown deal");
    await game.connect(alice).pick(0);
    await expect(game.connect(alice).pick(1)).to.be.revertedWith("Already picked this round");
  });

  it("5. picks close when the round timer ends; a new round allows a new pick", async () => {
    const { game, alice } = await setup();
    await game.startGame();
    await game.connect(alice).join({ value: FEE });
    await toRound(game, 1, 2);
    await game.connect(alice).pick(0); // round 2 is open, round 1 is gone
    expect((await game.getPicks(1, alice.address))[0]).to.equal(0);
    expect((await game.getPicks(1, alice.address))[1]).to.equal(1);
    await expect(game.connect(alice).join({ value: FEE })).to.be.revertedWith("Joining closed");
  });

  it("6. joining closes when round 2 starts", async () => {
    const { game, bob } = await setup();
    await game.startGame();
    await toRound(game, 1, 2);
    await expect(game.connect(bob).join({ value: FEE })).to.be.revertedWith("Joining closed");
  });

  it("7. better deal wins the round, a tie goes to the earlier pick", async () => {
    const { game, alice, bob } = await setup();
    await game.startGame();
    await game.connect(alice).join({ value: FEE });
    await game.connect(bob).join({ value: FEE });
    const { best, worst } = await ranked(game, 1, 0);
    await game.connect(alice).pick(worst);
    await game.connect(bob).pick(best);
    expect((await game.getRoundWinners(1))[0][0]).to.equal(bob.address);
    await toRound(game, 1, 2);
    await game.connect(alice).pick(0);
    await game.connect(bob).pick(0); // same deal, same value
    expect((await game.getRoundWinners(1))[0][1]).to.equal(alice.address);
  });

  it("8. cannot finish early; winner (most round wins) gets 500 STUD", async () => {
    const { game, stud, alice, bob } = await setup();
    await game.startGame();
    await game.connect(alice).join({ value: FEE });
    await game.connect(bob).join({ value: FEE });
    await expect(game.finish()).to.be.revertedWith("Game not over");
    for (let r = 1; r <= 5; r++) {
      await toRound(game, 1, r);
      const { best, worst } = await ranked(game, 1, r - 1);
      await game.connect(alice).pick(best);           // alice always plays the best deal
      await game.connect(bob).pick(r === 3 ? best : worst); // bob only ties once (loses on timing)
    }
    await toRound(game, 1, 5);
    await time.increase(100);
    const before = await stud.balanceOf(alice.address);
    await expect(game.finish()).to.emit(game, "GameFinished").withArgs(1, alice.address, 5, PRIZE);
    expect((await stud.balanceOf(alice.address)) - before).to.equal(PRIZE);
    await expect(game.finish()).to.be.revertedWith("Already finished");
  });

  it("9. tiebreak on round wins uses total value", async () => {
    const { game, stud, alice, bob } = await setup();
    await game.startGame();
    await game.connect(alice).join({ value: FEE });
    await game.connect(bob).join({ value: FEE });
    // Bob (picks second) wins rounds 1-2 with the best deal, Alice wins rounds 3-4 (bob picks worst).
    // Round 5: nobody picks. Both have 2 wins; total value decides.
    for (let r = 1; r <= 4; r++) {
      await toRound(game, 1, r);
      const { best, worst } = await ranked(game, 1, r - 1);
      if (r <= 2) { await game.connect(alice).pick(worst); await game.connect(bob).pick(best); }
      else { await game.connect(bob).pick(worst); await game.connect(alice).pick(best); }
    }
    await time.increase(1000);
    await game.finish();
    const g = await game.games(1);
    const ta = await game.totalValue(1, alice.address), tb = await game.totalValue(1, bob.address);
    expect(g.winner).to.equal(ta > tb ? alice.address : bob.address);
    expect(await stud.balanceOf(g.winner)).to.equal(PRIZE);
  });

  it("10. no picks: nobody is paid; a new game can start; old one blocks it until finished", async () => {
    const { game, stud } = await setup();
    await game.startGame();
    await expect(game.startGame()).to.be.revertedWith("Game still running");
    await time.increase(1000);
    await expect(game.startGame()).to.be.revertedWith("Finish the last game first");
    const bal = await stud.balanceOf(await game.getAddress());
    await game.finish();
    expect(await stud.balanceOf(await game.getAddress())).to.equal(bal);
    await game.startGame();
    expect(await game.gameId()).to.equal(2);
  });

  it("11. owner-only withdrawals, and STUD is locked while a game runs", async () => {
    const { game, alice } = await setup();
    await game.startGame();
    await expect(game.connect(alice).withdrawEth()).to.be.revertedWith("Only owner");
    await expect(game.withdrawStud()).to.be.revertedWith("Game running");
  });
});
