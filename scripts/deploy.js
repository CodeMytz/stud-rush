const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const LIB = path.join(__dirname, "..", "src", "lib");
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const { ethers, network, artifacts } = hre;
  const local = network.name === "localhost" || network.name === "hardhat";
  if (network.name !== "sepolia" && !local) throw new Error("Run with --network sepolia (current: " + network.name + ")");

  const studAddress = process.env.SMART_CONTRACT; // STUD token
  if (!ethers.isAddress(studAddress || "")) throw new Error("Set SMART_CONTRACT (the STUD token address) in .env");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Set PRIVATE_KEY in .env (test wallet only)");
  const chain = await ethers.provider.getNetwork();
  if (network.name === "sepolia" && chain.chainId !== 11155111n) throw new Error("RPC is not Sepolia (chainId " + chain.chainId + ")");

  const stud = new ethers.Contract(studAddress, ERC20_ABI, deployer);
  const [sym, dec] = await Promise.all([stud.symbol(), stud.decimals()]);
  console.log(`STUD token ${studAddress}: symbol ${sym}, ${dec} decimals`);

  const Arena = await ethers.getContractFactory("YieldArena");
  const arena = await Arena.deploy(studAddress);
  const tx = arena.deploymentTransaction();
  console.log("Deploy tx:", tx.hash);
  await arena.waitForDeployment();
  const receipt = await tx.wait();
  const address = await arena.getAddress();
  console.log("YieldArena deployed to:", address);

  const artifact = await artifacts.readArtifact("YieldArena");
  const deployment = {
    chainId: Number(chain.chainId),
    address,
    stud: studAddress,
    deployBlock: receipt.blockNumber,
    deployTx: tx.hash,
    deployer: deployer.address,
  };
  fs.mkdirSync(LIB, { recursive: true });
  fs.writeFileSync(path.join(LIB, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");
  fs.writeFileSync(path.join(LIB, "abi.json"), JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log("\nWrote src/lib/deployment.json and src/lib/abi.json");
  console.log("Etherscan: https://sepolia.etherscan.io/address/" + address);
}

main().catch((e) => {
  console.error("\nError: " + (e.shortMessage || e.message || e));
  process.exitCode = 1;
});
