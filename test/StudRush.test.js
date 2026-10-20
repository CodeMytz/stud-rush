const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = ethers.parseEther("0.001");
const STUD = (n) => ethers.parseEther(String(n));
const PACK = STUD(100);

// Option ids: Rush 0-3, Steady 4-7, Bargain bin 8-11.
const QUICK_FLIP = 0, DOUBLE_UP = 1, SPRINT = 2, BURST = 3;
const SHORT_HOP = 4, EVEN_KEEL = 5, MARATHON = 7;
const PENNY_STACK = 8, NICKEL_DRIP = 9, DUST_PILE = 11;

// Same integer maths as the contract: compound the pack, then take off a flat fee.
function bonusJs(rateBps, rounds, feeBps, perk = false) {
  let a = PACK;
  for (let i = 0; i < rounds; i++) a = (a * (10000n + BigInt(rateBps))) / 10000n;
  const gross = a - PACK;
  const fee = (PACK * BigInt(feeBps)) / 10000n;
  const net = gross > fee ? gross - fee : 0n;
  return perk ? net + PACK / 100n : net;
}

async function setup() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockToken");
  const stud = await Token.deploy("STUD", "STUD");
  const gameTok = await Token.deploy("GAME", "GAME");
  const Shop = await ethers.getContractFactory("StudRush");
  const shop = await Shop.deploy(await stud.getAddress(), await gameTok.getAddress());
  await stud.transfer(await shop.getAddress(), STUD(10000));
  return { owner, alice, bob, carol, stud, gameTok, shop };
}

describe("StudRush", () => {
  it("1. positive: buying pays the compound bonus and records state", async () => {
    const { shop, stud, alice } = await setup();
    await expect(shop.connect(alice).buy(QUICK_FLIP, { value: PRICE })).to.emit(shop, "Purchased");
    expect(await stud.balanceOf(alice.address)).to.equal(STUD("110.25")); // 100 * 1.05^2
    const p = await shop.getPlayer(alice.address);
    expect(p.purchases).to.equal(1);
    expect(p.studBought).to.equal(STUD("110.25"));
    expect(p.bonusEarned).to.equal(STUD("10.25"));
    expect(await ethers.provider.getBalance(await shop.getAddress())).to.equal(PRICE);
  });

  it("has 3 tiers with 4 options each and the intended locks", async () => {
    const { shop } = await setup();
    const o = await shop.getOffers();
    expect(o.length).to.equal(12);
    for (let i = 0; i < 12; i++) {
      const lock = i < 4 ? 30n : i < 8 ? 60n : 120n;
      expect(o[i].cooldown).to.equal(lock);
      expect(o[i].rate).to.equal(o[i].startRate);
    }
  });

  it("on-chain compound maths matches the page formula for every option", async () => {
    const { shop } = await setup();
    const o = await shop.getOffers();
    for (let i = 0; i < 12; i++) {
      const expected = bonusJs(o[i].rate, o[i].rounds, o[i].feeBps);
      expect(await shop.quote(i, false)).to.equal(expected);
    }
  });

  it("compound interest beats simple interest: 3% x 4 rounds is 12.5509%, not 12%", async () => {
    const { shop } = await setup();
    // 100 * 1.03^4 = 112.550881; minus 0.50 STUD fee
    expect(await shop.bonusFor(300, 4, 50, false)).to.equal(STUD("12.050881"));
    expect(await shop.bonusFor(300, 4, 0, false)).to.equal(STUD("12.550881"));
  });

  it("the calculation decides: the 'bigger-looking' options are NOT the best in each tier", async () => {
    const { shop } = await setup();
    const q = async (i) => shop.quote(i, false);
    // Rush: simple r*n says Burst (12.5), compounding minus fee says Double Up
    expect(await q(DOUBLE_UP)).to.be.gt(await q(BURST));
    expect(await q(DOUBLE_UP)).to.be.gt(await q(SPRINT));
    expect(await q(DOUBLE_UP)).to.be.gt(await q(QUICK_FLIP));
    // Steady: simple r*n says Marathon (10.8), real best is Even Keel
    expect(await q(EVEN_KEEL)).to.be.gt(await q(MARATHON));
    expect(await q(EVEN_KEEL)).to.be.gt(await q(SHORT_HOP));
    // Bargain bin: simple r*n says Dust Pile (5.0), real best is Nickel Drip
    expect(await q(NICKEL_DRIP)).to.be.gt(await q(DUST_PILE));
    expect(await q(NICKEL_DRIP)).to.be.gt(await q(PENNY_STACK));
  });

  it("2. negative: wrong price and unknown option are rejected", async () => {
    const { shop, alice } = await setup();
    await expect(shop.connect(alice).buy(0, { value: 0 })).to.be.revertedWith("Send exactly 0.001 ETH");
    await expect(shop.connect(alice).buy(0, { value: PRICE * 2n })).to.be.revertedWith("Send exactly 0.001 ETH");
    await expect(shop.connect(alice).buy(12, { value: PRICE })).to.be.revertedWith("Unknown offer");
    await expect(shop.quote(12, false)).to.be.revertedWith("Unknown offer");
  });

  it("3. negative: a purchase locks that option for EVERY wallet, other options stay open", async () => {
    const { shop, alice, bob } = await setup();
    await shop.connect(alice).buy(DOUBLE_UP, { value: PRICE });
    await expect(shop.connect(bob).buy(DOUBLE_UP, { value: PRICE })).to.be.revertedWith("Offer is cooling down");
    await expect(shop.connect(alice).buy(DOUBLE_UP, { value: PRICE })).to.be.revertedWith("Offer is cooling down");
    await shop.connect(bob).buy(SPRINT, { value: PRICE }); // same tier, different option
    await shop.connect(bob).buy(EVEN_KEEL, { value: PRICE }); // other tier
    await time.increase(31);
    await shop.connect(bob).buy(DOUBLE_UP, { value: PRICE });
  });

  it("rate drops per buy, so the next bonus is recomputed from the new rate", async () => {
    const { shop, alice, bob } = await setup();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push((await shop.getOffers())[QUICK_FLIP].rate);
      await shop.connect(i % 2 ? alice : bob).buy(QUICK_FLIP, { value: PRICE });
      await time.increase(30);
    }
    expect(seen).to.deep.equal([500n, 450n, 400n, 350n]); // 5.00% -> 4.50% -> 4.00% -> 3.50%
    expect(await shop.bonusFor(450, 2, 0, false)).to.equal(bonusJs(450, 2, 0)); // 9.2025%
  });

  it("rate stops at the floor", async () => {
    const { shop, alice, bob } = await setup();
    for (let i = 0; i < 10; i++) {
      await shop.connect(i % 2 ? alice : bob).buy(QUICK_FLIP, { value: PRICE });
      await time.increase(30);
    }
    expect((await shop.getOffers())[QUICK_FLIP].rate).to.equal(100n); // 1.00% floor (+ no recovery within 30 s steps)
  });

  it("rate recovers 0.05% per idle minute, up to the starting rate", async () => {
    const { shop, alice } = await setup();
    await shop.connect(alice).buy(QUICK_FLIP, { value: PRICE }); // 5.00% -> 4.50% stored
    await time.increase(2 * 60);
    expect((await shop.getOffers())[QUICK_FLIP].rate).to.equal(460n); // 450 + 2 * 5
    await time.increase(3600);
    expect((await shop.getOffers())[QUICK_FLIP].rate).to.equal(500n); // capped at the start rate
  });

  it("a fee larger than the compound gain never makes the bonus negative", async () => {
    const { shop } = await setup();
    expect(await shop.bonusFor(10, 2, 500, false)).to.equal(0n);
  });

  it("GAME holders get an extra flat 1 STUD", async () => {
    const { shop, stud, gameTok, alice, bob } = await setup();
    await gameTok.transfer(alice.address, STUD(1));
    await shop.connect(alice).buy(QUICK_FLIP, { value: PRICE });
    await shop.connect(bob).buy(SHORT_HOP, { value: PRICE });
    expect(await stud.balanceOf(alice.address)).to.equal(STUD("111.25")); // 10.25 + 1
    expect(await stud.balanceOf(bob.address)).to.equal(PACK + bonusJs(350, 2, 0));
    expect((await shop.getPlayer(alice.address)).gamePerk).to.equal(true);
  });

  it("4. negative: wallet limit of 10 packs", async () => {
    const { shop, alice } = await setup();
    for (let i = 0; i < 10; i++) {
      await shop.connect(alice).buy(PENNY_STACK, { value: PRICE });
      await time.increase(121);
    }
    await expect(shop.connect(alice).buy(PENNY_STACK, { value: PRICE })).to.be.revertedWith("Wallet limit reached");
  });

  it("5. second wallet keeps separate stats", async () => {
    const { shop, alice, bob } = await setup();
    await shop.connect(alice).buy(QUICK_FLIP, { value: PRICE });
    expect((await shop.getPlayer(bob.address)).purchases).to.equal(0);
    await shop.connect(bob).buy(PENNY_STACK, { value: PRICE });
    expect((await shop.getPlayer(alice.address)).studBought).to.equal(STUD("110.25"));
    expect((await shop.getPlayer(bob.address)).studBought).to.equal(PACK + bonusJs(150, 3, 0));
    expect(await shop.totalPurchases()).to.equal(2);
  });

  it("6. negative: sold-out shop rejects the purchase", async () => {
    const { shop, owner, alice } = await setup();
    await shop.connect(owner).withdrawStud();
    await expect(shop.connect(alice).buy(0, { value: PRICE })).to.be.revertedWith("Shop is out of STUD");
  });

  it("only the owner can withdraw; owner gets ETH and STUD back", async () => {
    const { shop, stud, owner, alice } = await setup();
    await shop.connect(alice).buy(0, { value: PRICE });
    await expect(shop.connect(alice).withdrawEth()).to.be.revertedWith("Only owner");
    await expect(shop.connect(alice).withdrawStud()).to.be.revertedWith("Only owner");
    await expect(shop.connect(owner).withdrawEth()).to.changeEtherBalance(owner, PRICE, { includeFee: false });
    await shop.connect(owner).withdrawStud();
    expect(await stud.balanceOf(await shop.getAddress())).to.equal(0);
  });

  it("constructor rejects bad token addresses; GAME may be disabled", async () => {
    const [, alice] = await ethers.getSigners();
    const Shop = await ethers.getContractFactory("StudRush");
    await expect(Shop.deploy(ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWith("STUD address invalid");
    await expect(Shop.deploy(alice.address, ethers.ZeroAddress)).to.be.revertedWith("STUD address invalid");
    const Token = await ethers.getContractFactory("MockToken");
    const stud = await Token.deploy("STUD", "STUD");
    await expect(Shop.deploy(await stud.getAddress(), alice.address)).to.be.revertedWith("GAME address invalid");
    const shop = await Shop.deploy(await stud.getAddress(), ethers.ZeroAddress);
    expect(await shop.hasGamePerk(alice.address)).to.equal(false);
  });
});
