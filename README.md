# Stud Rush

### Matīss Grūbe

A gamified STUD shop on **Ethereum Sepolia** (Group 2 project). Players buy STUD with Sepolia ETH from MetaMask. There are **three tiers (Rush, Steady, Bargain bin) with four options each**. Every option pays a bonus built with **compound interest (salikti procenti)**, so players must calculate to find the best option. Rates shrink with every purchase, and after anyone buys an option it is locked for **every** player.

> Test network and test ETH only. No real value.

## Game rules

One pack = **100 STUD for 0.001 ETH**. The bonus is extra STUD on top of the pack:

```
S     = 100 * (1 + rate)^rounds          (compound interest, salikti procenti)
bonus = S - 100 - fee                    (never below 0)
```

The cards show only the rate per round, the number of rounds and the flat fee. The player works out the bonus. Adding `rate * rounds` (simple interest) gives the wrong ranking on purpose.

| Tier | Lock | Option | Rate / round | Rounds | Fee (STUD) | Bonus at start |
|---|---|---|---|---|---|---|
| Rush | 30 s | Quick Flip | 5.00% | 2 | 0 | 10.2500 |
| | | Double Up | 3.00% | 4 | 0.50 | **12.0509** |
| | | Sprint | 2.00% | 6 | 1.00 | 11.6162 |
| | | Burst | 1.25% | 10 | 1.50 | 11.7271 |
| Steady | 60 s | Short Hop | 3.50% | 2 | 0 | 7.1225 |
| | | Even Keel | 1.80% | 5 | 0.25 | **9.0799** |
| | | Long Haul | 0.70% | 12 | 0.50 | 8.2311 |
| | | Marathon | 0.45% | 24 | 2.50 | 8.8778 |
| Bargain bin | 120 s | Penny Stack | 1.50% | 3 | 0 | 4.5678 |
| | | Nickel Drip | 0.80% | 6 | 0.10 | **4.7970** |
| | | Loose Change | 0.40% | 12 | 0.25 | 4.6570 |
| | | Dust Pile | 0.25% | 20 | 0.40 | 4.7206 |

- **Shrinking rate:** every purchase lowers that option's rate (step and floor are set per option), so the best option changes during play and must be recalculated.
- **Recovery:** each idle minute an option regains 0.05% of rate, up to its start rate.
- **Lock:** after anyone buys, that option is locked for all players; the other options stay open.
- **GAME perk:** holding at least 1 GAME adds a flat 1 STUD (off when `GAME_TOKEN` is empty).
- **Limit:** 10 packs per wallet.
- **Stock:** the shop sells from the STUD it holds. The deploy script stocks it.

### Page features

- **Math corner** with the formula, a worked example and a practice calculator.
- **Show the answers** toggle (off by default) reveals each option's bonus and marks the best one per tier.
- After every purchase the page says whether the pick was the best open option in its tier and keeps a "Smart picks" score in the browser.

**After pulling this version you must redeploy** (`npm run deploy:sepolia`): the contract changed, so the old address in `config.json` does not match the new `abi.json`.

### What runs on-chain and what runs in the page

| On-chain (`contracts/StudRush.sol`) | In the page (`game.js`) |
|---|---|
| Price, compound bonus and fee, rate decay, recovery, locks, wallet limit, stock, GAME perk, per-player results | Shows state, countdowns, builds the MetaMask transaction, displays errors |

The page cannot change a bonus, skip a lock or write a result. Turn on **Demo tools** to send a purchase the contract will reject; it fails on Etherscan, which proves the rules are enforced on-chain.

Fairness notes: no randomness is used. `block.timestamp` is only used for locks and recovery (miners can shift it by seconds). Exploit considered: bots can win the lock race, which is the intended game; the wallet limit and the 0.001 ETH price keep this cheap and bounded.

## Contract interface

```
buy(uint8 offerId) payable          exactly 0.001 ETH, offerId 0..11 (Rush 0-3, Steady 4-7, Bargain bin 8-11)
getOffers() view                    rate, decay, floor, rounds, fee, cooldown, readyAt, sold, lastBuyer for all 12 options
quote(offerId, perk) view           bonus STUD right now
bonusFor(rate, rounds, feeBps, perk) pure   the compound formula
getPlayer(address) view             purchases, studBought, bonusEarned, gamePerk
stock() view                        STUD left in the shop
withdrawEth() / withdrawStud()      owner only
event Purchased(buyer, offerId, studReceived, bonusStud, rateBps, lockedUntil)
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
test/StudRush.test.js          17 Hardhat tests
scripts/deploy.js              deploys the shop and stocks it with STUD
render.yaml                    Render static site
```

## Run it

```bash
npm install
npm test                      # 17 tests on the local Hardhat network
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
| Eligible purchase | Pack + compound bonus sent, state stored | `StudRush.test.js` |
| Compound maths, fee, ranking traps | Contract equals the page formula; best option per tier is not the one simple interest suggests | `StudRush.test.js` |
| Repeated or locked purchase | "Offer is cooling down" for every wallet | `StudRush.test.js` |
| Wallet limit, sold-out shop | Contract rejects | `StudRush.test.js` |
| Page reloaded | Results restored from the contract | Page reads `getPlayer` |
| Second wallet | Separate results | `StudRush.test.js` |
| Rejected in MetaMask | Shown as rejected, never as success | Page |

## Limits

- Not audited; for learning on a testnet only.
- Countdowns use the browser clock; the contract uses block time, so the page can differ by a few seconds.
- The purchase list reads recent logs from a public RPC, which may limit the range. Offers and results are always read directly from the contract.
