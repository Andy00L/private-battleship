# Architecture

[Back to README](README.md)

## System Overview

The program runs across two execution contexts: Solana L1 (base layer) and MagicBlock's TEE (Trusted Execution Environment). Accounts are created on L1, delegated to the TEE for private gameplay, then committed back to L1 for settlement.

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
battleship/
  Anchor.toml                          # Workspace config (localnet, program ID)
  Cargo.toml                           # Workspace-level Cargo config
  rust-toolchain.toml                  # Rust 1.89.0
  programs/
    battleship/
      Cargo.toml                       # anchor-lang 0.32.1, SDK deps
      src/
        lib.rs                         # All 16 instructions, 4 accounts, 27 errors (1469 lines)
  app/
    package.json                       # Next.js 16.2.2, React 19.2.4
    src/
      app/
        layout.tsx                     # Root layout, fonts, WalletProvider
        page.tsx                       # Phase-based routing
        globals.css                    # Dark theme (#070a0f), grid pattern
      components/
        BattleGrid.tsx                 # 6x6 grid with motion animations
        BattlePhase.tsx                # Two grids + turn indicator + TX log
        GameLobby.tsx                  # Create/join game forms
        PlacementPhase.tsx             # Ship placement with rotation
        ResultPhase.tsx                # Winner banner, claim, verify
        TransactionLog.tsx             # Color-coded TX entries
        wallet-provider.tsx            # Phantom adapter, devnet
      hooks/
        useGame.ts                     # Game lifecycle state machine
      lib/
        tee-connection.ts              # TEE auth with 240s refresh
        board-hash.ts                  # SHA-256 commit-reveal hash
        oracle.ts                      # SOL/USD price display
  tests/
    battleship.ts                      # Anchor test file (scaffold)
  migrations/
    deploy.ts                          # Deploy script (scaffold)
```

## Game Lifecycle

```mermaid
sequenceDiagram
    participant A as Player A
    participant L1 as Solana L1
    participant TEE as MagicBlock TEE
    participant VRF as VRF Oracle
    participant B as Player B

    Note over A,B: Phase 1 - Setup (Base Layer)
    A->>L1: initialize_profile
    B->>L1: initialize_profile
    A->>L1: create_game(buy_in, seed_a, board_hash_a)
    L1-->>L1: Transfer buy-in to game PDA
    L1-->>L1: Create Board A + Permission ACL
    B->>L1: join_game(seed_b, board_hash_b)
    L1-->>L1: Transfer buy-in to game PDA
    L1-->>L1: Create Board B + Permission ACL

    Note over A,B: Phase 2 - Delegation (Base Layer)
    A->>L1: delegate_board (Board A to TEE)
    B->>L1: delegate_board (Board B to TEE)
    A->>L1: delegate_game_state (GameState to TEE, public ACL)
    A->>VRF: request_turn_order
    VRF-->>TEE: callback_turn_order(randomness)

    Note over A,B: Phase 3 - Battle (TEE)
    A->>TEE: place_ships([3,2,2,1,1])
    B->>TEE: place_ships([3,2,2,1,1])
    Note over TEE: Auto-transition to Playing

    loop Until all ships sunk
        A->>TEE: fire(row, col)
        TEE-->>TEE: Check hit/miss, update boards
        B->>TEE: fire(row, col)
        TEE-->>TEE: Check hit/miss, update boards
    end

    Note over A,B: Phase 4 - Settlement
    A->>TEE: settle_game
    TEE-->>L1: Commit GameState + update_leaderboard
    TEE-->>L1: Reveal boards (ACL -> public)
    TEE-->>L1: Undelegate all accounts
    A->>L1: claim_prize
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
        u8 status
        Pubkey current_turn
        u64 pot_lamports
        u64 buy_in_lamports
        bytes36 board_a_hits
        bytes36 board_b_hits
        u8 ships_remaining_a
        u8 ships_remaining_b
        Pubkey winner
        bool has_winner
        bytes32 board_hash_a
        bytes32 board_hash_b
    }

    PlayerBoard {
        Pubkey owner
        Pubkey game
        bytes36 grid
        Ship5 ships
        bool ships_placed
        bool all_sunk
    }

    PlayerProfile {
        Pubkey player
        u8 active_games
        u32 total_wins
        u32 total_games
        u32 total_shots_fired
        u32 total_hits
    }

    Leaderboard {
        u64 total_games_played
        Entry10 entries
        i64 last_updated
    }
```

## Privacy Architecture

The TEE (Intel TDX) ensures ship positions stay hidden during gameplay. The Permission Program controls who can read delegated accounts.

```mermaid
graph TD
    subgraph "Board A (Private)"
        BA_GRID["grid: [0,1,1,1,0,0,...] (ship positions)"]
        BA_SHIPS["ships: [Ship x 5] (coordinates)"]
        BA_ACL["ACL: Player A only"]
    end

    subgraph "Board B (Private)"
        BB_GRID["grid: [0,0,1,1,0,0,...] (ship positions)"]
        BB_SHIPS["ships: [Ship x 5] (coordinates)"]
        BB_ACL["ACL: Player B only"]
    end

    subgraph "GameState (Public)"
        GS_HITS_A["board_a_hits: [0,0,2,0,1,...] (public results)"]
        GS_HITS_B["board_b_hits: [0,1,0,2,0,...] (public results)"]
        GS_REMAINING["ships_remaining_a/b"]
        GS_TURN["current_turn"]
    end

    FIRE[fire instruction] --> BA_GRID
    FIRE --> BB_GRID
    FIRE --> GS_HITS_A
    FIRE --> GS_HITS_B
```

The `fire` instruction runs inside the TEE. It reads the opponent's private board grid (only possible because both boards are delegated to the same TEE execution context), determines hit or miss, then writes the result to the public GameState hit boards. The actual ship positions never leave the TEE.

## Commit-Reveal Verification

```mermaid
flowchart LR
    A1["Client: generate salt (32 bytes)"] --> A2["SHA256(placements || salt)"]
    A2 --> A3["Commit hash in create_game/join_game"]
    A3 --> A4["Store salt locally"]

    B1["Post-game: call verify_board"] --> B2["On-chain Hasher reconstructs hash"]
    B2 --> B3{"hash == stored hash?"}
    B3 -->|Yes| B4["Board verified"]
    B3 -->|No| B5["BoardTampered error (6022)"]
```

The hash uses `solana_program::hash::Hasher` (incremental SHA-256). Each ship placement is fed as 4 bytes `[start_row, start_col, size, horizontal]`, then the 32-byte salt. The client-side `@noble/hashes/sha256` produces identical output over the same byte sequence.

## VRF Turn Order

Neither player can manipulate who goes first. Both contribute a 32-byte seed at game creation/join time. The combined seed is `seed_a XOR seed_b`, which is passed to the VRF oracle. The oracle returns 32 bytes of randomness. `randomness[0] % 2` determines the first player (0 = player A, 1 = player B).

## Fire Instruction Flow

The most complex single instruction. It validates 6 conditions, determines hit/miss, tracks ship damage, checks win condition, switches turn, and updates profile stats.

```mermaid
flowchart TD
    START[fire called] --> V1{status == Playing?}
    V1 -->|No| ERR1[GameNotActive]
    V1 -->|Yes| V2{attacker is player?}
    V2 -->|No| ERR2[NotAPlayer]
    V2 -->|Yes| V3{attacker's turn?}
    V3 -->|No| ERR3[NotYourTurn]
    V3 -->|Yes| V4{row < 6 and col < 6?}
    V4 -->|No| ERR4[OutOfBounds]
    V4 -->|Yes| V5{target board is opponent's?}
    V5 -->|No| ERR5[WrongTarget]
    V5 -->|Yes| V6{cell not already fired?}
    V6 -->|No| ERR6[AlreadyFired]
    V6 -->|Yes| CHECK{grid cell == 1?}
    CHECK -->|Yes HIT| HIT[hits_board = 2, grid = 2]
    CHECK -->|No MISS| MISS[hits_board = 1, grid = 3]
    HIT --> SHIP[Find ship, increment hits]
    SHIP --> SUNK{ship.hits == ship.size?}
    SUNK -->|Yes| DEC[Decrement ships_remaining]
    SUNK -->|No| TURN
    DEC --> WIN{remaining == 0?}
    WIN -->|Yes| FINISH[status = Finished, set winner]
    WIN -->|No| TURN
    MISS --> TURN[Switch turn, increment turn_count]
    TURN --> STATS[Update attacker_profile stats]
    FINISH --> STATS
```

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Blockchain | Solana (Agave) | 3.1.9 |
| Smart Contract | Anchor | 0.32.1 |
| TEE | MagicBlock Ephemeral Rollups SDK | 0.8.6 |
| VRF | MagicBlock VRF SDK | 0.2.3 |
| Rust | stable | 1.89.0 |
| Platform Tools | SBF | v1.52 |
| Frontend | Next.js (App Router) | 16.2.2 |
| React | React | 19.2.4 |
| CSS | Tailwind CSS | 4.x |
| Animations | framer-motion | 12.x |
| Hashing | @noble/hashes (SHA-256) | 2.x |

## Design Decisions

**Fixed arrays over Vec.** All account data uses fixed-size arrays (`[u8; 36]`, `[Ship; 5]`, `[LeaderboardEntry; 10]`) instead of Vec. This makes account sizes predictable and avoids realloc complexity in the TEE.

**Status as u8.** GameStatus is stored as `u8` rather than the enum directly. This avoids borsh serialization alignment issues and makes on-chain comparisons simpler.

**Separate hit boards.** `board_a_hits` and `board_b_hits` live on the public GameState rather than the private boards. This lets spectators follow the game without reading private data.

**Oracle is frontend-only.** The pricing oracle converts SOL amounts to USD for display. The contract only deals in lamports. This avoids price-drift vulnerabilities where an oracle manipulation could affect pot calculations.

**commit-reveal over zero-knowledge.** ZK proofs would be heavier. Commit-reveal with TEE provides practical privacy with a simpler implementation. The tradeoff: you trust the TEE during gameplay, but can verify after the fact.

[Back to README](README.md)
