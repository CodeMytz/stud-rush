# Stud Rush

A gamified STUD shop on **Ethereum Sepolia** (Group 2 project). Players buy STUD with Sepolia ETH from MetaMask by choosing one of three buttons. Each button adds a bonus on top of the pack, the bonus shrinks with every purchase, and after anyone buys a button it is locked for **every** player.

> Test network and test ETH only. No real value.

## Game rules

One pack = **100 STUD for 0.001 ETH**. The bonus is extra STUD on top of the pack.

| Button | Start bonus | Loss per purchase | Lowest bonus | Lock for all players |
|---|---|---|---|---|
| Rush | 5.00% | 0.50% | 1.00% | 30 s |
| Steady | 3.00% | 0.25% | 0.50% | 60 s |
| Bargain bin | 1.00% | 0.10% | 0.10% | 120 s |

- **Recovery:** each idle minute a button regains 0.10%, up to its start bonus.
- **GAME perk:** holding at least 1 GAME adds 1.00% to every purchase (off when `GAME_TOKEN` is empty).
- **Limit:** 10 packs per wallet.
- **Stock:** the shop sells from the STUD it holds. The deploy script stocks it.

### What runs on-chain and what runs in the page

| On-chain (`contracts/StudRush.sol`) | In the page (`game.js`) |
|---|---|
| Price, bonus, decay, recovery, locks, wallet limit, stock, GAME perk, per-player results | Shows state, countdowns, builds the MetaMask transaction, displays errors |

The page cannot change a bonus, skip a lock or write a result. Turn on **Demo tools** to send a purchase the contract will reject; it fails on Etherscan, which proves the rules are enforced on-chain.

Fairness notes: no randomness is used. `block.timestamp` is only used for locks and recovery (miners can shift it by seconds). Exploit considered: bots can win the lock race, which is the intended game; the wallet limit and the 0.001 ETH price keep this cheap and bounded.

## Contract interface

```
buy(uint8 offerId) payable          exactly 0.001 ETH, offerId 0, 1 or 2
getOffers() view                    bonus, decay, floor, cooldown, readyAt, sold, lastBuyer for all 3 buttons
getPlayer(address) view             purchases, studBought, bonusEarned, gamePerk
stock() view                        STUD left in the shop
withdrawEth() / withdrawStud()      owner only
event Purchased(buyer, offerId, studReceived, bonusStud, bonusBps, lockedUntil)
```

## Project structure

```
index.html            page
style.css             design (dark/light)
game.js               ethers.js v6 + MetaMask logic
config.json           addresses (written by the deploy script)
abi.json              contract ABI (written by the deploy script)
contracts/StudRush.sol
contracts/test/MockToken.sol   test helper, not deployed
test/StudRush.test.js          12 Hardhat tests
scripts/deploy.js              deploys the shop and stocks it with STUD
render.yaml                    Render static site
```

## Run it

```bash
npm install
npm test                      # 12 tests on the local Hardhat network
```

1. Copy `.env.example` to `.env` and fill in `PRIVATE_KEY` (test wallet that holds the STUD and has SepoliaETH). `SMART_CONTRACT` is the STUD address. Add `GAME_TOKEN` when GAME exists.
2. Deploy and stock the shop:
   ```bash
   npm run deploy:sepolia
   ```
   This writes `config.json` and `abi.json`. Save the printed contract address and deploy transaction link.
3. Try it locally: `npm start`, then open http://localhost:8080
4. Commit and push (`.env` is ignored). Include the updated `config.json`.

### Publish

- **GitHub Pages:** Settings, Pages, Deploy from a branch, `main` / (root).
- **Render:** New, Static Site, pick the repo, leave the build command empty, publish directory `.` (or use the Blueprint with `render.yaml`).

## Test report

| Scenario | Expected | Covered by |
|---|---|---|
| Wallet not connected | Clear prompt, no transaction | Page (button says "Connect MetaMask to buy") |
| Wrong network | Sepolia warning, no transaction | Page (badge "Wrong network", button "Switch to Sepolia") |
| Wrong price / unknown button | Contract rejects | `StudRush.test.js` |
| Eligible purchase | Pack + bonus sent, state stored | `StudRush.test.js` |
| Repeated or locked purchase | "Offer is cooling down" for every wallet | `StudRush.test.js` |
| Wallet limit, sold-out shop | Contract rejects | `StudRush.test.js` |
| Page reloaded | Results restored from the contract | Page reads `getPlayer` |
| Second wallet | Separate results | `StudRush.test.js` |
| Rejected in MetaMask | Shown as rejected, never as success | Page |

## Limits

- Not audited; for learning on a testnet only.
- Countdowns use the browser clock; the contract uses block time, so the page can differ by a few seconds.
- The purchase list reads recent logs from a public RPC, which may limit the range. Offers and results are always read directly from the contract.

## AI disclosure

This project's code was generated with Claude (Anthropic). The team must be able to explain the code, run the tests, deploy with their own test wallet and verify the result with two wallets.
