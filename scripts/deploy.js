const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const ROOT = path.join(__dirname, "..");
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

async function main() {
  const { ethers, network, artifacts } = hre;
  if (network.name !== "sepolia") throw new Error("Run with --network sepolia (current: " + network.name + ")");

  const studAddress = process.env.SMART_CONTRACT; // STUD token address
  const gameAddress = process.env.GAME_TOKEN || ethers.ZeroAddress; // optional
  if (!ethers.isAddress(studAddress || "")) throw new Error("Set SMART_CONTRACT (the STUD token address) in .env");
  if (!ethers.isAddress(gameAddress)) throw new Error("GAME_TOKEN in .env is not a valid address");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Set PRIVATE_KEY in .env (test wallet only)");
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 11155111n) throw new Error("RPC is not Sepolia (chainId " + chain.chainId + ")");

  const stud = new ethers.Contract(studAddress, ERC20_ABI, deployer);
  const [symbol, decimals, held] = await Promise.all([stud.symbol(), stud.decimals(), stud.balanceOf(deployer.address)]);
  console.log(`Token ${studAddress}: ${symbol}, ${decimals} decimals`);
  console.log(`Deployer ${deployer.address} holds ${ethers.formatUnits(held, decimals)} ${symbol}`);

  const Shop = await ethers.getContractFactory("StudRush");
  const shop = await Shop.deploy(studAddress, gameAddress);
  const tx = shop.deploymentTransaction();
  console.log("Deploy tx:", tx.hash);
  await shop.waitForDeployment();
  const receipt = await tx.wait();
  const address = await shop.getAddress();
  console.log("StudRush deployed to:", address);

  // Stock the shop so people can buy (set FUND_STUD=0 to skip).
  const fund = ethers.parseUnits(process.env.FUND_STUD || "10000", decimals);
  if (fund > 0n) {
    if (held < fund) throw new Error(`Deployer holds less than FUND_STUD (${process.env.FUND_STUD || "10000"}). Lower FUND_STUD or send ${symbol} to the shop manually.`);
    const t = await stud.transfer(address, fund);
    await t.wait();
    console.log(`Stocked the shop with ${ethers.formatUnits(fund, decimals)} ${symbol}`);
  }

  const artifact = await artifacts.readArtifact("StudRush");
  const config = {
    chainId: 11155111,
    address,
    stud: studAddress,
    gameToken: gameAddress,
    deployBlock: receipt.blockNumber,
    deployTx: tx.hash,
    deployer: deployer.address,
  };
  fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify(config, null, 2) + "\n");
  fs.writeFileSync(path.join(ROOT, "abi.json"), JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log("\nWrote config.json and abi.json");
  console.log("Etherscan: https://sepolia.etherscan.io/address/" + address);
  console.log("Deploy tx: https://sepolia.etherscan.io/tx/" + tx.hash);
}

main().catch((e) => {
  console.error("\nError: " + (e.shortMessage || e.message || e));
  process.exitCode = 1;
});
