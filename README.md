# Private Battleship

Fully on-chain Battleship on Solana where your opponent cannot see your ships. Ship placements stay private inside Intel TDX hardware (TEE), hit/miss results are public, and commit-reveal hashing proves nobody tampered with boards after the fact. Even a compromised TEE cannot cheat, because pre-committed SHA-256 hashes lock in each player's board before the game starts.

Built with five MagicBlock products: Private Ephemeral Rollups, Ephemeral Rollups, VRF, Magic Actions, and Pricing Oracle.

- Solana program: 1783 lines of Rust, 19 instructions, 36 error codes
- Frontend: 3941 lines of TypeScript/React across 10 components, 1 hook, 5 utilities
- Program ID: `9DiCaM3ugtjo1f3xoCpG7Nxij112Qc9znVfjQvT6KHRR`

## Quick Start

```bash
# Prerequisites: Solana CLI (agave 3.1.9+), Anchor CLI 1.0.0, Node 18+, Rust 1.89.0

# 1. Build the on-chain program (from project root)
anchor build

# 2. Deploy to devnet
anchor deploy --provider.cluster devnet

# 3. Run the frontend
cd app
npm install
npm run dev
```

Open `http://localhost:3000` in two browser windows with different wallets.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | No | `clusterApiUrl("devnet")` | Solana RPC endpoint. Validated as URL. |
| `NEXT_PUBLIC_DEBUG_LOG` | No | disabled | Enables categorized debug logger and floating download button. |

## How the Game Works

Two players. Each has a 6x6 grid. Each places 5 ships (sizes: 3, 2, 2, 1, 1, totaling 9 cells). Players take turns firing at coordinates. Hit or miss is revealed on the public board. First to sink all opponent ships wins the pot.

Every action is an on-chain transaction. Ship placements are invisible to opponents, validators, and blockchain explorers. Shots land in 30-50ms on the TEE. Commit-reveal hashing proves nobody tampered with boards. VRF fairness is guaranteed by combining both players' seeds via XOR.

### State Diagram

```
WaitingForPlayer ──[join_game]──> Placing ──[both place_ships]──> Playing ──[ships_remaining=0]──> Finished
       │                            │                                │                                │
       │                            │                                │                                │
  [cancel_game]              [claim_timeout]                   [claim_timeout]                  [settle_game]
       │                            │                                │                                │
       v                            v                                v                                v
   Cancelled                    TimedOut                          TimedOut                       Committed
                                                                                                     │
                                                                                              [claim_prize]
                                                                                                     │
                                                                                                     v
                                                                                                  Claimed
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend (Next.js 16.2.2 + React 19.2.4)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ GameLobby│  │Placement │  │ Battle   │  │ ResultPhase      │   │
│  │  Phase   │  │  Phase   │  │  Phase   │  │ (auto-settle/    │   │
│  │          │  │          │  │          │  │  auto-claim)     │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬──────────┘   │
│       └──────────────┴──────────────┴───────────────┘              │
│                              │                                      │
│                       useGame.ts (1945 lines)                       │
│                              │                                      │
├──────────────────────────────┼──────────────────────────────────────┤
│              Solana Devnet   │         TEE (Intel TDX)              │
│         ┌────────────────────┴──────────────────────┐              │
│         │                                            │              │
│  Base Layer (L1)                        TEE Validator (PER)        │
│  - create_game                          - place_ships (private)    │
│  - join_game                            - fire (reads private      │
│  - delegate_board                         boards in TEE context)   │
│  - delegate_game_state                  - settle_game (commit +    │
│  - request_turn_order (VRF)               undelegate)              │
│  - claim_prize                                                      │
│  - claim_timeout                                                    │
│  - verify_board                                                     │
│         │                                            │              │
│         └──────────────GameState (public)─────────────┘              │
│                    PlayerBoard A (private to A)                      │
│                    PlayerBoard B (private to B)                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
solana-blitz-v3/
├── programs/battleship/src/
│   └── lib.rs                    # 1783 lines, entire Solana program
├── app/
│   └── src/
│       ├── app/
│       │   ├── layout.tsx        # Root layout with wallet provider
│       │   └── page.tsx          # Phase router (lobby/placement/battle/result)
│       ├── components/
│       │   ├── BattleGrid.tsx    # 342 lines - 6x6 grid with multi-cell ship SVGs
│       │   ├── BattlePhase.tsx   # 159 lines - two grids + turn indicator
│       │   ├── DebugLogButton.tsx # 23 lines - floating debug download
│       │   ├── GameBackground.tsx # 115 lines - fullscreen video + audio toggle
│       │   ├── GameLobby.tsx     # 139 lines - create/join game forms
│       │   ├── HeroVideo.tsx     # 27 lines - lobby video background
│       │   ├── PlacementPhase.tsx # 307 lines - ship placement with SVG preview
│       │   ├── ResultPhase.tsx   # 164 lines - auto-settle/claim progress
│       │   ├── TransactionLog.tsx # 69 lines - color-coded TX entries
│       │   └── wallet-provider.tsx # 36 lines - Phantom on configurable RPC
│       ├── hooks/
│       │   └── useGame.ts        # 1945 lines - entire game lifecycle
│       └── lib/
│           ├── program.ts        # 126 lines - PDA derivation, Anchor factory
│           ├── tee-connection.ts # 105 lines - TEE auth with retry + fallback
│           ├── board-hash.ts     # 36 lines - SHA-256 commit-reveal
│           ├── debug-logger.ts   # 90 lines - categorized logging
│           ├── oracle.ts         # 25 lines - SOL/USD price stub
│           └── idl.json          # Anchor IDL (auto-generated)
├── Anchor.toml
├── Cargo.toml
└── rust-toolchain.toml
```

## On-Chain Program

Program ID: `9DiCaM3ugtjo1f3xoCpG7Nxij112Qc9znVfjQvT6KHRR`

1783 lines of Rust. 19 `pub fn` instructions defined in source code. The `#[ephemeral]` macro on the program module generates a 20th instruction (`process_undelegation`) that appears in the IDL but is not explicitly written.

### Instructions (19 + 1 auto-generated)

| # | Instruction | Layer | Description |
|---|---|---|---|
| 1 | `initialize_profile` | Base | Create PlayerProfile PDA for a new player |
| 2 | `initialize_leaderboard` | Base | Create global Leaderboard PDA (one-time) |
| 3 | `create_game` | Base | Create GameState + Board A + permission ACL + commit hash A + deposit buy-in |
| 4 | `join_game` | Base | Create Board B + permission ACL + commit hash B + deposit buy-in |
| 5 | `cancel_game` | Base | Cancel before opponent joins, refund Player A |
| 6 | `delegate_board` | Base | Delegate player's board to TEE validator |
| 7 | `delegate_game_state` | Base | Delegate GameState to TEE with public ACL |
| 8 | `request_turn_order` | Base | VRF request using combined seeds (seed_a XOR seed_b) |
| 9 | `callback_turn_order` | Base | VRF callback, sets current_turn from randomness |
| 10 | `register_session_key` | Base | Create SessionAuthority PDA for popup-free signing |
| 11 | `revoke_session_key` | Base | Close SessionAuthority PDA |
| 12 | `place_ships` | TEE | Private ship placement with validation guards |
| 13 | `fire` | TEE | Shoot at opponent's grid, reads private board in TEE |
| 14 | `update_leaderboard` | Base | Magic Action callback, updates leaderboard on L1 |
| 15 | `settle_game` | TEE | Commit game + both boards, trigger leaderboard update |
| 16 | `claim_prize` | Base | Winner withdraws pot, updates profiles |
| 17 | `claim_timeout` | Base | Claim win or refund on opponent inactivity |
| 18 | `verify_board` | Base | Commit-reveal hash verification (defense-in-depth) |
| 19 | `reset_active_games` | Base | Recovery: reset active_games counter when no games found |
| 20 | `process_undelegation` | Base | Auto-generated by `#[ephemeral]` macro |

### Account Layout (5 accounts)

| Account | Size (bytes) | PDA Seeds | Delegation | Description |
|---|---|---|---|---|
| `GameState` | 446 | `["game", player_a, game_id]` | Public (TEE) | Tracks game status, turns, pots, hit boards, hashes, VRF seeds |
| `PlayerBoard` | 136 | `["board", game, player]` | Private (TEE, owner-only) | 6x6 grid, 5 ships, placement flags |
| `PlayerProfile` | 58 | `["profile", player]` | Never | Active games counter, lifetime stats |
| `Leaderboard` | 455 | `["leaderboard"]` | Never | Top 10 entries, total games played |
| `SessionAuthority` | 113 | `["session", player, session_pubkey]` | Never | Ephemeral signing key with expiry |

Additional PDA seeds used: `"identity"`.

### Game Constants

| Constant | Value | Description |
|---|---|---|
| `TIMEOUT_SECONDS` | 300 | 5 minutes of inactivity before timeout claim |
| `MIN_BUY_IN` | 1,000,000 lamports | 0.001 SOL minimum |
| `MAX_BUY_IN` | 100,000,000,000 lamports | 100 SOL maximum |
| `MAX_ACTIVE_GAMES` | 3 | Per-player concurrent game limit |
| `MAX_LEADERBOARD_ENTRIES` | 10 | Fixed leaderboard size |
| `MAX_SESSION_DURATION` | 3600 | 1 hour session key expiry |
| Grid size | 6x6 | 36 cells per board |
| Ship sizes | 3, 2, 2, 1, 1 | 5 ships, 9 total cells |

### Error Codes (36 total)

| Code | Name | Message |
|---|---|---|
| 6000 | `GameFull` | Game is full |
| 6001 | `NotInvited` | You are not invited to this game |
| 6002 | `NotYourBoard` | Not your board |
| 6003 | `WrongPhase` | Wrong game phase for this action |
| 6004 | `AlreadyPlaced` | Ships already placed |
| 6005 | `InvalidShipCount` | Must place exactly 5 ships |
| 6006 | `InvalidShipSizes` | Ship sizes must be [3, 2, 2, 1, 1] |
| 6007 | `OutOfBounds` | Ship placement out of bounds |
| 6008 | `ShipsOverlap` | Ships overlap |
| 6009 | `NotYourTurn` | Not your turn |
| 6010 | `GameNotActive` | Game is not active |
| 6011 | `AlreadyFired` | Already fired at this cell |
| 6012 | `WrongTarget` | Target board does not belong to your opponent |
| 6013 | `NotAPlayer` | You are not a player in this game |
| 6014 | `GameNotFinished` | Game is not finished |
| 6015 | `NotWinner` | You are not the winner |
| 6016 | `BuyInTooLow` | Buy-in below minimum |
| 6017 | `BuyInTooHigh` | Buy-in above maximum |
| 6018 | `CannotCancel` | Cannot cancel: game already started |
| 6019 | `NotTimedOut` | Timeout period has not elapsed |
| 6020 | `TooManyGames` | Too many active games |
| 6021 | `HashAlreadySet` | Board hash already committed |
| 6022 | `BoardTampered` | Board hash does not match revealed placement |
| 6023 | `HashNotCommitted` | Hash not yet committed |
| 6024 | `NotPlayerA` | Not player A |
| 6025 | `BoardsNotDelegated` | Boards not fully delegated |
| 6026 | `Overflow` | Integer overflow |
| 6027 | `InvalidSessionKey` | Invalid session key |
| 6028 | `SessionExpired` | Session expired |
| 6029 | `SessionNotFound` | Session not found |
| 6030 | `UnauthorizedSession` | Unauthorized session |
| 6031 | `SelfPlay` | Cannot play against yourself |
| 6032 | `InvalidShipData` | Invalid ship data |
| 6033 | `GameAlreadyStarted` | Game already started |
| 6034 | `InvalidBuyIn` | Invalid buy-in amount |
| 6035 | `StaleProfile` | Stale profile detected |

## Privacy Model

```
               BEFORE GAME                    DURING GAME                    AFTER GAME
          ┌─────────────────┐          ┌─────────────────────┐         ┌──────────────────┐
          │  Client-side    │          │  TEE (Intel TDX)     │         │  Base Layer      │
          │                 │          │                      │         │                  │
Player A: │  board_hash_a = │  ──────> │  PlayerBoard A       │ ──────> │  Boards public   │
          │  SHA256(ships   │          │  (private, only A    │         │  (ACLs removed)  │
          │  + salt)        │          │   can read via ACL)  │         │                  │
          │                 │          │                      │         │  verify_board()  │
Player B: │  board_hash_b = │  ──────> │  PlayerBoard B       │ ──────> │  proves hash     │
          │  SHA256(ships   │          │  (private, only B    │         │  matches ships   │
          │  + salt)        │          │   can read via ACL)  │         │                  │
          └─────────────────┘          └─────────────────────┘         └──────────────────┘

          Hashes committed            TEE reads both boards              Anyone can verify
          to GameState on L1          atomically for fire()              with original salt
```

Three layers of privacy protection:

1. **TEE Hardware Isolation**: PlayerBoard accounts have private ACLs. Only the owner's auth token (signed by their wallet) can read the data. The TEE validator enforces this at the hardware level via Intel TDX.

2. **Same Execution Context**: All accounts (GameState, Board A, Board B) delegate to the same TEE validator. This allows the `fire` instruction to atomically read the opponent's private board and write the hit/miss result to the public GameState, all within one transaction.

3. **Commit-Reveal Verification**: Before the game starts, each player commits `SHA256(ships || salt)` to the GameState. After the game ends, anyone can call `verify_board` with the original placements and salt to prove the TEE did not modify ship positions.

## Frontend

10 components, 1 hook, 5 utility modules. 3941 lines total across all frontend files.

### Components

| Component | Lines | Description |
|---|---|---|
| `BattleGrid.tsx` | 342 | 6x6 grid with multi-cell ship SVGs (ship-2.svg, ship-3.svg). Horizontal uses object-cover, vertical uses rotate(90deg) + translateX correction + GPU compositing. 3 most recent shots highlighted with CSS-animated borders (orange=hit, cyan=miss, red=sunk), 5s fade. Hit/miss/crosshair icon overlays. |
| `PlacementPhase.tsx` | 307 | Ship placement interface with multi-cell SVG preview. Drag ships onto grid, rotate with click. |
| `ResultPhase.tsx` | 164 | Status-based result screen. Auto-settle on TEE, polls L1 confirmation (up to 90s), auto-claim with session key (zero popups for winner). Tracks endGameStatus: none/settling/settled/claiming/claimed/error. |
| `BattlePhase.tsx` | 159 | Two grids (yours + opponent's) with turn indicator and transaction log sidebar. |
| `GameLobby.tsx` | 139 | Create game (set buy-in, optional invite) and join game forms. Shows SOL/USD price via Oracle stub. |
| `GameBackground.tsx` | 115 | Fullscreen video background (/assets/game-bg.mp4, 31MB) on placement/battle/result phases. Audio toggle with localStorage persistence. Gradient fallback. Respects prefers-reduced-motion. |
| `TransactionLog.tsx` | 69 | Color-coded transaction entries showing action, latency, and hit/miss/sunk result. |
| `wallet-provider.tsx` | 36 | Phantom wallet adapter on configurable RPC (NEXT_PUBLIC_RPC_URL). |
| `HeroVideo.tsx` | 27 | Lobby phase video background. |
| `DebugLogButton.tsx` | 23 | Floating button to download debug logs. Only visible when NEXT_PUBLIC_DEBUG_LOG is set. |

### useGame Hook (1945 lines)

The entire game lifecycle lives in a single hook. It manages state, subscriptions, transaction building, orchestration, and auto-settlement.

Key features:
- TX batching: Player A sends ensureProfile + create_game + register_session_key as one wallet popup. Player B sends ensureProfile + join_game + delegate_board + register_session_key as one wallet popup.
- Session keys: `fire()` and `place_ships()` use a session key for popup-free signing. `claim_prize` also supports session key with `winner_wallet` for SOL destination.
- Auto end-game: settle on TEE, poll L1 for confirmation (up to 90s), auto-claim with session key. Zero popups for the winner.
- Session key preservation: existing keypair is preserved on retry, never regenerated.
- Stale profile recovery: checks active_games before batch TX. If active_games >= 3, runs autoClaimTimeouts which calls reset_active_games if 0 actual games found.

### Utilities

| File | Lines | Description |
|---|---|---|
| `program.ts` | 126 | PDA derivation helpers, program addresses, Anchor Program factory |
| `tee-connection.ts` | 105 | TEE auth token management with 3 retry attempts + exponential backoff. Devnet: falls back to proceed without attestation. Mainnet: strict (throws). |
| `debug-logger.ts` | 90 | Categorized logging (game, tee, tx, orchestration) with JSON download |
| `board-hash.ts` | 36 | SHA-256 board hash generation for commit-reveal. Generates random 32-byte salt. |
| `oracle.ts` | 25 | SOL/USD price stub for display. Contract only deals in lamports. |

## Dependencies

### Rust

| Crate | Version |
|---|---|
| `anchor-lang` | 0.32.1 |
| `ephemeral-rollups-sdk` | 0.8.6 |
| `ephemeral-vrf-sdk` | 0.2.3 |
| `solana-program` | 2.2.1 |

Rust toolchain: 1.89.0

### Frontend

| Package | Version |
|---|---|
| `next` | 16.2.2 |
| `react` | 19.2.4 |
| `typescript` | ^5 |
| `tailwindcss` | 4 |
| `@solana/web3.js` | ^1.98.4 |
| `@coral-xyz/anchor` | ^0.32.1 |
| `@magicblock-labs/ephemeral-rollups-sdk` | ^0.10.3 |
| `framer-motion` | ^12.38.0 |
| `@noble/hashes` | ^1.8.0 |
| `tweetnacl` | ^1.0.3 |

## Program Addresses

| Name | Address |
|---|---|
| Battleship Program | `9DiCaM3ugtjo1f3xoCpG7Nxij112Qc9znVfjQvT6KHRR` |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Permission Program | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| VRF Program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
| Oracle Queue | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` |
| Magic Program | `Magic11111111111111111111111111111111111111` |
| Magic Context | `MagicContext1111111111111111111111111111111` |
| TEE Validator | `FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA` |
| TEE RPC | `https://tee.magicblock.app` |
| TEE WebSocket | `wss://tee.magicblock.app` |

## Security

21 security fixes integrated from audit. 0 open bugs.

- **Cross-validator atomicity**: All accounts delegate to the same TEE validator, ensuring atomic transactions across GameState and both PlayerBoards.
- **Fund safety**: cancel_game refunds Player A before opponent joins. claim_timeout handles all phases (WaitingForPlayer, Placing, Playing). last_action_ts tracks inactivity.
- **Board creation timing**: Board A created with create_game, Board B with join_game. No board created for unknown players.
- **Oracle price safety**: Pricing Oracle used in frontend only for SOL/USD display. Contract deals exclusively in lamports. No price-drift vulnerability.
- **TEE attestation**: `verifyTeeRpcIntegrity` called before establishing connection. Retry with backoff. Devnet allows fallback, mainnet is strict.
- **VRF fairness**: Turn order determined by `VRF(seed_a XOR seed_b)`. Neither player can manipulate the outcome alone.
- **Commit-reveal**: SHA-256 board hashes committed before game starts, verifiable after game ends.
- **Session key scoping**: Session keys expire after 3600 seconds. Tied to specific player via PDA.
- **Concurrent games**: PlayerProfile tracks active_games with a cap of 3. Stale profile recovery via reset_active_games.
- **Integer overflow**: All arithmetic uses checked operations or saturating_sub.

## Limitations

- Grid is fixed at 6x6. Not configurable.
- Ships are fixed at sizes [3, 2, 2, 1, 1]. No adjacency rules enforced (by design).
- Leaderboard holds 10 entries. No pagination or eviction strategy beyond filling empty slots.
- Oracle returns a stub price. Real MagicBlock Oracle integration requires their price account address.
- TEE attestation is relaxed on devnet (proceeds without verification if it fails after 3 attempts).
- Game background video is 31MB. No adaptive streaming.

## Documentation

| Document | Description |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System diagrams, data flows, CPI map, design decisions |
| [app/README.md](./app/README.md) | Frontend setup, component architecture, hook internals |
| [CLAUDE.md](./CLAUDE.md) | Full implementation guide with all instruction code |

## License

MIT
