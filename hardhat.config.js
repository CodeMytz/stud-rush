require("dotenv").config({ quiet: true });
require("@nomicfoundation/hardhat-toolbox");

// Offline fallback: SOLCJS=1 compiles with the solc npm package instead of downloading a compiler.
if (process.env.SOLCJS) {
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args) => ({
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: require("solc/package.json").version,
  }));
}

const key = process.env.PRIVATE_KEY || "";
const accounts = /^(0x)?[0-9a-fA-F]{64}$/.test(key) ? [key.startsWith("0x") ? key : "0x" + key] : [];

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // E2E=1 makes the local node report the Sepolia chain id so the web page's network check passes.
    hardhat: process.env.E2E ? { chainId: 11155111 } : {},
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
    },
  },
};
