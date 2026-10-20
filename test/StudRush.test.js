const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = ethers.parseEther("0.001");
const STUD = (n) => ethers.parseEther(String(n));

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
  it("1. positive: buying pays the best bonus and records state", async () => {
    const { shop, stud, alice } = await setup();
    await expect(shop.connect(alice).buy(0, { value: PRICE })).to.emit(shop, "Purchased");
    expect(await stud.balanceOf(alice.address)).to.equal(STUD(105)); // 100 + 5%
    const p = await shop.getPlayer(alice.address);
    expect(p.purchases).to.equal(1);
    expect(p.studBought).to.equal(STUD(105));
    expect(p.bonusEarned).to.equal(STUD(5));
    expect(await ethers.provider.getBalance(await shop.getAddress())).to.equal(PRICE);
  });

  it("starts with 5% / 3% / 1% and 30 s / 60 s / 120 s locks", async () => {
    const { shop } = await setup();
    const o = await shop.getOffers();
    expect([o[0].bonus, o[1].bonus, o[2].bonus]).to.deep.equal([500n, 300n, 100n]);
    expect([o[0].cooldown, o[1].cooldown, o[2].cooldown]).to.deep.equal([30n, 60n, 120n]);
  });

  it("2. negative: wrong price and unknown button are rejected", async () => {
    const { shop, alice } = await setup();
    await expect(shop.connect(alice).buy(0, { value: 0 })).to.be.revertedWith("Send exactly 0.001 ETH");
    await expect(shop.connect(alice).buy(0, { value: PRICE * 2n })).to.be.revertedWith("Send exactly 0.001 ETH");
    await expect(shop.connect(alice).buy(3, { value: PRICE })).to.be.revertedWith("Unknown offer");
  });

  it("3. negative: a purchase locks that button for EVERY wallet", async () => {
    const { shop, alice, bob } = await setup();
    await shop.connect(alice).buy(0, { value: PRICE });
    await expect(shop.connect(bob).buy(0, { value: PRICE })).to.be.revertedWith("Offer is cooling down");
    await expect(shop.connect(alice).buy(0, { value: PRICE })).to.be.revertedWith("Offer is cooling down");
    await shop.connect(bob).buy(1, { value: PRICE }); // other buttons stay open
    await time.increase(31);
    await shop.connect(bob).buy(0, { value: PRICE });
  });

  it("bonus drops 0.5% per buy on button 1 and stops at the 1% floor", async () => {
    const { shop, alice, bob } = await setup();
    const seen = [];
    for (let i = 0; i < 10; i++) {
      const who = i % 2 ? alice : bob;
      seen.push((await shop.getOffers())[0].bonus);
      await shop.connect(who).buy(0, { value: PRICE });
      await time.increase(30);
    }
    expect(seen.slice(0, 4)).to.deep.equal([500n, 450n, 400n, 350n]);
    expect(seen[9]).to.equal(100n); // floor
  });

  it("bonus recovers 0.1% per idle minute, up to the starting bonus", async () => {
    const { shop, alice } = await setup();
    await shop.connect(alice).buy(0, { value: PRICE }); // 5% -> 4.5% stored
    await time.increase(2 * 60);
    expect((await shop.getOffers())[0].bonus).to.equal(470n); // 450 + 2 * 10
    await time.increase(3600);
    expect((await shop.getOffers())[0].bonus).to.equal(500n); // capped at the start bonus
  });

  it("GAME holders get an extra 1%", async () => {
    const { shop, stud, gameTok, alice, bob } = await setup();
    await gameTok.transfer(alice.address, STUD(1));
    await shop.connect(alice).buy(0, { value: PRICE });
    await shop.connect(bob).buy(1, { value: PRICE });
    expect(await stud.balanceOf(alice.address)).to.equal(STUD(106)); // 5% + 1%
    expect(await stud.balanceOf(bob.address)).to.equal(STUD(103));   // 3%
    expect((await shop.getPlayer(alice.address)).gamePerk).to.equal(true);
  });

  it("4. negative: wallet limit of 10 packs", async () => {
    const { shop, alice } = await setup();
    for (let i = 0; i < 10; i++) {
      await shop.connect(alice).buy(2, { value: PRICE });
      await time.increase(121);
    }
    await expect(shop.connect(alice).buy(2, { value: PRICE })).to.be.revertedWith("Wallet limit reached");
  });

  it("5. second wallet keeps separate stats", async () => {
    const { shop, alice, bob } = await setup();
    await shop.connect(alice).buy(0, { value: PRICE });
    expect((await shop.getPlayer(bob.address)).purchases).to.equal(0);
    await shop.connect(bob).buy(2, { value: PRICE });
    expect((await shop.getPlayer(alice.address)).studBought).to.equal(STUD(105));
    expect((await shop.getPlayer(bob.address)).studBought).to.equal(STUD(101)); // 1% bonus
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
