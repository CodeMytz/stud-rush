require("dotenv").config({ quiet: true });
require("@nomicfoundation/hardhat-toolbox");

const key = process.env.PRIVATE_KEY || "";
const accounts = /^(0x)?[0-9a-fA-F]{64}$/.test(key) ? [key.startsWith("0x") ? key : "0x" + key] : [];

module.exports = {
  solidity: {
    version: "0.8.27",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
    },
  },
};
