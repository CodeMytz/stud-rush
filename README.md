# Stud Rush (game edition)

A game on **Ethereum Sepolia**. Five timed rounds, four deals per round. Every deal grows **1000 points** with **compound interest (salikti procenti)** and then a flat fee is taken off. The cards show only the rate, the periods and the fee, so players must calculate which deal is best.

```
value = 1000 * (1 + rate)^periods - 1000 - fee
```

## Rules

| Round | Timer |
|---|---|
| 1 | 30 s |
| 2 | 45 s |
| 3 | 60 s |
| 4 | 75 s |
| 5 | 90 s |

- Anyone can **start a game** when none is running. Round 1 starts immediately.
- **Join** with 0.001 ETH until round 2 begins (max 16 players).
- Each round every player makes **one pick** (final). Picks close when the round timer ends.
- The **contract is the server**: it computes the value of each pick and decides the best deal of the round. If two players pick equally valuable deals, the earlier pick wins.
- After round 5, anyone calls **Finish**. The winner has the **most round wins** (tiebreak: higher total value, then join order) and is paid **500 STUD** by the contract. No picks means no prize.
- Deal order inside a round is shuffled per game (seeded by the previous blockhash). The best deal is never the one with the highest rate.

## Contract (`contracts/StudRush.sol`)

```
startGame()            new game (previous one must be finished)
join() payable         exactly 0.001 ETH, until round 2
pick(slot)             slot 0..3, one per round
finish()               after round 5, pays the prize
getRoundDeals(id, r), dealValue(deal), currentRound(id), getPlayers(id), getPicks(id, p), getRoundWinners(id)
withdrawEth() / withdrawStud()   owner only (STUD only while no game is running)
```

## Deployed config

- STUD token `0xfe792c0c39DD8db1701555d4F5bc3084F294aE9B`
- Deployer `0x7d58D03772A365D931c824E16D3A2850fF969A22`
- StudRush `0x0FA14DF74EF7DFfb39367527B788A247e4cc5033` (tx `0xc5a3f5eaccb525bb7e87ef20c2a4a63712234c05f8219d8eef83ffb9cb2e44b8`)

> The `address` in `config.json` was set to the address you gave me, but that deployment was made from the **old shop** contract. Run `npm run deploy:sepolia` once with this version; it rewrites `config.json` and `abi.json` and funds the prize pool (`FUND_STUD`, default 5000 STUD = 10 games).

## Run

```bash
npm install
npm test                 # 11 Hardhat tests
npm run deploy:sepolia   # needs .env: PRIVATE_KEY, SMART_CONTRACT (STUD address)
npm start                # http://localhost:8080
```

## Limits

- Not audited; testnet only. The seed uses the previous blockhash, so shuffling is not secure randomness (it only changes slot order).
- Round timers use block time; the page syncs to it, but can differ by a few seconds.
- AI disclosure: code generated with Claude (Anthropic). The team must be able to explain it.
