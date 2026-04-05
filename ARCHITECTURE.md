# Architecture

System architecture for Private Battleship. Covers account relationships, instruction flows, CPI interactions, frontend orchestration, and design decisions.

[Back to README](README.md)

## System Overview

The program runs across two execution contexts: Solana L1 (base layer) and MagicBlock's TEE (Trusted Execution Environment running Intel TDX). Accounts are created on L1, delegated to the TEE for private gameplay, then committed back to L1 for settlement.

```mermaid
graph TD
    subgraph Frontend["Frontend - Next.js 16.2.2"]
        UG["useGame.ts - 2040 lines"]
        GL["GameLobby - create/join"]
        PL["Placement - place_ships"]
        BT["Battle - fire"]
        RS["Result - settle/claim"]
    end
    subgraph L1["Solana Devnet - Base Layer"]
        CG["create_game"]
        JG["join_game"]
        DB["delegate_board x2"]
        DGS["delegate_game_state"]
        RTO["request_turn_order"]
        RSK["register_session_key"]
        CP["claim_prize"]
        VB["verify_board"]
    end
    subgraph TEELayer["TEE Validator - Intel TDX PER"]
        TEEID["FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA"]
        PS["place_ships - writes to private PlayerBoard"]
        FI["fire - reads private board, writes public hits"]
        SG["settle_game - commits game + both boards to L1"]
    end
    GL -->|"Batched TX, 1 popup"| CG
    PL -->|"Session Key, 0 popups"| PS
    BT -->|"Session Key, 0 popups"| FI
    RS -->|"Session Key"| SG
    RS -->|"Session Key"| CP
```

## Directory Structure

```
solana-blitz-v3/
├── programs/battleship/src/
│   └── lib.rs                       # 1796 lines - Solana program (19 instructions, 36 errors)
├── app/                             # Frontend application
│   └── src/
│       ├── app/
│       │   ├── layout.tsx           # Root layout + wallet provider
│       │   └── page.tsx             # Phase router
│       ├── components/              # 10 components
│       │   ├── BattleGrid.tsx       # 330 lines
│       │   ├── BattlePhase.tsx      # 159 lines
│       │   ├── DebugLogButton.tsx   #  23 lines
│       │   ├── GameBackground.tsx   # 148 lines
│       │   ├── GameLobby.tsx        # 184 lines
│       │   ├── HeroVideo.tsx        #  27 lines
│       │   ├── PlacementPhase.tsx   # 356 lines
│       │   ├── ResultPhase.tsx      # 157 lines
│       │   ├── TransactionLog.tsx   #  69 lines
│       │   └── wallet-provider.tsx  #  36 lines
│       ├── hooks/
│       │   └── useGame.ts           # 2040 lines
│       └── lib/                     # 6 utility modules
│           ├── program.ts           # 126 lines
│           ├── tee-connection.ts    # 105 lines
│           ├── debug-logger.ts      #  90 lines
│           ├── board-hash.ts        #  36 lines
│           ├── sfx.ts              #  69 lines
│           ├── oracle.ts            #  25 lines
│           └── idl.json             # Anchor IDL (auto-generated)
├── Anchor.toml
├── Cargo.toml
└── rust-toolchain.toml              # Rust 1.89.0
```

Total frontend: 4334 lines across all files.

## Game Lifecycle Sequence Diagram

```mermaid
sequenceDiagram
    participant PA as Player A
    participant BL as Base Layer
    participant TEE as TEE Validator
    participant PB as Player B
    PA->>BL: initialize_profile
    PB->>BL: initialize_profile
    Note over PA,BL: Batch TX - 1 wallet popup
    PA->>BL: create_game + ensureProfile + register_session_key
    Note over PB,BL: Batch TX - 1 wallet popup
    PB->>BL: join_game + ensureProfile + delegate_board + register_session_key
    PA->>BL: delegate_board
    BL->>TEE: board A to TEE
    PA->>BL: delegate_game_state
    BL->>TEE: GameState to TEE
    PA->>BL: request_turn_order
    BL->>TEE: VRF with seed_a XOR seed_b
    TEE-->>BL: callback_turn_order
    Note over PA,PB: Session key signing - 0 popups
    PA->>TEE: place_ships
    PB->>TEE: place_ships
    Note over TEE: status becomes Playing
    PA->>TEE: fire
    PB->>TEE: fire
    Note over PA,PB: turns repeat until winner
    PA->>TEE: settle_game
    TEE->>BL: commit game + boards
    TEE->>BL: update_leaderboard via Magic Action
    PA->>BL: claim_prize via session key
    PA->>BL: verify_board - anyone can call
```

## Account Relationships (ER Diagram)

5 account types. Fixed-size arrays throughout (no Vec).

```mermaid
erDiagram
    PLAYERPROFILE {
        pubkey player PK
        u8 active_games
        u32 total_wins
        u32 total_games
        u32 total_shots_fired
        u32 total_hits
        u8 profile_bump
    }
    GAMESTATE {
        u64 game_id PK
        pubkey player_a FK
        pubkey player_b FK
        pubkey invited_player
        u8 status
        pubkey current_turn
        u16 turn_count
        u64 pot_lamports
        u64 buy_in_lamports
        u8x36 board_a_hits
        u8x36 board_b_hits
        u8 ships_remaining_a
        u8 ships_remaining_b
        pubkey winner
        bool has_winner
        u8x32 vrf_seed
        u8x32 seed_a
        u8x32 seed_b
        u8x32 board_hash_a
        u8x32 board_hash_b
        i64 last_action_ts
        u8 boards_delegated
        u8 game_bump
    }
    PLAYERBOARD {
        pubkey owner FK
        pubkey game FK
        u8x36 grid
        Shipx5 ships
        bool ships_placed
        bool all_sunk
        u8 board_bump
    }
    SESSIONAUTHORITY {
        pubkey player FK
        pubkey session_key PK
        i64 expires_at
        u8 session_bump
    }
    LEADERBOARD {
        u64 total_games_played
        Entryx10 entries
        i64 last_updated
        u8 leaderboard_bump
    }
    PLAYERPROFILE ||--o{ GAMESTATE : "1-N up to MAX_ACTIVE_GAMES 3"
    GAMESTATE ||--|{ PLAYERBOARD : "has 2 one board per player"
```

| Account | Size | PDA Seeds | Delegation | Notes |
|---|---|---|---|---|
| PlayerProfile | 58 bytes | `["profile", player]` | Never delegated | One per player, lives on L1. Tracks lifetime stats and concurrent game limit. |
| GameState | 446 bytes | `["game", player_a, game_id]` | Public TEE | Delegated to TEE validator. |
| PlayerBoard | 136 bytes | `["board", game, player]` | Private TEE | Private ACL, owner-only reads inside TEE. |
| SessionAuthority | 113 bytes | `["session", player, session_pubkey]` | Never delegated | One per player per game session. Expires after MAX_SESSION_DURATION (3600s). |
| Leaderboard | 455 bytes | `["leaderboard"]` | Never delegated | Global singleton. Updated via Magic Action on settle_game. |

Field details:
- Grid values: 0=empty, 1=ship, 2=hit_ship, 3=miss_water
- Ship: start_row, start_col, size, horizontal, hits
- LeaderboardEntry: player, wins, total_games, accuracy_bps, is_active (43 bytes each)

## Privacy Architecture

```mermaid
graph TD
    subgraph TEEBox["TEE Validator - Intel TDX"]
        TEEID["FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA"]
        BA["PlayerBoard A<br/>ACL: A only<br/>grid, ships"]
        BB["PlayerBoard B<br/>ACL: B only<br/>grid, ships"]
        FIRE["fire reads both atomically in TEE"]
        GS["GameState<br/>ACL: public<br/>board_a_hits, board_b_hits"]
        BA --> FIRE
        BB --> FIRE
        FIRE --> GS
    end
    GS -->|"Public data flows to L1<br/>hit/miss results"| L1["Solana L1"]
```

**Data visibility by role:**

| Data | Owner | Opponent | Validator | Public after settle |
|---|---|---|---|---|
| Ship positions | Yes | No | No (TEE only) | Yes |
| Hit/miss results | Yes | Yes | Yes (public GameState) | Yes |
| Board hash | Yes | Yes | Yes | Yes |
| Salt | Yes (local) | No | No | No |

**Post-game:** settle_game commits boards to L1, all data becomes public, verify_board proves hash integrity.

Three layers of privacy protection:

1. **TEE Hardware Isolation**: PlayerBoard accounts have private ACLs. Only the owner's auth token (signed by their wallet) can read the data. The TEE validator enforces this at the hardware level via Intel TDX.

2. **Same Execution Context**: All accounts (GameState, Board A, Board B) delegate to the same TEE validator. The `fire` instruction atomically reads the opponent's private board and writes the hit/miss result to the public GameState within one transaction.

3. **Commit-Reveal Verification**: Before the game starts, each player commits `SHA256(ships || salt)` to the GameState. After the game ends, anyone can call `verify_board` with the original placements and salt to prove the TEE did not modify ship positions.

## Commit-Reveal Verification Flow

```mermaid
graph LR
    subgraph Before["Before Game - Client"]
        S1["1. Generate salt<br/>32 random bytes"]
        S2["2. board_hash =<br/>SHA256 of ships + salt"]
        S3["Hash committed to<br/>GameState on L1<br/>via create_game or join_game"]
        S1 --> S2 --> S3
    end
    subgraph During["During Game - TEE"]
        S4["3. place_ships writes ships<br/>to private PlayerBoard<br/>inside TEE"]
        S5["4. fire reads boards<br/>atomically in<br/>same TEE context"]
        S4 --> S5
    end
    subgraph After["After Game - Base Layer"]
        S6["5. Boards committed<br/>to L1 by settle_game"]
        S7["6. Anyone calls<br/>verify_board with<br/>placements and salt"]
        S8["7. Recompute SHA256<br/>of placements + salt"]
        S9["8. Compare to stored<br/>hash on GameState"]
        S10{"9. Match?"}
        VALID["VALID"]
        TAMPERED["BoardTampered - error 6022"]
        S6 --> S7 --> S8 --> S9 --> S10
        S10 -->|"Yes"| VALID
        S10 -->|"No"| TAMPERED
    end
    S3 --> S4
    S5 --> S6
```

## VRF Turn Order Flow

```mermaid
graph TD
    PA["Player A<br/>seed_a 32 bytes<br/>committed at create_game"]
    PB["Player B<br/>seed_b 32 bytes<br/>committed at join_game"]
    XOR["combined = seed_a XOR seed_b<br/>neither player controls outcome"]
    REQ["request_turn_order<br/>sends combined seed to VRF Oracle<br/>Queue: Cuj97ggrh...RUXAxGh"]
    VRF["VRF Oracle generates<br/>randomness 32 bytes"]
    CB{"callback_turn_order<br/>first = byte 0 mod 2"}
    RES_A["Player A goes first"]
    RES_B["Player B goes first"]
    PA --> XOR
    PB --> XOR
    XOR --> REQ
    REQ --> VRF
    VRF --> CB
    CB -->|"first == 0"| RES_A
    CB -->|"first == 1"| RES_B
```

## Fire Instruction Flow

The fire instruction does not write to PlayerProfile. Per-shot stats are computed during `update_leaderboard` (Magic Action on settlement).

### Validation

```mermaid
graph TD
    START["attacker calls fire row, col"]
    V1{"status == Playing?"}
    V2{"attacker is a player?"}
    V3{"current_turn == attacker?"}
    V4{"row and col less than 6?"}
    V5{"target_board.owner == opponent?"}
    V6{"hits_board at idx == 0?"}
    E1["GameNotActive 6010"]
    E2["NotAPlayer 6013"]
    E3["NotYourTurn 6009"]
    E4["OutOfBounds 6007"]
    E5["WrongTarget 6012"]
    E6["AlreadyFired 6011"]
    NEXT["Proceed to hit/miss resolution"]
    START --> V1
    V1 -->|"No"| E1
    V1 -->|"Yes"| V2
    V2 -->|"No"| E2
    V2 -->|"Yes"| V3
    V3 -->|"No"| E3
    V3 -->|"Yes"| V4
    V4 -->|"No"| E4
    V4 -->|"Yes"| V5
    V5 -->|"No"| E5
    V5 -->|"Yes"| V6
    V6 -->|"No"| E6
    V6 -->|"Yes"| NEXT
```

### Hit/Miss Resolution

```mermaid
graph TD
    CHECK{"target_board.grid at idx == 1?"}
    HIT["HIT<br/>hits at idx = 2<br/>grid at idx = 2"]
    MISS["MISS<br/>hits at idx = 1<br/>grid at idx = 3"]
    FIND["find ship via ship_occupies<br/>ship.hits += 1"]
    SUNK{"ship sunk?<br/>ship.hits == ship.size"}
    DEC["ships_remaining -= 1"]
    ZERO{"ships_remaining == 0?"}
    WIN["Finished<br/>winner = attacker"]
    SWITCH["Switch turn<br/>turn_count += 1<br/>last_action_ts = now"]
    CHECK -->|"Yes - ship"| HIT
    CHECK -->|"No - water"| MISS
    HIT --> FIND
    FIND --> SUNK
    SUNK -->|"Yes"| DEC
    SUNK -->|"No"| SWITCH
    DEC --> ZERO
    ZERO -->|"Yes"| WIN
    ZERO -->|"No"| SWITCH
    MISS --> SWITCH
```

## Session Key Flow

```mermaid
sequenceDiagram
    participant P as Player
    participant BL as Base Layer
    participant TEE as TEE
    Note over P,BL: Bundled in create/join batch TX, 1 popup
    P->>BL: register_session_key
    Note right of BL: SessionAuthority PDA created<br/>seeds: session, player, session_pubkey<br/>113 bytes, expires_at = now + 3600
    Note left of P: Session keypair stored in browser memory
    P->>TEE: place_ships - session key, 0 popups
    P->>TEE: fire - session key, 0 popups
    P->>BL: claim_prize - session key, winner_wallet for SOL destination
    P->>BL: revoke_session_key - closes PDA, reclaims rent
```

Session key preservation: if a transaction fails and is retried, the existing session keypair is reused, not regenerated.

## Frontend Orchestration (TX Batching)

### Player A Flow

```mermaid
graph TD
    subgraph BATCH["Batch TX - 1 popup"]
        A1["1. ensureProfile<br/>init PlayerProfile if not exists"]
        A2["2. create_game<br/>GameState + Board A + ACL A<br/>board_hash_a + deposit buy-in"]
        A3["3. register_session_key<br/>SessionAuthority PDA, 1hr expiry"]
        A1 --> A2 --> A3
    end
    subgraph ORCH["Orchestration - session key, no popups"]
        A4["delegate_board<br/>A board to TEE"]
        A5["delegate_game_state<br/>public ACL"]
        A6["request_turn_order<br/>VRF"]
        A4 --> A5 --> A6
    end
    BATCH --> ORCH
```

### Player B Flow

```mermaid
graph TD
    subgraph BATCH2["Batch TX - 1 popup"]
        B1["1. ensureProfile<br/>init PlayerProfile if not exists"]
        B2["2. join_game<br/>Board B + ACL B + board_hash_b<br/>deposit buy-in"]
        B3["3. delegate_board<br/>B board to TEE"]
        B4["4. register_session_key<br/>SessionAuthority PDA, 1hr expiry"]
        B1 --> B2 --> B3 --> B4
    end
```

### Stale Profile Recovery

Before submitting the batch TX, the frontend checks the player's profile. If `active_games >= 3`, it runs `autoClaimTimeouts`. If zero actual games are found on-chain, it calls `reset_active_games` to zero out the counter. This prevents permanent lockout from the MAX_ACTIVE_GAMES (3) cap.

## Auto End-Game Flow

```mermaid
graph TD
    START["Game status == Finished<br/>ships_remaining == 0"]
    NONE["endGameStatus: none"]
    SETTLING["endGameStatus: settling<br/>settle_game TEE transaction<br/>CommitAndUndelegate GameState + Board A + Board B<br/>Magic Action: update_leaderboard"]
    POLL["Poll L1 for confirmation<br/>up to 90 seconds"]
    SETTLED["endGameStatus: settled"]
    CLAIMING["endGameStatus: claiming<br/>claim_prize on L1, session key signs<br/>winner_wallet for SOL, 0 wallet popups<br/>Decrements active_games, updates profiles"]
    CLAIMED["endGameStatus: claimed<br/>Winner receives pot"]
    ERROR["endGameStatus: error<br/>Manual retry available"]
    START --> NONE
    NONE -->|"auto-trigger"| SETTLING
    SETTLING --> POLL
    POLL -->|"confirmed"| SETTLED
    SETTLED -->|"auto-trigger"| CLAIMING
    CLAIMING --> CLAIMED
    SETTLING -.->|"failure"| ERROR
    POLL -.->|"timeout"| ERROR
    CLAIMING -.->|"failure"| ERROR
```

The endGameStatus values: `none`, `settling`, `settled`, `claiming`, `claimed`, `error`.

## Timeout Logic Flow

```mermaid
graph TD
    START["claim_timeout claimer"]
    V1{"claimer is a player?"}
    E1["NotAPlayer 6013"]
    V2{"elapsed > 300s?<br/>TIMEOUT_SECONDS"}
    E2["NotTimedOut 6019"]
    V3{"status?"}
    WAIT["Cancelled<br/>Refund A buy-in"]
    PLACE["TimedOut<br/>Refund both buy-in each"]
    PLAY["Determine winner<br/>timed_out = current_turn<br/>winner = other player<br/>claimer must == winner"]
    RESULT["TimedOut<br/>winner set, has_winner = true<br/>claim pot via claim_prize"]
    START --> V1
    V1 -->|"No"| E1
    V1 -->|"Yes"| V2
    V2 -->|"No"| E2
    V2 -->|"Yes"| V3
    V3 -->|"WaitingForPlayer"| WAIT
    V3 -->|"Placing"| PLACE
    V3 -->|"Playing"| PLAY
    PLAY --> RESULT
```

## Settlement Flow

settle_game commits GameState and both boards to L1 via CommitAndUndelegate. No permission CPIs. ACLs only matter within the TEE execution context. Once committed to L1, data is inherently public.

```mermaid
graph TD
    START["settle_game called on TEE"]
    V1{"status == Finished?"}
    E1["GameNotFinished 6014"]
    V2{"caller is a player?"}
    E2["NotAPlayer 6013"]
    C1["CommitAndUndelegate GameState<br/>with Magic Action handler:<br/>update_leaderboard on base layer"]
    C2["CommitAndUndelegate Board A<br/>board data written to L1"]
    C3["CommitAndUndelegate Board B<br/>board data written to L1"]
    START --> V1
    V1 -->|"No"| E1
    V1 -->|"Yes"| V2
    V2 -->|"No"| E2
    V2 -->|"Yes"| C1
    C1 --> C2
    C2 --> C3
```

## CPI Call Map

| Instruction | CPI Target | Purpose |
|---|---|---|
| `create_game` | System Program | Transfer buy-in lamports to GameState PDA |
| `create_game` | Permission Program (`ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`) | CreatePermission for Board A (private ACL) |
| `join_game` | System Program | Transfer buy-in lamports to GameState PDA |
| `join_game` | Permission Program | CreatePermission for Board B (private ACL) |
| `delegate_board` | Permission Program | DelegatePermission for player's board to TEE |
| `delegate_board` | Delegation Program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) | Delegation record + buffer + metadata |
| `delegate_game_state` | Permission Program | CreatePermission (public) + DelegatePermission for GameState |
| `delegate_game_state` | Delegation Program | Delegation record + buffer + metadata |
| `request_turn_order` | VRF Program (`Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`) | Request randomness with combined seed |
| `settle_game` | Magic Program (`Magic11111111111111111111111111111111111111`) | CommitAndUndelegate GameState + both boards |
| `settle_game` | Battleship Program (self, `9DiCaM3ugtjo1f3xoCpG7Nxij112Qc9znVfjQvT6KHRR`) | Magic Action: update_leaderboard |
| `claim_prize` | (none, direct lamport manipulation) | Transfer pot to winner |
| `cancel_game` | (none, direct lamport manipulation) | Refund buy-in to Player A |
| `claim_timeout` | (none, direct lamport manipulation) | Refund or award pot |

## Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Blockchain | Solana | devnet |
| Smart contract framework | Anchor | 0.32.1 |
| Language (program) | Rust | 1.89.0 |
| Solana runtime | solana-program | 2.2.1 |
| TEE runtime | MagicBlock Ephemeral Rollups (PER) | SDK 0.8.6 |
| Privacy | MagicBlock Private ER (Intel TDX ACLs) | via Permission Program |
| Randomness | MagicBlock VRF | SDK 0.2.3 |
| Atomic settlement | MagicBlock Magic Actions | via Magic Program |
| Price feed | MagicBlock Pricing Oracle | frontend stub |
| Frontend framework | Next.js | 16.2.2 |
| UI library | React | 19.2.4 |
| Type system | TypeScript | ^5 |
| Styling | Tailwind CSS | 4 |
| Animation | Framer Motion | ^12.38.0 |
| Wallet | Phantom (via @solana/wallet-adapter) | - |
| Hashing (client) | @noble/hashes | ^1.8.0 |
| Signing (TEE auth) | tweetnacl | ^1.0.3 |
| Solana client | @solana/web3.js | ^1.98.4 |
| Anchor client | @coral-xyz/anchor | ^0.32.1 |
| ER client | @magicblock-labs/ephemeral-rollups-sdk | ^0.10.3 |

## Design Decisions

### Fixed arrays instead of Vec

All on-chain data structures use fixed-size arrays: `ships: [Ship; 5]`, `grid: [u8; 36]`, `entries: [LeaderboardEntry; 10]`. This makes account sizes deterministic and avoids realloc issues with delegated accounts. The `#[ephemeral]` macro requires the `disable-realloc` feature.

### Oracle in frontend only

The Pricing Oracle displays SOL/USD equivalent in the game lobby. The contract deals exclusively in lamports. This avoids price-drift vulnerabilities where an Oracle price change between create_game and claim_prize could cause accounting errors.

### Single hook architecture

All game state, subscriptions, and transaction logic lives in `useGame.ts` (2040 lines). Components are pure rendering. This keeps data flow unidirectional and makes it straightforward to reason about state transitions.

### TX batching for minimal popups

Player A's entire setup (profile + game + session key) goes in one transaction, one wallet popup. Player B's setup (profile + join + delegate board + session key) also goes in one popup. After that, session keys handle all signing.

### Session keys instead of repeated wallet approvals

`register_session_key` creates a SessionAuthority PDA (113 bytes) with a 3600-second expiry. The session keypair is generated in the browser and stored in memory. `fire()`, `place_ships()`, and `claim_prize()` all use the session key. The user never sees another wallet popup after the initial setup.

### CommitAndUndelegate without permission CPIs

`settle_game` commits GameState and both boards to L1 via CommitAndUndelegate. It does not call permission CPIs to update ACLs. The private ACLs only matter within the TEE execution context. Once data is committed to L1, it is inherently public (anyone can read Solana account data).

### Per-shot stats on settlement, not per-fire

`fire()` does not write to PlayerProfile. Shot stats (total_shots_fired, total_hits) are computed and written during `update_leaderboard`, which runs as a Magic Action on the base layer during settlement. This avoids extra account lookups on every fire instruction in the TEE.

### Stale profile recovery

If a player's `active_games` count reaches the maximum (3) but they have no actual active games (games cancelled or timed out without proper cleanup), `autoClaimTimeouts` runs `reset_active_games` to reset the counter. This prevents players from getting permanently locked out.

### 17 constants

The program defines 17 constants: 6 PDA seeds (`GAME_SEED`, `BOARD_SEED`, `PROFILE_SEED`, `LEADERBOARD_SEED`, `SESSION_SEED`, `IDENTITY_SEED`), 5 account sizes (`GAME_STATE_SIZE` = 446, `PLAYER_BOARD_SIZE` = 136, `PLAYER_PROFILE_SIZE` = 58, `LEADERBOARD_SIZE` = 455, `SESSION_AUTHORITY_SIZE` = 113), 5 game rules (`TIMEOUT_SECONDS` = 300, `MIN_BUY_IN` = 1,000,000, `MAX_BUY_IN` = 100,000,000,000, `MAX_ACTIVE_GAMES` = 3, `MAX_LEADERBOARD_ENTRIES` = 10), and 1 session config (`MAX_SESSION_DURATION` = 3600).
