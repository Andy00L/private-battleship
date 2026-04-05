# Architecture

System architecture for Private Battleship. Covers account relationships, instruction flows, CPI interactions, frontend orchestration, and design decisions.

[Back to README](README.md)

## System Overview

The program runs across two execution contexts: Solana L1 (base layer) and MagicBlock's TEE (Trusted Execution Environment running Intel TDX). Accounts are created on L1, delegated to the TEE for private gameplay, then committed back to L1 for settlement.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Next.js 16.2.2)                          │
│                                                                              │
│  useGame.ts (2040 lines)                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  GameLobby   │  │  Placement   │  │   Battle     │  │   Result     │     │
│  │  create/join │  │  place_ships │  │   fire       │  │  settle/claim│     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │                  │            │
│         │     Batched TX   │   Session Key    │   Session Key    │  Session   │
│         │     (1 popup)    │   (0 popups)     │   (0 popups)     │  Key       │
├─────────┼──────────────────┼──────────────────┼──────────────────┼────────────┤
│         │                  │                  │                  │            │
│  ┌──────▼──────────────────┼──────────────────┼──────────────────┼──────┐     │
│  │          Solana Devnet (Base Layer, L1)     │                  │      │     │
│  │  create_game            │                  │                  │      │     │
│  │  join_game              │                  │                  │      │     │
│  │  delegate_board (x2)    │                  │             claim_prize  │     │
│  │  delegate_game_state    │                  │             verify_board │     │
│  │  request_turn_order     │                  │                  │      │     │
│  │  register_session_key   │                  │                  │      │     │
│  └─────────────────────────┼──────────────────┼──────────────────┼──────┘     │
│                            │                  │                  │            │
│  ┌─────────────────────────▼──────────────────▼──────────────────▼──────┐     │
│  │           TEE Validator (Intel TDX, PER)                             │     │
│  │  FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA                     │     │
│  │                                                                      │     │
│  │  place_ships  -- writes to private PlayerBoard                       │     │
│  │  fire         -- reads opponent's private board, writes public hits  │     │
│  │  settle_game  -- commits game + both boards to L1                    │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────┘
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
│           ├── sfx.ts               #  69 lines
│           ├── oracle.ts            #  25 lines
│           └── idl.json             # Anchor IDL (auto-generated)
├── Anchor.toml
├── Cargo.toml
└── rust-toolchain.toml              # Rust 1.89.0
```

Total frontend: 4334 lines across all files.

## Game Lifecycle Sequence Diagram

```
Player A                Base Layer              TEE Validator            Player B
   │                        │                        │                      │
   │-- initialize_profile ->│                        │                      │
   │                        │                        │<-- initialize_profile-│
   │                        │                        │                      │
   │-- create_game -------->│                        │                      │
   │   (+ ensureProfile     │                        │                      │
   │    + register_session) │                        │                      │
   │   [1 wallet popup]     │                        │                      │
   │                        │                        │                      │
   │                        │                        │<---- join_game ------│
   │                        │                        │   (+ ensureProfile   │
   │                        │                        │    + delegate_board  │
   │                        │                        │    + register_session│
   │                        │                        │   [1 wallet popup]   │
   │                        │                        │                      │
   │-- delegate_board ----->│-- board A to TEE ----->│                      │
   │-- delegate_game_state->│-- GameState to TEE --->│                      │
   │-- request_turn_order ->│-- VRF(seed_a^seed_b) ->│                      │
   │                        │<-- callback_turn_order-│                      │
   │                        │                        │                      │
   │------- place_ships ----------------------------------->│               │
   │   [session key, 0 popups]                       │<---- place_ships ---│
   │                        │                        │   [session key]      │
   │                        │                        │                      │
   │                        │                        │  (status -> Playing) │
   │                        │                        │                      │
   │----------- fire -------------------------------->     │               │
   │   [session key]        │                        │<-------- fire ------│
   │                        │                        │   [session key]      │
   │              ... turns repeat until winner ...   │                      │
   │                        │                        │                      │
   │------- settle_game ----------------------------------->│               │
   │                        │<-- commit game+boards -│                      │
   │                        │<-- update_leaderboard -│ (Magic Action)       │
   │                        │                        │                      │
   │-- claim_prize -------->│                        │                      │
   │   [session key]        │                        │                      │
   │                        │                        │                      │
   │-- verify_board ------->│  (anyone can call)     │                      │
```

## Account Relationships (ER Diagram)

5 account types. Fixed-size arrays throughout (no Vec).

```
┌─────────────────────────────┐
│       PlayerProfile          │     PDA: ["profile", player]
│  (58 bytes, never delegated) │     One per player, lives on L1
├─────────────────────────────┤
│  player: Pubkey              │--┐
│  active_games: u8            │  │  Tracks lifetime stats
│  total_wins: u32             │  │  and concurrent game limit
│  total_games: u32            │  │
│  total_shots_fired: u32      │  │
│  total_hits: u32             │  │
│  profile_bump: u8            │  │
└─────────────────────────────┘  │
                                  │
              ┌───────────────────┘
              │
              │  1:N (up to MAX_ACTIVE_GAMES=3)
              │
              v
┌─────────────────────────────┐       ┌─────────────────────────────┐
│        GameState             │       │      SessionAuthority        │
│  (446 bytes, public TEE)     │       │  (113 bytes, never delegated)│
├─────────────────────────────┤       ├─────────────────────────────┤
│  game_id: u64                │       │  player: Pubkey              │
│  player_a: Pubkey            │--┐    │  session_key: Pubkey         │
│  player_b: Pubkey            │--┤    │  expires_at: i64             │
│  invited_player: Pubkey      │  │    │  session_bump: u8            │
│  status: u8                  │  │    └─────────────────────────────┘
│  current_turn: Pubkey        │  │      PDA: ["session", player, session_pubkey]
│  turn_count: u16             │  │      One per player per game session
│  pot_lamports: u64           │  │      Expires after MAX_SESSION_DURATION (3600s)
│  buy_in_lamports: u64        │  │
│  board_a_hits: [u8; 36]     │  │
│  board_b_hits: [u8; 36]     │  │
│  ships_remaining_a: u8       │  │
│  ships_remaining_b: u8       │  │
│  winner: Pubkey              │  │
│  has_winner: bool            │  │
│  vrf_seed: [u8; 32]         │  │
│  seed_a: [u8; 32]           │  │
│  seed_b: [u8; 32]           │  │
│  board_hash_a: [u8; 32]     │  │
│  board_hash_b: [u8; 32]     │  │
│  last_action_ts: i64         │  │
│  boards_delegated: u8        │  │
│  game_bump: u8               │  │
└─────────────────────────────┘  │
   PDA: ["game", player_a,       │
          game_id]                │
                                  │
              ┌───────────────────┘
              │  1:2 (one board per player per game)
              v
┌─────────────────────────────┐
│       PlayerBoard            │
│  (136 bytes, private TEE)    │
├─────────────────────────────┤
│  owner: Pubkey               │
│  game: Pubkey                │--> references GameState
│  grid: [u8; 36]             │    0=empty, 1=ship, 2=hit_ship, 3=miss_water
│  ships: [Ship; 5]           │    Ship: start_row, start_col, size, horizontal, hits
│  ships_placed: bool          │
│  all_sunk: bool              │
│  board_bump: u8              │
└─────────────────────────────┘
   PDA: ["board", game, player]

┌─────────────────────────────┐
│       Leaderboard            │
│  (455 bytes, never delegated)│
├─────────────────────────────┤
│  total_games_played: u64     │    PDA: ["leaderboard"]
│  entries: [Entry; 10]        │    Global singleton
│  last_updated: i64           │    Updated via Magic Action
│  leaderboard_bump: u8        │    on settle_game
└─────────────────────────────┘
   Entry: player, wins, total_games, accuracy_bps, is_active (43 bytes each)
```

## Privacy Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           TEE Validator (Intel TDX)       │
                    │  FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs   │
                    │                                          │
                    │  ┌──────────────┐  ┌──────────────┐     │
                    │  │ PlayerBoard A │  │ PlayerBoard B │     │
                    │  │ ACL: A only   │  │ ACL: B only   │     │
                    │  │ grid, ships   │  │ grid, ships   │     │
                    │  └──────┬───────┘  └───────┬──────┘     │
                    │         │                   │            │
                    │         └─────────┬─────────┘            │
                    │                   │                       │
                    │           fire() reads both              │
                    │           atomically in TEE              │
                    │                   │                       │
                    │                   v                       │
                    │         ┌──────────────────┐             │
                    │         │   GameState       │             │
                    │         │   ACL: public     │             │
                    │         │   board_a_hits    │             │
                    │         │   board_b_hits    │             │
                    │         └──────────────────┘             │
                    └──────────────────────────────────────────┘
                                        │
                    Public data flows    │    Private data stays
                    down to L1           │    inside TEE until
                    (hit/miss results)   │    settle_game reveals
                                        v

  Player A's view:                          Player B's view:
  - Own board: sees ships                   - Own board: sees ships
  - Opponent hits: public                   - Opponent hits: public
  - Opponent ships: HIDDEN                  - Opponent ships: HIDDEN

  Validator's view:
  - GameState: public (hits, status, turns)
  - PlayerBoard A: HIDDEN (private ACL)
  - PlayerBoard B: HIDDEN (private ACL)

  Post-game:
  - settle_game commits boards to L1
  - All data becomes public
  - verify_board proves hash integrity
```

Three layers of privacy protection:

1. **TEE Hardware Isolation**: PlayerBoard accounts have private ACLs. Only the owner's auth token (signed by their wallet) can read the data. The TEE validator enforces this at the hardware level via Intel TDX.

2. **Same Execution Context**: All accounts (GameState, Board A, Board B) delegate to the same TEE validator. The `fire` instruction atomically reads the opponent's private board and writes the hit/miss result to the public GameState within one transaction.

3. **Commit-Reveal Verification**: Before the game starts, each player commits `SHA256(ships || salt)` to the GameState. After the game ends, anyone can call `verify_board` with the original placements and salt to prove the TEE did not modify ship positions.

## Commit-Reveal Verification Flow

```
    BEFORE GAME                     DURING GAME                    AFTER GAME
    (Client)                        (TEE)                          (Base Layer)

 1. Generate salt                3. place_ships writes          5. Boards committed
    (32 random bytes)               ships to private               to L1 by
                                    PlayerBoard inside             settle_game
 2. board_hash =                    TEE
    SHA256(ships || salt)                                       6. Anyone calls
                                 4. fire reads boards              verify_board(
    Hash committed to               atomically in                  placements, salt)
    GameState on L1                 same TEE context
    (create_game or                                             7. Recompute:
     join_game)                                                    SHA256(placements
                                                                   || salt)

                                                                8. Compare to
                                                                   stored hash
                                                                   on GameState

                                                                9. Match = VALID
                                                                   Mismatch =
                                                                   BoardTampered
                                                                   (error 6022)
```

## VRF Turn Order Flow

```
Player A                    Player B
    │                           │
    │  seed_a (32 bytes)        │  seed_b (32 bytes)
    │  committed at             │  committed at
    │  create_game              │  join_game
    │                           │
    └───────────┬───────────────┘
                │
                v
    combined = seed_a XOR seed_b
    (neither player controls outcome)
                │
                v
    request_turn_order
    sends combined seed to VRF Oracle
    (Queue: Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh)
                │
                v
    VRF Oracle generates
    randomness: [u8; 32]
                │
                v
    callback_turn_order
    first = randomness[0] % 2
                │
         ┌──────┴──────┐
         │              │
    first == 0     first == 1
         │              │
    Player A       Player B
    goes first     goes first
```

## Fire Instruction Flow

The fire instruction does not write to PlayerProfile. Per-shot stats are computed during `update_leaderboard` (Magic Action on settlement).

```
    attacker calls fire(row, col)
                │
                v
    ┌───────────────────────┐
    │ status == Playing?     │-- No --> GameNotActive (6010)
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ attacker is a player?  │-- No --> NotAPlayer (6013)
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ current_turn ==        │-- No --> NotYourTurn (6009)
    │ attacker?              │
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ row < 6 && col < 6?    │-- No --> OutOfBounds (6007)
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ target_board.owner ==  │-- No --> WrongTarget (6012)
    │ opponent?              │
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ hits_board[idx] == 0?  │-- No --> AlreadyFired (6011)
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ target_board.grid[idx] │
    │ == 1 (ship)?           │
    └───────┬───────┬───────┘
            │       │
       Yes (HIT)  No (MISS)
            │       │
            v       v
    hits[idx] = 2   hits[idx] = 1
    grid[idx] = 2   grid[idx] = 3
            │       │
            v       │
    find ship via   │
    ship_occupies   │
    ship.hits += 1  │
            │       │
            v       │
    ┌───────────┐   │
    │ ship sunk? │   │
    └───┬───┬───┘   │
        │   │       │
       Yes  No      │
        │   │       │
        v   └───┬───┘
    ships_      │
    remaining   │
    -= 1        │
        │       │
        v       │
    ┌────────┐  │
    │ == 0?  │  │
    └──┬──┬──┘  │
       │  │     │
      Yes No    │
       │  └──┬──┘
       v     │
    Finished │
    winner =  │
    attacker  │
              v
    Switch turn
    turn_count += 1
    last_action_ts = now
```

## Session Key Flow

```
Player                      Base Layer                    TEE
   │                            │                          │
   │  register_session_key      │                          │
   │  (bundled in create/join   │                          │
   │   batch TX, 1 popup)       │                          │
   │ ────────────────────────-->│                          │
   │                            │                          │
   │  Creates SessionAuthority  │                          │
   │  PDA: ["session",          │                          │
   │        player,             │                          │
   │        session_pubkey]     │                          │
   │  113 bytes                 │                          │
   │  expires_at = now + 3600   │                          │
   │                            │                          │
   │  Session keypair stored    │                          │
   │  in browser memory         │                          │
   │                            │                          │
   │  place_ships (signed by    │                          │
   │  session key, 0 popups)    │────────────────────────->│
   │                            │                          │
   │  fire (signed by           │                          │
   │  session key, 0 popups)    │────────────────────────->│
   │                            │                          │
   │  claim_prize (signed by    │                          │
   │  session key, winner_wallet│                          │
   │  set for SOL destination)  │                          │
   │ ────────────────────────-->│                          │
   │                            │                          │
   │  revoke_session_key        │                          │
   │  (closes PDA, reclaims     │                          │
   │   rent)                    │                          │
   │ ────────────────────────-->│                          │
```

Session key preservation: if a transaction fails and is retried, the existing session keypair is reused, not regenerated.

## Frontend Orchestration (TX Batching)

```
PLAYER A FLOW (1 wallet popup for entire game setup):

   ┌────────────────────────────────────────────┐
   │  Batch TX #1 (1 popup)                      │
   │                                             │
   │  1. ensureProfile                           │
   │     (init PlayerProfile if not exists)      │
   │                                             │
   │  2. create_game                             │
   │     (GameState + Board A + ACL A            │
   │      + board_hash_a + deposit buy-in)       │
   │                                             │
   │  3. register_session_key                    │
   │     (SessionAuthority PDA, 1hr expiry)      │
   └─────────────────┬──────────────────────────┘
                     │
                     v
   Orchestration continues with session key:
   - delegate_board (A's board to TEE)
   - delegate_game_state (public ACL)
   - request_turn_order (VRF)
   (all signed by session key or payer, no popups)

PLAYER B FLOW (1 wallet popup for entire game setup):

   ┌────────────────────────────────────────────┐
   │  Batch TX #1 (1 popup)                      │
   │                                             │
   │  1. ensureProfile                           │
   │     (init PlayerProfile if not exists)      │
   │                                             │
   │  2. join_game                               │
   │     (Board B + ACL B + board_hash_b         │
   │      + deposit buy-in)                      │
   │                                             │
   │  3. delegate_board                          │
   │     (B's board to TEE)                      │
   │                                             │
   │  4. register_session_key                    │
   │     (SessionAuthority PDA, 1hr expiry)      │
   └────────────────────────────────────────────┘
```

### Stale Profile Recovery

Before submitting the batch TX, the frontend checks the player's profile. If `active_games >= 3`, it runs `autoClaimTimeouts`. If zero actual games are found on-chain, it calls `reset_active_games` to zero out the counter. This prevents permanent lockout from the MAX_ACTIVE_GAMES (3) cap.

## Auto End-Game Flow

```
    Game status == Finished
    (ships_remaining == 0)
              │
              v
    ┌──────────────────────┐
    │ endGameStatus: none   │
    └──────────┬───────────┘
               │ auto-trigger
               v
    ┌──────────────────────┐
    │ endGameStatus:        │    settle_game on TEE:
    │ settling              │    - CommitAndUndelegate GameState
    │                       │    - CommitAndUndelegate Board A
    │ settle_game()         │    - CommitAndUndelegate Board B
    │ (TEE transaction)     │    - Magic Action: update_leaderboard
    └──────────┬───────────┘
               │
               v
    ┌──────────────────────┐
    │ Poll L1 for           │    Check base layer for committed
    │ confirmation          │    GameState every few seconds
    │ (up to 90 seconds)    │
    └──────────┬───────────┘
               │ confirmed
               v
    ┌──────────────────────┐
    │ endGameStatus:        │
    │ settled               │
    └──────────┬───────────┘
               │ auto-trigger
               v
    ┌──────────────────────┐
    │ endGameStatus:        │    claim_prize on L1:
    │ claiming              │    - Session key signs
    │                       │    - winner_wallet for SOL destination
    │ claim_prize()         │    - Decrements active_games
    │ (session key,         │    - Updates profiles
    │  0 wallet popups)     │
    └──────────┬───────────┘
               │
               v
    ┌──────────────────────┐
    │ endGameStatus:        │    Winner receives pot
    │ claimed               │    (buy_in * 2)
    └──────────────────────┘

    On any failure:
    ┌──────────────────────┐
    │ endGameStatus: error  │    User shown error message
    │                       │    Manual retry available
    └──────────────────────┘
```

The endGameStatus values: `none`, `settling`, `settled`, `claiming`, `claimed`, `error`.

## Timeout Logic Flow

```
    claim_timeout(claimer)
              │
              v
    ┌───────────────────────┐
    │ claimer is a player?   │-- No --> NotAPlayer (6013)
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ elapsed > 300s?        │-- No --> NotTimedOut (6019)
    │ (TIMEOUT_SECONDS)      │
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────────────────────┐
    │            status?                     │
    └───┬──────────┬──────────────┬─────────┘
        │          │              │
   Waiting     Placing        Playing
        │          │              │
        v          v              v
   Cancelled    TimedOut     Determine winner:
   Refund A     Refund both  timed_out = current_turn
   (buy-in)     (buy-in      winner = other player
                 each)        claimer must == winner
                              │
                              v
                           TimedOut
                           winner set
                           has_winner = true
                           (claim pot via claim_prize)
```

## Settlement Flow

settle_game commits GameState and both boards to L1 via CommitAndUndelegate. No permission CPIs. ACLs only matter within the TEE execution context. Once committed to L1, data is inherently public.

```
    settle_game (called on TEE)
              │
              v
    ┌───────────────────────┐
    │ status == Finished?    │-- No --> GameNotFinished (6014)
    └───────────┬───────────┘
                │ Yes
                v
    ┌───────────────────────┐
    │ caller is a player?    │-- No --> NotAPlayer (6013)
    └───────────┬───────────┘
                │ Yes
                v
    ┌────────────────────────────────────────────┐
    │  CommitAndUndelegate GameState              │
    │  (with Magic Action handler:               │
    │   update_leaderboard on base layer)        │
    └────────────────────┬───────────────────────┘
                         │
                         v
    ┌────────────────────────────────────────────┐
    │  CommitAndUndelegate Board A                │
    │  (board data written to L1)                 │
    └────────────────────┬───────────────────────┘
                         │
                         v
    ┌────────────────────────────────────────────┐
    │  CommitAndUndelegate Board B                │
    │  (board data written to L1)                 │
    └────────────────────────────────────────────┘
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
