# Architecture

[Back to README](README.md)

## System Overview

The program runs across two execution contexts: Solana L1 (base layer) and MagicBlock's TEE (Trusted Execution Environment running Intel TDX). Accounts are created on L1, delegated to the TEE for private gameplay, then committed back to L1 for settlement.

```mermaid
graph LR
    subgraph "Base Layer (Solana L1)"
        CREATE[create_game / join_game]
        DELEGATE[delegate_board / delegate_game_state]
        SETTLE[settle_game -> commit to L1]
        CLAIM[claim_prize / claim_timeout]
        VERIFY[verify_board]
        PROFILE[initialize_profile]
        LEADER[initialize_leaderboard]
    end

    subgraph "TEE (MagicBlock Ephemeral Rollups)"
        PLACE[place_ships]
        FIRE[fire]
        VRF_CB[callback_turn_order]
    end

    subgraph "VRF Oracle"
        VRF_REQ[request_turn_order]
        VRF_RESP[VRF randomness callback]
    end

    CREATE --> DELEGATE
    DELEGATE --> PLACE
    VRF_REQ --> VRF_RESP --> VRF_CB
    PLACE --> FIRE
    FIRE -->|all ships sunk| SETTLE
    SETTLE --> CLAIM
    SETTLE --> VERIFY
    SETTLE --> LEADER
```

## Directory Structure

```
solana-blitz-v3/
  Anchor.toml                            # Workspace config (localnet, program ID)
  Cargo.toml                             # Workspace-level Cargo config (release opts)
  rust-toolchain.toml                    # Rust 1.89.0, rustfmt + clippy
  programs/
    battleship/
      Cargo.toml                         # anchor-lang 0.32.1, ephemeral SDKs
      src/
        lib.rs                           # All 16 instructions, 4 accounts, 28 errors (1522 lines)
  app/
    package.json                         # Next.js 16.2.2, React 19.2.4
    next.config.ts                       # Minimal (no custom config)
    tsconfig.json                        # Strict, ES2017, bundler resolution, @/* alias
    postcss.config.mjs                   # @tailwindcss/postcss v4
    src/
      app/
        layout.tsx                       # Root layout, fonts (DM Sans, IBM Plex Mono)
        page.tsx                         # Phase-based routing (lobby/placing/playing/finished)
        globals.css                      # Dark theme (#070a0f), 60px grid overlay, custom scrollbar
      components/
        BattleGrid.tsx                   # 6x6 grid with framer-motion animations
        BattlePhase.tsx                  # Two grids + turn indicator + TX log
        GameLobby.tsx                    # Create/join game forms with USD display
        PlacementPhase.tsx               # Ship placement with rotation (R key)
        ResultPhase.tsx                  # Winner banner, claim prize, verify board
        TransactionLog.tsx               # Color-coded TX entries with latency
        wallet-provider.tsx              # Phantom adapter, Solana devnet
      hooks/
        useGame.ts                       # Game lifecycle + orchestration (1127 lines)
      lib/
        program.ts                       # PDA derivation, addresses, Anchor program factory
        idl.json                         # Anchor IDL (generated from anchor build)
        tee-connection.ts                # TEE auth, 240s token refresh
        board-hash.ts                    # SHA-256 commit-reveal hash
        oracle.ts                        # SOL/USD price display (stubbed)
    public/
      assets/                            # SVG icons (hit, miss, ship-1, ship-2, ship-3)
```

## Game Lifecycle

```mermaid
sequenceDiagram
    participant A as Player A
    participant L1 as Solana L1
    participant TEE as MagicBlock TEE
    participant VRF as VRF Oracle
    participant B as Player B

    Note over A,B: Phase 1: Setup (Base Layer)
    A->>L1: initialize_profile
    B->>L1: initialize_profile
    A->>L1: create_game(buy_in, seed_a, board_hash_a)
    L1-->>L1: Transfer buy-in to game PDA
    L1-->>L1: Create Board A + Permission ACL (private)
    B->>L1: join_game(seed_b, board_hash_b)
    L1-->>L1: Transfer buy-in to game PDA
    L1-->>L1: Create Board B + Permission ACL (private)

    Note over A,B: Phase 2: Delegation (Base Layer, auto-orchestrated)
    A->>L1: delegate_board (Board A to TEE)
    B->>L1: delegate_board (Board B to TEE)
    A->>VRF: request_turn_order(seed_a XOR seed_b)
    VRF-->>TEE: callback_turn_order(randomness)
    A->>L1: delegate_game_state (public ACL, requires boards_delegated == 2)

    Note over A,B: Phase 3: Battle (TEE, private execution)
    A->>TEE: place_ships([3,2,2,1,1])
    B->>TEE: place_ships([3,2,2,1,1])
    Note over TEE: Both placed: auto-transition to Playing

    loop Until all ships sunk
        A->>TEE: fire(row, col)
        TEE-->>TEE: Read opponent board (private), write hit/miss (public)
        B->>TEE: fire(row, col)
        TEE-->>TEE: Read opponent board (private), write hit/miss (public)
    end

    Note over A,B: Phase 4: Settlement (auto-triggered on Finished)
    A->>TEE: settle_game
    TEE-->>L1: Commit GameState + Magic Action (update_leaderboard)
    TEE-->>L1: Set board ACLs to public (reveal)
    TEE-->>L1: Commit + undelegate both boards

    Note over A,B: Phase 5: Post-game (Base Layer)
    A->>L1: claim_prize (winner receives pot)
    B->>L1: verify_board(placements, salt)
```

## Account Relationships

```mermaid
erDiagram
    GameState ||--o{ PlayerBoard : "has 2"
    GameState }o--|| PlayerProfile : "player_a"
    GameState }o--|| PlayerProfile : "player_b"
    GameState }o--o| Leaderboard : "updated on settle"

    GameState {
        u64 game_id
        Pubkey player_a
        Pubkey player_b
        Pubkey invited_player
        u8 status
        Pubkey current_turn
        u16 turn_count
        u64 pot_lamports
        u64 buy_in_lamports
        u8_36 board_a_hits
        u8_36 board_b_hits
        u8 ships_remaining_a
        u8 ships_remaining_b
        Pubkey winner
        bool has_winner
        u8_32 vrf_seed
        u8_32 seed_a
        u8_32 seed_b
        u8_32 board_hash_a
        u8_32 board_hash_b
        i64 last_action_ts
        u8 boards_delegated
        u8 game_bump
    }

    PlayerBoard {
        Pubkey owner
        Pubkey game
        u8_36 grid
        Ship_5 ships
        bool ships_placed
        bool all_sunk
        u8 board_bump
    }

    PlayerProfile {
        Pubkey player
        u8 active_games
        u32 total_wins
        u32 total_games
        u32 total_shots_fired
        u32 total_hits
        u8 profile_bump
    }

    Leaderboard {
        u64 total_games_played
        Entry_10 entries
        i64 last_updated
        u8 leaderboard_bump
    }
```

**Account sizes** (bytes): GameState 446, PlayerBoard 136, PlayerProfile 58, Leaderboard 455. All use fixed arrays. No `Vec` anywhere, which makes sizes predictable and avoids realloc in the TEE.

## Privacy Architecture

The TEE (Intel TDX) ensures ship positions stay hidden during gameplay. The Permission Program controls who can read delegated accounts.

```mermaid
graph TD
    subgraph "Board A (Private ACL)"
        BA_GRID["grid: ship positions"]
        BA_SHIPS["ships: coordinates + hit tracking"]
        BA_ACL["ACL members: [Player A]"]
    end

    subgraph "Board B (Private ACL)"
        BB_GRID["grid: ship positions"]
        BB_SHIPS["ships: coordinates + hit tracking"]
        BB_ACL["ACL members: [Player B]"]
    end

    subgraph "GameState (Public ACL)"
        GS_HITS_A["board_a_hits: public hit/miss results"]
        GS_HITS_B["board_b_hits: public hit/miss results"]
        GS_REMAINING["ships_remaining_a / ships_remaining_b"]
        GS_TURN["current_turn"]
    end

    FIRE[fire instruction in TEE] --> BA_GRID
    FIRE --> BB_GRID
    FIRE --> GS_HITS_A
    FIRE --> GS_HITS_B
```

The `fire` instruction runs inside the TEE. It reads the opponent's private board grid (possible because both boards are delegated to the same TEE execution context), determines hit or miss, then writes the result to the public GameState hit boards. Ship positions never leave the TEE.

After settlement, both board ACLs are updated to `members: None` (public), revealing the full game boards for verification.

## Commit-Reveal Verification

```mermaid
flowchart LR
    A1["Client: generate salt<br/>(32 random bytes)"] --> A2["SHA256(placements || salt)"]
    A2 --> A3["Commit hash in<br/>create_game / join_game"]
    A3 --> A4["Store salt in<br/>sessionStorage"]

    B1["Post-game: call<br/>verify_board(placements, salt)"] --> B2["On-chain Hasher<br/>reconstructs hash"]
    B2 --> B3{"computed == stored?"}
    B3 -->|Yes| B4["Board verified"]
    B3 -->|No| B5["BoardTampered error 6022"]
```

The hash uses `solana_program::hash::Hasher` (incremental SHA-256). Each ship placement is fed as 4 bytes `[start_row, start_col, size, horizontal]`, then the 32-byte salt. The client-side `@noble/hashes/sha256` produces identical output over the same byte sequence.

Salt and placements are persisted in `sessionStorage` keyed by `battleship:{gamePda}`. This survives page refreshes so verify_board can be called even after reconnecting.

## VRF Turn Order

Neither player can manipulate who goes first. Both contribute a 32-byte seed at game creation/join time.

```mermaid
flowchart TD
    SA["Player A: seed_a<br/>(32 bytes, committed in create_game)"]
    SB["Player B: seed_b<br/>(32 bytes, committed in join_game)"]
    SA --> XOR["combined = seed_a XOR seed_b"]
    SB --> XOR
    XOR --> VRF["VRF Oracle:<br/>request_randomness(combined)"]
    VRF --> CB["callback_turn_order(randomness)"]
    CB --> CHECK{"randomness[0] % 2"}
    CHECK -->|0| PA["Player A goes first"]
    CHECK -->|1| PB["Player B goes first"]
```

The VRF oracle (ephemeral-vrf-sdk) returns verifiable randomness. Because the combined seed requires both players' inputs, neither can predict or bias the outcome.

## Fire Instruction Flow

The core game loop. It validates 6 conditions, determines hit/miss, tracks ship damage, checks the win condition, switches turn, and updates profile stats.

```mermaid
flowchart TD
    START[fire called] --> V1{status == Playing?}
    V1 -->|No| ERR1[GameNotActive 6010]
    V1 -->|Yes| V2{attacker is player?}
    V2 -->|No| ERR2[NotAPlayer 6013]
    V2 -->|Yes| V3{attacker's turn?}
    V3 -->|No| ERR3[NotYourTurn 6009]
    V3 -->|Yes| V4{row < 6 and col < 6?}
    V4 -->|No| ERR4[OutOfBounds 6007]
    V4 -->|Yes| V5{target board is opponent's?}
    V5 -->|No| ERR5[WrongTarget 6012]
    V5 -->|Yes| V6{cell not already fired?}
    V6 -->|No| ERR6[AlreadyFired 6011]
    V6 -->|Yes| CHECK{grid cell == 1?}
    CHECK -->|Yes: HIT| HIT["hits_board[idx] = 2<br/>grid[idx] = 2"]
    CHECK -->|No: MISS| MISS["hits_board[idx] = 1<br/>grid[idx] = 3"]
    HIT --> SHIP[Find ship via ship_occupies<br/>increment ship.hits]
    SHIP --> SUNK{ship.hits == ship.size?}
    SUNK -->|Yes| DEC[Decrement ships_remaining]
    SUNK -->|No| TURN
    DEC --> WIN{remaining == 0?}
    WIN -->|Yes| FINISH[status = Finished<br/>winner = attacker<br/>has_winner = true]
    WIN -->|No| TURN
    MISS --> TURN[Switch turn<br/>increment turn_count]
    TURN --> STATS[Update attacker_profile:<br/>total_shots_fired++<br/>total_hits++ if hit]
    FINISH --> STATS
```

## Frontend Orchestration

The `useGame` hook in the frontend automatically handles the multi-step setup process. After a player creates or joins a game, the orchestration engine watches the game state and executes the next required step.

```mermaid
sequenceDiagram
    participant User as User Action
    participant Hook as useGame Hook
    participant L1 as Solana L1
    participant TEE as MagicBlock TEE

    User->>Hook: placeShips(placements)
    Hook->>Hook: Generate board hash + salt
    Hook->>Hook: Store salt in sessionStorage
    Hook->>L1: create_game / join_game TX

    Note over Hook: Orchestration begins (automatic)

    Hook->>Hook: Initialize TeeConnectionManager
    Hook->>L1: Subscribe to GameState

    Hook->>L1: delegate_board (my board)
    Note over Hook: Watch for boards_delegated == 2

    Hook->>L1: request_turn_order (VRF)
    Note over Hook: Watch for current_turn to be set

    Hook->>L1: delegate_game_state
    Note over Hook: Switch subscription from L1 to TEE

    Hook->>TEE: place_ships on TEE
    Note over Hook: Orchestration complete, phase = playing

    User->>Hook: fire(row, col)
    Hook->>TEE: fire TX

    Note over Hook: Watch for status == Finished
    Hook->>TEE: settle_game (auto-triggered)
```

The orchestration uses refs (not React state) to track which steps have been completed. Each step includes retry logic for transient network errors. If a step fails permanently, it stops and logs the error.

## Timeout Logic

Three separate branches handle different timeout scenarios. The timeout fires when `Clock::unix_timestamp - last_action_ts > 300` (5 minutes).

```mermaid
flowchart TD
    START[claim_timeout called] --> CHECK_PLAYER{caller is player_a or player_b?}
    CHECK_PLAYER -->|No| ERR1[NotAPlayer 6013]
    CHECK_PLAYER -->|Yes| CHECK_TIME{elapsed > 300s?}
    CHECK_TIME -->|No| ERR2[NotTimedOut 6019]
    CHECK_TIME -->|Yes| STATUS{game.status?}

    STATUS -->|WaitingForPlayer| BRANCH1["Cancel game<br/>Refund buy-in to player_a<br/>Decrement player_a.active_games"]

    STATUS -->|Placing| BRANCH2["Status = TimedOut<br/>Validate wallet addresses<br/>Validate opponent_profile PDA<br/>Refund buy-in to both players<br/>Decrement active_games for both"]

    STATUS -->|Playing| BRANCH3["Timed-out player = current_turn<br/>Winner = the other player<br/>Status = TimedOut<br/>has_winner = true<br/>(pot claimed via claim_prize)"]

    STATUS -->|Other| ERR3[WrongPhase 6003]
```

The Placing branch validates that `player_a_wallet` and `player_b_wallet` match `game.player_a` and `game.player_b`, and that the `opponent_profile` PDA is correct. This prevents fund misdirection.

## Settlement Flow

Settlement commits the game state from TEE back to L1 and triggers the leaderboard update as a Magic Action.

```mermaid
sequenceDiagram
    participant Caller as Player (either)
    participant TEE as TEE Execution
    participant L1 as Solana L1
    participant LB as Leaderboard

    Caller->>TEE: settle_game
    Note over TEE: Validate: status == Finished, caller is player

    TEE->>L1: MagicAction: CommitAndUndelegate GameState
    L1->>LB: update_leaderboard (Magic Action callback)
    LB-->>LB: Increment total_games_played
    LB-->>LB: Find or create winner entry

    TEE->>TEE: UpdatePermission Board A (ACL -> public)
    TEE->>TEE: UpdatePermission Board B (ACL -> public)
    TEE->>L1: CommitAndUndelegate Board A
    TEE->>L1: CommitAndUndelegate Board B

    Note over L1: All accounts back on L1, boards now public
```

The settlement makes 5 CPI calls total: 1 MagicInstructionBuilder (commit GameState + trigger leaderboard), 2 UpdatePermission (make boards public), and 2 CommitAndUndelegatePermission (commit + undelegate boards).

## CPI Call Map

The program makes 13 cross-program invocations across its instructions.

| Instruction | CPI Target | Call | Count |
|-------------|-----------|------|-------|
| `create_game` | System Program | Transfer (buy-in) | 1 |
| `create_game` | Permission Program | CreatePermission (private ACL) | 1 |
| `join_game` | System Program | Transfer (buy-in) | 1 |
| `join_game` | Permission Program | CreatePermission (private ACL) | 1 |
| `delegate_board` | Permission Program | DelegatePermission (to TEE) | 1 |
| `delegate_game_state` | Permission Program | CreatePermission (public ACL) | 1 |
| `delegate_game_state` | Permission Program | DelegatePermission (to TEE) | 1 |
| `request_turn_order` | VRF Program | RequestRandomness | 1 |
| `settle_game` | Magic Program | CommitAndUndelegate (GameState + handler) | 1 |
| `settle_game` | Permission Program | UpdatePermission (board A public) | 1 |
| `settle_game` | Permission Program | UpdatePermission (board B public) | 1 |
| `settle_game` | Permission Program | CommitAndUndelegatePermission (board A) | 1 |
| `settle_game` | Permission Program | CommitAndUndelegatePermission (board B) | 1 |

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Blockchain | Solana (Agave) | 3.1.9+ |
| Smart Contract | Anchor | 0.32.1 |
| TEE SDK | MagicBlock Ephemeral Rollups SDK | 0.8.6 (Rust) / 0.10.3 (TS) |
| VRF SDK | MagicBlock VRF SDK | 0.2.3 |
| Solana Program | solana-program | 2.2.1 |
| Rust | stable | 1.89.0 |
| Frontend | Next.js (App Router) | 16.2.2 |
| React | React | 19.2.4 |
| CSS | Tailwind CSS | 4.x |
| Animations | framer-motion | 12.38.0 |
| Hashing (client) | @noble/hashes (SHA-256) | 1.8.0 |
| TEE Auth | tweetnacl | 1.0.3 |

## Design Decisions

**Fixed arrays over Vec.** All account data uses fixed-size arrays (`[u8; 36]`, `[Ship; 5]`, `[LeaderboardEntry; 10]`). This makes account sizes predictable and avoids realloc complexity in the TEE. The tradeoff: the leaderboard caps at 10 entries with no way to grow.

**Status as u8.** `GameStatus` is stored as `u8` rather than the enum directly. This avoids borsh serialization alignment issues and makes on-chain comparisons simpler (`game.status == GameStatus::Playing as u8`).

**Separate hit boards.** `board_a_hits` and `board_b_hits` live on the public GameState rather than the private boards. This lets spectators follow the game without reading private data. The tradeoff: GameState is larger (446 bytes vs ~370 without hit boards).

**Oracle is frontend-only.** The pricing oracle converts SOL to USD for display. The contract only deals in lamports. This avoids price-drift vulnerabilities where an oracle manipulation could affect pot calculations. The tradeoff: USD display depends on a correctly configured Oracle account, which is currently stubbed.

**Commit-reveal over zero-knowledge.** ZK proofs would be heavier and more complex. Commit-reveal with TEE provides practical privacy with a simpler implementation. The tradeoff: you trust the TEE during gameplay, but `verify_board` proves integrity after the fact. If the TEE were compromised during play, the damage would be limited to that game; the hash proof catches it.

**Orchestration via refs, not state.** The `useGame` hook tracks delegation/VRF/placement progress with React refs rather than state. This avoids re-render cascades during the multi-step setup and prevents stale closure bugs in the subscription callbacks. The tradeoff: the orchestration state isn't visible in React DevTools.

**Session persistence for commit-reveal.** Salt and placements are stored in `sessionStorage` keyed by game PDA. This ensures `verify_board` works even after a page refresh mid-game. The data is cleaned up after successful verification. The tradeoff: `sessionStorage` is per-tab, so opening the same game in two tabs would not share the salt.

[Back to README](README.md)
