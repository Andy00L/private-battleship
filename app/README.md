# Private Battleship - Frontend

[Back to main README](../README.md)

Next.js 16.2.2 frontend for the Private Battleship on-chain game. 10 components, 1 hook, 5 utility modules. 3941 lines of TypeScript/React total.

## Setup

```bash
npm install
npm run dev
```

Opens at `http://localhost:3000`. Requires a Phantom wallet. Connects to Solana devnet by default.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | No | `clusterApiUrl("devnet")` | Solana RPC endpoint. Validated as URL at startup. |
| `NEXT_PUBLIC_DEBUG_LOG` | No | disabled | When set (any truthy value), enables categorized debug logger and shows floating download button. |

## Stack

| Package | Version | Purpose |
|---|---|---|
| `next` | 16.2.2 | App Router framework |
| `react` | 19.2.4 | UI library |
| `typescript` | ^5 | Type system |
| `tailwindcss` | 4 | Utility CSS |
| `@solana/web3.js` | ^1.98.4 | Solana client |
| `@coral-xyz/anchor` | ^0.32.1 | Program client (IDL, PDA derivation) |
| `@magicblock-labs/ephemeral-rollups-sdk` | ^0.10.3 | TEE auth, permission PDAs, delegation |
| `framer-motion` | ^12.38.0 | Animation (grid cells, transitions) |
| `@noble/hashes` | ^1.8.0 | SHA-256 for board commit-reveal |
| `tweetnacl` | ^1.0.3 | Ed25519 signing for TEE auth tokens |

## Component Architecture

```
  page.tsx (phase router)
      │
      ├── GameLobby          (phase: lobby)
      │   └── HeroVideo
      │
      ├── PlacementPhase     (phase: placement)
      │   ├── BattleGrid     (own board, ship placement mode)
      │   └── GameBackground
      │
      ├── BattlePhase        (phase: battle)
      │   ├── BattleGrid     (own board, read-only)
      │   ├── BattleGrid     (opponent board, firing mode)
      │   ├── TransactionLog
      │   └── GameBackground
      │
      └── ResultPhase        (phase: result)
          └── GameBackground

  Floating overlays (always present):
      ├── wallet-provider.tsx (wraps entire app)
      └── DebugLogButton.tsx  (conditional on NEXT_PUBLIC_DEBUG_LOG)
```

## Components

| Component | Lines | Description |
|---|---|---|
| `BattleGrid.tsx` | 342 | 6x6 grid renderer. Multi-cell ship SVGs: ship-2.svg spans 2 cells, ship-3.svg spans 3 cells. Horizontal ships use `object-cover`. Vertical ships use `rotate(90deg)` + `translateX` correction + GPU compositing (`will-change: transform`). 3 most recent shots highlighted with CSS-animated borders (orange for hit, cyan for miss, red for sunk) that fade after 5 seconds. Crosshair, hit, and miss SVG icon overlays. |
| `PlacementPhase.tsx` | 307 | Ship placement interface. Players drag ships onto the 6x6 grid. Click to rotate between horizontal and vertical. Multi-cell SVG preview shows ship shape during placement. Validates no overlap and in-bounds before confirming. |
| `ResultPhase.tsx` | 164 | End-of-game screen. Drives the auto end-game flow: auto-settle on TEE, poll L1 for confirmation (up to 90s), auto-claim with session key (zero wallet popups for winner). Displays progress for each stage. Tracks `endGameStatus`: none, settling, settled, claiming, claimed, error. |
| `BattlePhase.tsx` | 159 | Main gameplay screen. Renders two BattleGrid instances (own board read-only, opponent board in firing mode). Shows whose turn it is. Includes TransactionLog sidebar. |
| `GameLobby.tsx` | 139 | Pre-game lobby. Create game form (set buy-in amount, optional invited player address). Join game form (enter game address). Displays SOL/USD equivalent via Oracle stub. |
| `GameBackground.tsx` | 115 | Fullscreen background video (`/assets/game-bg.mp4`, 31MB). Active during placement, battle, and result phases. Audio toggle button with localStorage persistence for user preference. Falls back to gradient on load failure. Respects `prefers-reduced-motion` media query. |
| `TransactionLog.tsx` | 69 | Scrollable sidebar listing on-chain transactions. Each entry shows timestamp, action name, latency in ms, and result (hit/miss/sunk). Color-coded: red for hit, blue for miss, orange+bold for sunk, green for other actions. |
| `wallet-provider.tsx` | 36 | Wraps the app with Solana wallet adapter context. Configures Phantom wallet. Uses `NEXT_PUBLIC_RPC_URL` if set, otherwise defaults to `clusterApiUrl("devnet")`. |
| `HeroVideo.tsx` | 27 | Video background for the lobby phase. Separate from GameBackground (different video source, no audio toggle). |
| `DebugLogButton.tsx` | 23 | Floating button in the bottom corner. Triggers JSON download of all debug logs. Only rendered when `NEXT_PUBLIC_DEBUG_LOG` environment variable is set. |

## Phase Routing

The page router in `page.tsx` selects which component to render based on game state from `useGame`.

| Phase | Component | Condition |
|---|---|---|
| Lobby | `GameLobby` | No active game, or game not yet joined |
| Placement | `PlacementPhase` | Game joined, status = Placing, ships not yet placed |
| Battle | `BattlePhase` | Status = Playing |
| Result | `ResultPhase` | Status = Finished or TimedOut |

```
    Wallet connected
          │
          v
    ┌──────────┐    create/join     ┌───────────────┐
    │  Lobby   │ ─────────────────> │  Placement    │
    │ GameLobby│                    │ PlacementPhase│
    └──────────┘                    └───────┬───────┘
                                            │ both placed
                                            v
                                    ┌───────────────┐
                                    │    Battle     │
                                    │ BattlePhase   │
                                    └───────┬───────┘
                                            │ winner or timeout
                                            v
                                    ┌───────────────┐
                                    │    Result     │
                                    │ ResultPhase   │
                                    └───────────────┘
```

## BattleGrid Cell States

The grid is 36 cells (6x6). Each cell has a numeric value that maps to a visual state.

| Value | Meaning | Own Board Display | Opponent Board Display |
|---|---|---|---|
| 0 | Empty/unknown | Water (dark) | Water (dark, clickable crosshair) |
| 1 | Ship (own) / Miss (opponent hits board) | Ship (gray, ship SVG) | Miss (blue dot) |
| 2 | Hit ship | Hit (red, explosion) | Hit (red, explosion) |
| 3 | Miss on water | Miss (blue dot) | Miss (blue dot) |

Recent shot highlighting (3 most recent shots):
- Hit: orange animated border, 5s fade
- Miss: cyan animated border, 5s fade
- Sunk (ship.hits == ship.size): red animated border, 5s fade

## useGame Hook

1945 lines. The entire game lifecycle: state management, TEE connection, transaction building, account subscriptions, orchestration, and auto-settlement.

### State

| Field | Type | Description |
|---|---|---|
| `gameAddress` | `PublicKey \| null` | Current game PDA address |
| `gameState` | `GameState \| null` | Deserialized GameState account |
| `myBoard` | `number[]` | Own 6x6 grid (36 cells) |
| `opponentHits` | `number[]` | Hit/miss board for opponent's grid |
| `phase` | `string` | Current UI phase (lobby/placement/battle/result) |
| `isMyTurn` | `boolean` | Whether it is the connected wallet's turn |
| `txLog` | `TxEntry[]` | Transaction log entries |
| `endGameStatus` | `string` | Settlement progress: none/settling/settled/claiming/claimed/error |
| `sessionKeypair` | `Keypair \| null` | In-memory session key for popup-free signing |
| `teeConnection` | `Connection \| null` | Authenticated TEE connection |
| `recentShots` | `Shot[]` | 3 most recent shots for border highlighting |

### Actions

| Action | Signed By | Description |
|---|---|---|
| `createGame(buyIn, invitedPlayer?)` | Wallet (batched) | Batch: ensureProfile + create_game + register_session_key. 1 popup. |
| `joinGame(gameAddress)` | Wallet (batched) | Batch: ensureProfile + join_game + delegate_board + register_session_key. 1 popup. |
| `placeShips(placements)` | Session key | Send place_ships to TEE. 0 popups. |
| `fire(row, col)` | Session key | Send fire to TEE. 0 popups. |
| `settleGame()` | Session key | Send settle_game to TEE. Auto-triggered on Finished. |
| `claimPrize()` | Session key | Send claim_prize to L1. winner_wallet set for SOL destination. Auto-triggered after settlement confirmed. |
| `cancelGame()` | Wallet | Cancel before opponent joins. |
| `claimTimeout()` | Wallet | Claim win or refund on opponent inactivity (300s). |

### Orchestration Flow (with TX Batching)

```
    Player A calls createGame():
    ┌─────────────────────────────────────────┐
    │ 1. Check profile (active_games < 3?)    │
    │    If stale: autoClaimTimeouts           │
    │    If 0 games found: reset_active_games  │
    │                                          │
    │ 2. Generate board hash:                  │
    │    salt = random 32 bytes                │
    │    hash = SHA256(ships || salt)           │
    │    Store salt in memory                  │
    │                                          │
    │ 3. Generate session keypair              │
    │    (preserved on retry, not regenerated) │
    │                                          │
    │ 4. Build batch TX:                       │
    │    - ensureProfile (idempotent)          │
    │    - create_game(buyIn, invite,          │
    │      seed_a, board_hash_a)               │
    │    - register_session_key                │
    │                                          │
    │ 5. Send TX (1 wallet popup)              │
    └─────────────────┬───────────────────────┘
                      │
                      v
    Orchestration (session key, no popups):
    - delegate_board (A's board)
    - Wait for Player B to join + delegate
    - delegate_game_state (after boards_delegated == 2)
    - request_turn_order (VRF)
    - Wait for callback_turn_order

    Player B calls joinGame():
    ┌─────────────────────────────────────────┐
    │ Same profile check + hash generation     │
    │                                          │
    │ Build batch TX:                          │
    │ - ensureProfile                          │
    │ - join_game(seed_b, board_hash_b)        │
    │ - delegate_board (B's board)             │
    │ - register_session_key                   │
    │                                          │
    │ Send TX (1 wallet popup)                 │
    └─────────────────────────────────────────┘
```

### Subscriptions

| Subscription | Source | Purpose |
|---|---|---|
| GameState | TEE (WebSocket) | Real-time game status, turns, hits, winner |
| Own PlayerBoard | TEE (WebSocket, authenticated) | Own grid updates (ship placement confirmation) |
| GameState (L1) | Solana devnet | Post-settlement confirmation polling |
| PlayerProfile | Solana devnet | Active games count for stale detection |

## Utilities

### tee-connection.ts (105 lines)

TEE auth token management. Handles `verifyTeeRpcIntegrity` and `getAuthToken` from the MagicBlock SDK.

```
    Connect to TEE
          │
          v
    ┌─────────────────────┐
    │ verifyTeeRpcIntegrity│
    │ (attempt 1 of 3)     │
    └──────────┬──────────┘
               │
          ┌────┴────┐
          │         │
       Success    Fail
          │         │
          v         v
    getAuthToken  Retry with backoff
          │       (attempt 2, then 3)
          v              │
    Connection     ┌─────┴─────┐
    ready          │           │
                 Success    All 3 fail
                   │           │
                   v           v
             getAuthToken   ┌──────────┐
                   │        │ Network? │
                   v        └──┬───┬───┘
             Connection       │   │
             ready         devnet  mainnet
                              │      │
                              v      v
                          Proceed  THROW
                          without  (strict)
                          attestation
```

Retry behavior:
- 3 attempts with exponential backoff
- Devnet: falls back to unauthenticated connection (proceed without TEE attestation)
- Mainnet: strict mode, throws on failure

### board-hash.ts (36 lines)

SHA-256 commit-reveal hash generation.

Input: array of ship placements (5 ships, each with startRow, startCol, size, horizontal).
Output: `{ hash: Uint8Array(32), salt: Uint8Array(32) }`.

Process:
1. Generate 32 random bytes as salt
2. Serialize placements to bytes (4 bytes per ship: row, col, size, horizontal)
3. Concatenate: `ships_bytes || salt`
4. Hash with SHA-256
5. Return hash and salt (salt stored in memory for post-game `verify_board`)

### oracle.ts (25 lines)

SOL/USD price stub. Returns a hardcoded or fetched price for display in the game lobby. The on-chain program deals exclusively in lamports. This is display-only.

### program.ts (126 lines)

PDA derivation, program addresses, and Anchor Program factory.

| Export | Description |
|---|---|
| `PROGRAM_ID` | `9DiCaM3ugtjo1f3xoCpG7Nxij112Qc9znVfjQvT6KHRR` |
| `DELEGATION_PROGRAM_ID` | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| `PERMISSION_PROGRAM_ID` | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| `VRF_PROGRAM_ID` | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
| `ORACLE_QUEUE` | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` |
| `MAGIC_PROGRAM_ID` | `Magic11111111111111111111111111111111111111` |
| `MAGIC_CONTEXT` | `MagicContext1111111111111111111111111111111` |
| `TEE_VALIDATOR` | `FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA` |
| `TEE_RPC` | `https://tee.magicblock.app` |
| `TEE_WS` | `wss://tee.magicblock.app` |
| `getGamePda(playerA, gameId)` | Derives `["game", playerA, gameId]` |
| `getBoardPda(game, player)` | Derives `["board", game, player]` |
| `getProfilePda(player)` | Derives `["profile", player]` |
| `getLeaderboardPda()` | Derives `["leaderboard"]` |
| `getSessionPda(player, sessionKey)` | Derives `["session", player, sessionKey]` |
| `getProgram(connection, wallet)` | Creates Anchor Program instance from IDL |

### debug-logger.ts (90 lines)

Categorized logging with JSON download. Only active when `NEXT_PUBLIC_DEBUG_LOG` is set.

| Category | Logged Events |
|---|---|
| `game` | State transitions, phase changes, game creation/join |
| `tee` | TEE connection, auth token refresh, attestation results |
| `tx` | Transaction sends, confirmations, errors, latency |
| `orchestration` | Batch TX assembly, delegation sequencing, VRF requests |

Each log entry includes: timestamp, category, message, and optional data payload. The `DebugLogButton` component triggers a JSON download of all accumulated entries.

## Theme

Dark military command center aesthetic.

| Element | Style |
|---|---|
| Background | Near-black with fullscreen video (game phases) or hero video (lobby) |
| Grid cells | Semi-transparent with colored borders. Water: dark slate. Ship: gray. Hit: red glow. Miss: blue tint. |
| Text | Monospace for TX log and coordinates. Sans-serif for UI elements. |
| Accent colors | Cyan (interactive), red (hits/danger), orange (sunk ships), green (success) |
| Recent shots | CSS-animated borders with 5s fade: orange (hit), cyan (miss), red (sunk) |
| Ship SVGs | Multi-cell: ship-1.svg (1 cell), ship-2.svg (2 cells), ship-3.svg (3 cells) |
| Audio | Background video audio with toggle. Preference saved to localStorage. |
| Motion | Respects `prefers-reduced-motion`. Framer Motion for grid cell interactions. |

[Back to main README](../README.md)
