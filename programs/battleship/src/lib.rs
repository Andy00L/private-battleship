use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{action, commit, ephemeral};
use ephemeral_rollups_sdk::access_control::instructions::{
    CommitAndUndelegatePermissionCpiBuilder, CreatePermissionCpiBuilder,
    DelegatePermissionCpiBuilder, UpdatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{
    Member, MembersArgs, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
#[allow(deprecated)]
use ephemeral_rollups_sdk::ephem::{
    CallHandler, CommitAndUndelegate, CommitType, MagicAction, MagicInstructionBuilder,
    UndelegateType,
};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

declare_id!("9DiCaM3ugtjo1f3xoCpG7Nxij112Qc9znVfjQvT6KHRR");

// ── Seeds ──────────────────────────────────────────────────────────────────────

pub const GAME_SEED: &[u8] = b"game";
pub const BOARD_SEED: &[u8] = b"board";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const LEADERBOARD_SEED: &[u8] = b"leaderboard";

// ── Game constants ─────────────────────────────────────────────────────────────

pub const TIMEOUT_SECONDS: i64 = 300; // 5 minutes
pub const MIN_BUY_IN: u64 = 1_000_000; // 0.001 SOL
pub const MAX_BUY_IN: u64 = 100_000_000_000; // 100 SOL
pub const MAX_ACTIVE_GAMES: u8 = 3;
pub const MAX_LEADERBOARD_ENTRIES: usize = 10;

// ── Account sizes ──────────────────────────────────────────────────────────────
// Each includes the 8-byte discriminator.

// 8 + 8 + 32 + 32 + 32 + 1 + 32 + 2 + 8 + 8
//   + 36 + 36 + 1 + 1 + 32 + 1 + 32 + 32 + 32 + 32 + 32 + 8 + 1 + 1
// = 8 + 438 = 446
pub const GAME_STATE_SIZE: usize = 446;

// 8 + 32 + 32 + 36 + (5 * 5) + 1 + 1 + 1 = 136
pub const PLAYER_BOARD_SIZE: usize = 136;

// 8 + 32 + 1 + 4 + 4 + 4 + 4 + 1 = 58
pub const PLAYER_PROFILE_SIZE: usize = 58;

// 8 + 8 + (10 * 43) + 8 + 1 = 455
pub const LEADERBOARD_SIZE: usize = 455;

// ── Enums ──────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    WaitingForPlayer, // Player A created, waiting for B
    Placing,          // Both joined, placing ships
    Playing,          // Ships placed, battle active
    Finished,         // Winner determined
    Cancelled,        // Cancelled before start
    TimedOut,         // One player timed out
}

// ── Error codes (6000–6026) ────────────────────────────────────────────────────

#[error_code]
pub enum BattleshipError {
    #[msg("Game is full")]
    GameFull, // 6000
    #[msg("You are not invited to this game")]
    NotInvited, // 6001
    #[msg("Not your board")]
    NotYourBoard, // 6002
    #[msg("Wrong game phase for this action")]
    WrongPhase, // 6003
    #[msg("Ships already placed")]
    AlreadyPlaced, // 6004
    #[msg("Must place exactly 5 ships")]
    InvalidShipCount, // 6005
    #[msg("Ship sizes must be [3, 2, 2, 1, 1]")]
    InvalidShipSizes, // 6006
    #[msg("Ship placement out of bounds")]
    OutOfBounds, // 6007
    #[msg("Ships overlap")]
    ShipsOverlap, // 6008
    #[msg("Not your turn")]
    NotYourTurn, // 6009
    #[msg("Game is not active")]
    GameNotActive, // 6010
    #[msg("Already fired at this cell")]
    AlreadyFired, // 6011
    #[msg("Target board does not belong to your opponent")]
    WrongTarget, // 6012
    #[msg("You are not a player in this game")]
    NotAPlayer, // 6013
    #[msg("Game is not finished")]
    GameNotFinished, // 6014
    #[msg("You are not the winner")]
    NotWinner, // 6015
    #[msg("Buy-in below minimum")]
    BuyInTooLow, // 6016
    #[msg("Buy-in above maximum")]
    BuyInTooHigh, // 6017
    #[msg("Cannot cancel: game already started")]
    CannotCancel, // 6018
    #[msg("Timeout period has not elapsed")]
    NotTimedOut, // 6019
    #[msg("Too many active games")]
    TooManyGames, // 6020
    #[msg("Board hash already committed")]
    HashAlreadySet, // 6021
    #[msg("Board hash does not match revealed placement")]
    BoardTampered, // 6022
    #[msg("Hash not yet committed")]
    HashNotCommitted, // 6023
    #[msg("Not player A")]
    NotPlayerA, // 6024
    #[msg("Boards not fully delegated")]
    BoardsNotDelegated, // 6025
    #[msg("Integer overflow")]
    Overflow, // 6026
    #[msg("Opponent profile does not match the other player")]
    InvalidOpponentProfile, // 6027
}

// ── Structs ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Ship {
    pub start_row: u8,
    pub start_col: u8,
    pub size: u8,
    pub horizontal: u8, // 0=vertical, 1=horizontal
    pub hits: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ShipPlacement {
    pub start_row: u8,
    pub start_col: u8,
    pub size: u8,
    pub horizontal: bool,
}

// ── Account structs ────────────────────────────────────────────────────────────

#[account]
pub struct GameState {
    pub game_id: u64,
    pub player_a: Pubkey,
    pub player_b: Pubkey,           // Pubkey::default() until joined
    pub invited_player: Pubkey,     // Pubkey::default() = open lobby
    pub status: u8,                 // GameStatus as u8
    pub current_turn: Pubkey,
    pub turn_count: u16,
    pub pot_lamports: u64,
    pub buy_in_lamports: u64,
    pub board_a_hits: [u8; 36],
    pub board_b_hits: [u8; 36],
    pub ships_remaining_a: u8,
    pub ships_remaining_b: u8,
    pub winner: Pubkey,             // Pubkey::default() = no winner yet
    pub has_winner: bool,
    pub vrf_seed: [u8; 32],
    pub seed_a: [u8; 32],          // Player A's VRF contribution
    pub seed_b: [u8; 32],          // Player B's VRF contribution
    pub board_hash_a: [u8; 32],    // SHA256(ships_a || salt_a)
    pub board_hash_b: [u8; 32],    // SHA256(ships_b || salt_b)
    pub last_action_ts: i64,       // Clock timestamp of last action
    pub boards_delegated: u8,      // 0, 1, or 2
    pub game_bump: u8,
}

#[account]
pub struct PlayerBoard {
    pub owner: Pubkey,
    pub game: Pubkey,              // reference back to GameState
    pub grid: [u8; 36],           // 0=empty, 1=ship, 2=hit_ship, 3=miss_water
    pub ships: [Ship; 5],         // fixed array, always 5 ships
    pub ships_placed: bool,
    pub all_sunk: bool,
    pub board_bump: u8,
}

#[account]
pub struct PlayerProfile {
    pub player: Pubkey,
    pub active_games: u8,
    pub total_wins: u32,
    pub total_games: u32,
    pub total_shots_fired: u32,
    pub total_hits: u32,
    pub profile_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LeaderboardEntry {
    pub player: Pubkey,
    pub wins: u32,
    pub total_games: u32,
    pub accuracy_bps: u16,         // basis points: 5000 = 50%
    pub is_active: bool,
}

#[account]
pub struct Leaderboard {
    pub total_games_played: u64,
    pub entries: [LeaderboardEntry; 10],
    pub last_updated: i64,
    pub leaderboard_bump: u8,
}

// ── Program ────────────────────────────────────────────────────────────────────

#[ephemeral]
#[program]
pub mod battleship {
    use super::*;

    // ── 1. initialize_profile ──────────────────────────────────────────────

    pub fn initialize_profile(ctx: Context<InitializeProfile>) -> Result<()> {
        let profile = &mut ctx.accounts.player_profile;
        profile.player = ctx.accounts.player.key();
        profile.active_games = 0;
        profile.total_wins = 0;
        profile.total_games = 0;
        profile.total_shots_fired = 0;
        profile.total_hits = 0;
        profile.profile_bump = ctx.bumps.player_profile;
        Ok(())
    }

    // ── 2. initialize_leaderboard ──────────────────────────────────────────

    pub fn initialize_leaderboard(ctx: Context<InitializeLeaderboard>) -> Result<()> {
        let lb = &mut ctx.accounts.leaderboard;
        lb.total_games_played = 0;
        lb.entries = [LeaderboardEntry::default(); MAX_LEADERBOARD_ENTRIES];
        lb.last_updated = Clock::get()?.unix_timestamp;
        lb.leaderboard_bump = ctx.bumps.leaderboard;
        Ok(())
    }

    // ── 3. create_game ─────────────────────────────────────────────────────

    pub fn create_game(
        ctx: Context<CreateGame>,
        game_id: u64,
        buy_in_lamports: u64,
        invited_player: Pubkey,
        seed_a: [u8; 32],
        board_hash_a: [u8; 32],
    ) -> Result<()> {
        // Validate buy-in
        require!(buy_in_lamports >= MIN_BUY_IN, BattleshipError::BuyInTooLow);
        require!(buy_in_lamports <= MAX_BUY_IN, BattleshipError::BuyInTooHigh);

        // Check concurrent game limit
        let profile = &mut ctx.accounts.player_profile;
        require!(
            profile.active_games < MAX_ACTIVE_GAMES,
            BattleshipError::TooManyGames
        );
        profile.active_games += 1;

        // Capture keys/bumps before mutable borrows
        let game_key = ctx.accounts.game.key();
        let player_a_key = ctx.accounts.player_a.key();
        let game_bump = ctx.bumps.game;
        let board_bump = ctx.bumps.player_board_a;

        // Capture AccountInfos for CPI (before mutable borrows)
        let game_account_info = ctx.accounts.game.to_account_info();
        let board_account_info = ctx.accounts.player_board_a.to_account_info();

        // Initialize GameState (all 23 fields)
        let game = &mut ctx.accounts.game;
        game.game_id = game_id;                                    // 1
        game.player_a = player_a_key;                              // 2
        game.player_b = Pubkey::default();                         // 3
        game.invited_player = invited_player;                      // 4
        game.status = GameStatus::WaitingForPlayer as u8;          // 5
        game.current_turn = Pubkey::default();                     // 6
        game.turn_count = 0;                                       // 7
        game.buy_in_lamports = buy_in_lamports;                    // 8
        game.pot_lamports = buy_in_lamports;                       // 9
        game.board_a_hits = [0u8; 36];                             // 10
        game.board_b_hits = [0u8; 36];                             // 11
        game.ships_remaining_a = 5;                                // 12
        game.ships_remaining_b = 5;                                // 13
        game.winner = Pubkey::default();                           // 14
        game.has_winner = false;                                   // 15
        game.vrf_seed = [0u8; 32];                                 // 16
        game.seed_a = seed_a;                                      // 17
        game.seed_b = [0u8; 32];                                   // 18
        game.board_hash_a = board_hash_a;                          // 19
        game.board_hash_b = [0u8; 32];                             // 20
        game.last_action_ts = Clock::get()?.unix_timestamp;        // 21
        game.boards_delegated = 0;                                 // 22
        game.game_bump = game_bump;                                // 23

        // Initialize Player A's board
        let board = &mut ctx.accounts.player_board_a;
        board.owner = player_a_key;
        board.game = game_key;
        board.grid = [0u8; 36];
        board.ships = [Ship::default(); 5];
        board.ships_placed = false;
        board.all_sunk = false;
        board.board_bump = board_bump;

        // Transfer buy-in from Player A to game PDA
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.player_a.to_account_info(),
                    to: game_account_info,
                },
            ),
            buy_in_lamports,
        )?;

        // Create permission ACL for Player A's board (private: only A can read)
        let members_a = Some(vec![Member {
            flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG,
            pubkey: player_a_key,
        }]);

        CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .permissioned_account(&board_account_info)
            .permission(&ctx.accounts.permission_a)
            .payer(&ctx.accounts.player_a)
            .system_program(&ctx.accounts.system_program)
            .args(MembersArgs { members: members_a })
            .invoke_signed(&[&[
                BOARD_SEED,
                game_key.as_ref(),
                player_a_key.as_ref(),
                &[board_bump],
            ]])?;

        Ok(())
    }

    // ── 4. join_game ───────────────────────────────────────────────────────

    pub fn join_game(
        ctx: Context<JoinGame>,
        seed_b: [u8; 32],
        board_hash_b: [u8; 32],
    ) -> Result<()> {
        let player_b_key = ctx.accounts.player_b.key();
        let game_key = ctx.accounts.game.key();
        let board_bump = ctx.bumps.player_board_b;

        // Capture AccountInfos for CPI before mutable borrows
        let game_account_info = ctx.accounts.game.to_account_info();
        let board_account_info = ctx.accounts.player_board_b.to_account_info();

        let game = &mut ctx.accounts.game;

        // Validate game state
        require!(
            game.status == GameStatus::WaitingForPlayer as u8,
            BattleshipError::GameFull
        );

        // Validate invitation (if set)
        if game.invited_player != Pubkey::default() {
            require!(
                player_b_key == game.invited_player,
                BattleshipError::NotInvited
            );
        }

        // Cannot join your own game
        require!(player_b_key != game.player_a, BattleshipError::NotAPlayer);

        // Check concurrent game limit
        let profile = &mut ctx.accounts.player_profile;
        require!(
            profile.active_games < MAX_ACTIVE_GAMES,
            BattleshipError::TooManyGames
        );
        profile.active_games += 1;

        // Update game state
        let buy_in = game.buy_in_lamports;
        game.player_b = player_b_key;
        game.seed_b = seed_b;
        game.board_hash_b = board_hash_b;
        game.status = GameStatus::Placing as u8;
        game.pot_lamports = game
            .buy_in_lamports
            .checked_mul(2)
            .ok_or(BattleshipError::Overflow)?;
        game.last_action_ts = Clock::get()?.unix_timestamp;

        // Initialize Player B's board
        let board = &mut ctx.accounts.player_board_b;
        board.owner = player_b_key;
        board.game = game_key;
        board.grid = [0u8; 36];
        board.ships = [Ship::default(); 5];
        board.ships_placed = false;
        board.all_sunk = false;
        board.board_bump = board_bump;

        // Transfer buy-in from Player B (exact match required)
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.player_b.to_account_info(),
                    to: game_account_info,
                },
            ),
            buy_in,
        )?;

        // Create permission ACL for Player B's board (private: only B can read)
        let members_b = Some(vec![Member {
            flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG,
            pubkey: player_b_key,
        }]);

        CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .permissioned_account(&board_account_info)
            .permission(&ctx.accounts.permission_b)
            .payer(&ctx.accounts.player_b)
            .system_program(&ctx.accounts.system_program)
            .args(MembersArgs { members: members_b })
            .invoke_signed(&[&[
                BOARD_SEED,
                game_key.as_ref(),
                player_b_key.as_ref(),
                &[board_bump],
            ]])?;

        Ok(())
    }

    // ── 5. cancel_game ─────────────────────────────────────────────────────

    pub fn cancel_game(ctx: Context<CancelGame>) -> Result<()> {
        let game = &mut ctx.accounts.game;

        require!(
            game.status == GameStatus::WaitingForPlayer as u8,
            BattleshipError::CannotCancel,
        );
        require!(
            ctx.accounts.player_a.key() == game.player_a,
            BattleshipError::NotPlayerA,
        );

        game.status = GameStatus::Cancelled as u8;

        // Refund buy-in from game PDA to Player A
        let lamports = game.buy_in_lamports;
        **game.to_account_info().try_borrow_mut_lamports()? -= lamports;
        **ctx.accounts.player_a.try_borrow_mut_lamports()? += lamports;

        // Decrement active games
        let profile = &mut ctx.accounts.player_profile;
        profile.active_games = profile.active_games.saturating_sub(1);

        Ok(())
    }

    // ── 6. delegate_board ──────────────────────────────────────────────────

    pub fn delegate_board(ctx: Context<DelegateBoard>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let player = ctx.accounts.player.key();

        require!(
            player == game.player_a || player == game.player_b,
            BattleshipError::NotAPlayer,
        );
        require!(
            game.status == GameStatus::Placing as u8,
            BattleshipError::WrongPhase,
        );
        require!(
            game.boards_delegated < 2,
            BattleshipError::BoardsNotDelegated,
        );

        // Delegate permission to TEE validator
        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .payer(&ctx.accounts.player)
            .authority(&ctx.accounts.player, true)
            .permissioned_account(&ctx.accounts.player_board.to_account_info(), false)
            .permission(&ctx.accounts.permission)
            .system_program(&ctx.accounts.system_program)
            .owner_program(&ctx.accounts.owner_program)
            .delegation_buffer(&ctx.accounts.delegation_buffer)
            .delegation_record(&ctx.accounts.delegation_record)
            .delegation_metadata(&ctx.accounts.delegation_metadata)
            .delegation_program(&ctx.accounts.delegation_program)
            .validator(Some(&ctx.accounts.tee_validator))
            .invoke_signed(&[&[
                BOARD_SEED,
                game.key().as_ref(),
                player.as_ref(),
                &[ctx.accounts.player_board.board_bump],
            ]])?;

        game.boards_delegated += 1;
        game.last_action_ts = Clock::get()?.unix_timestamp;

        Ok(())
    }

    // ── 7. delegate_game_state ─────────────────────────────────────────────

    pub fn delegate_game_state(ctx: Context<DelegateGameState>) -> Result<()> {
        let game = &ctx.accounts.game;

        require!(
            game.status == GameStatus::Placing as u8,
            BattleshipError::WrongPhase,
        );
        require!(
            game.boards_delegated == 2,
            BattleshipError::BoardsNotDelegated,
        );

        // Create public permission for GameState (members: None = public)
        CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .permissioned_account(&ctx.accounts.game.to_account_info())
            .permission(&ctx.accounts.game_permission)
            .payer(&ctx.accounts.payer)
            .system_program(&ctx.accounts.system_program)
            .args(MembersArgs { members: None })
            .invoke_signed(&[&[
                GAME_SEED,
                game.player_a.as_ref(),
                &game.game_id.to_le_bytes(),
                &[game.game_bump],
            ]])?;

        // Delegate GameState to TEE validator
        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .payer(&ctx.accounts.payer)
            .authority(&ctx.accounts.payer, false)
            .permissioned_account(&ctx.accounts.game.to_account_info(), true)
            .permission(&ctx.accounts.game_permission)
            .system_program(&ctx.accounts.system_program)
            .owner_program(&ctx.accounts.owner_program)
            .delegation_buffer(&ctx.accounts.delegation_buffer)
            .delegation_record(&ctx.accounts.delegation_record)
            .delegation_metadata(&ctx.accounts.delegation_metadata)
            .delegation_program(&ctx.accounts.delegation_program)
            .validator(Some(&ctx.accounts.tee_validator))
            .invoke_signed(&[&[
                GAME_SEED,
                game.player_a.as_ref(),
                &game.game_id.to_le_bytes(),
                &[game.game_bump],
            ]])?;

        Ok(())
    }

    // ── 8. request_turn_order (VRF) ────────────────────────────────────────

    pub fn request_turn_order(ctx: Context<RequestTurnOrder>) -> Result<()> {
        let game = &ctx.accounts.game;

        // Combine both players' seeds via XOR
        let mut combined_seed = [0u8; 32];
        for i in 0..32 {
            combined_seed[i] = game.seed_a[i] ^ game.seed_b[i];
        }

        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: crate::ID,
            callback_discriminator: instruction::CallbackTurnOrder::DISCRIMINATOR.to_vec(),
            caller_seed: combined_seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.game.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });

        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;

        Ok(())
    }

    // ── 8b. callback_turn_order (VRF callback) ─────────────────────────────

    pub fn callback_turn_order(
        ctx: Context<CallbackTurnOrderCtx>,
        randomness: [u8; 32],
    ) -> Result<()> {
        let game = &mut ctx.accounts.game;
        game.vrf_seed = randomness;

        let first = randomness[0] % 2;
        game.current_turn = if first == 0 {
            game.player_a
        } else {
            game.player_b
        };

        Ok(())
    }

    // ── 9. place_ships (TEE) ───────────────────────────────────────────────

    pub fn place_ships(ctx: Context<PlaceShips>, placements: Vec<ShipPlacement>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let board = &mut ctx.accounts.player_board;
        let player = ctx.accounts.player.key();

        // Guard 1: correct phase
        require!(
            game.status == GameStatus::Placing as u8,
            BattleshipError::WrongPhase
        );

        // Guard 2: board belongs to caller
        require!(board.owner == player, BattleshipError::NotYourBoard);

        // Guard 3: not already placed
        require!(!board.ships_placed, BattleshipError::AlreadyPlaced);

        // Guard 4: caller is a player in this game
        require!(
            player == game.player_a || player == game.player_b,
            BattleshipError::NotAPlayer,
        );

        // Validate exactly 5 ships
        require!(placements.len() == 5, BattleshipError::InvalidShipCount);

        // Validate ship sizes are [3, 2, 2, 1, 1]
        let mut sizes: Vec<u8> = placements.iter().map(|p| p.size).collect();
        sizes.sort();
        require!(
            sizes == vec![1, 1, 2, 2, 3],
            BattleshipError::InvalidShipSizes
        );

        // Validate no overlap, no out-of-bounds on 6x6 grid
        let mut grid = [0u8; 36];
        let mut ships = [Ship::default(); 5];

        for (idx, placement) in placements.iter().enumerate() {
            for i in 0..placement.size {
                let (r, c) = if placement.horizontal {
                    (
                        placement.start_row,
                        placement.start_col.checked_add(i).ok_or(BattleshipError::OutOfBounds)?,
                    )
                } else {
                    (
                        placement.start_row.checked_add(i).ok_or(BattleshipError::OutOfBounds)?,
                        placement.start_col,
                    )
                };
                require!(r < 6 && c < 6, BattleshipError::OutOfBounds);
                let cell = (r as usize) * 6 + (c as usize);
                require!(grid[cell] == 0, BattleshipError::ShipsOverlap);
                grid[cell] = 1;
            }

            ships[idx] = Ship {
                start_row: placement.start_row,
                start_col: placement.start_col,
                size: placement.size,
                horizontal: if placement.horizontal { 1 } else { 0 },
                hits: 0,
            };
        }

        board.grid = grid;
        board.ships = ships;
        board.ships_placed = true;

        // Auto-transition: check if other player also placed
        let other_board = &ctx.accounts.other_player_board;
        if other_board.ships_placed {
            game.status = GameStatus::Playing as u8;
        }

        game.last_action_ts = Clock::get()?.unix_timestamp;

        Ok(())
    }

    // ── 10. fire (TEE) ─────────────────────────────────────────────────────

    pub fn fire(ctx: Context<Fire>, row: u8, col: u8) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let target_board = &mut ctx.accounts.target_board;
        let attacker = ctx.accounts.attacker.key();

        // Validate game is active
        require!(
            game.status == GameStatus::Playing as u8,
            BattleshipError::GameNotActive
        );

        // Validate attacker is a player
        require!(
            attacker == game.player_a || attacker == game.player_b,
            BattleshipError::NotAPlayer,
        );

        // Validate it's attacker's turn
        require!(
            game.current_turn == attacker,
            BattleshipError::NotYourTurn
        );

        // Validate coordinates in bounds
        require!(row < 6 && col < 6, BattleshipError::OutOfBounds);

        // Validate target board belongs to OPPONENT (not self)
        let expected_target = if attacker == game.player_a {
            game.player_b
        } else {
            game.player_a
        };
        require!(
            target_board.owner == expected_target,
            BattleshipError::WrongTarget,
        );

        let idx = (row as usize) * 6 + (col as usize);

        // Get the correct public hit board
        let is_a_attacking = attacker == game.player_a;
        let hits_board = if is_a_attacking {
            &mut game.board_b_hits
        } else {
            &mut game.board_a_hits
        };

        // Validate not already fired here
        require!(hits_board[idx] == 0, BattleshipError::AlreadyFired);

        // Check target board (private state inside TEE)
        if target_board.grid[idx] == 1 {
            // HIT
            hits_board[idx] = 2;
            target_board.grid[idx] = 2; // mark as hit_ship

            // Find which ship and increment hits
            for ship in target_board.ships.iter_mut() {
                if ship_occupies(ship, row, col) {
                    ship.hits += 1;
                    // Check if ship is sunk
                    if ship.hits == ship.size {
                        if is_a_attacking {
                            game.ships_remaining_b =
                                game.ships_remaining_b.saturating_sub(1);
                        } else {
                            game.ships_remaining_a =
                                game.ships_remaining_a.saturating_sub(1);
                        }
                    }
                    break;
                }
            }

            // Check win condition
            let remaining = if is_a_attacking {
                game.ships_remaining_b
            } else {
                game.ships_remaining_a
            };

            if remaining == 0 {
                game.status = GameStatus::Finished as u8;
                game.winner = attacker;
                game.has_winner = true;
                target_board.all_sunk = true;
            }
        } else {
            // MISS
            hits_board[idx] = 1;
            target_board.grid[idx] = 3;
        }

        // Switch turn
        game.current_turn = if is_a_attacking {
            game.player_b
        } else {
            game.player_a
        };

        game.turn_count += 1;
        game.last_action_ts = Clock::get()?.unix_timestamp;

        // Update attacker profile stats
        let profile = &mut ctx.accounts.attacker_profile;
        profile.total_shots_fired += 1;
        if target_board.grid[idx] == 2 {
            // Was just set to 2 on hit
            profile.total_hits += 1;
        }

        Ok(())
    }

    // ── 11a. update_leaderboard (Magic Action, base layer) ─────────────────

    pub fn update_leaderboard(ctx: Context<UpdateLeaderboard>) -> Result<()> {
        let game_info = &ctx.accounts.game.to_account_info();
        let mut data: &[u8] = &game_info.try_borrow_data()?;
        let game = GameState::try_deserialize(&mut data)?;

        let lb = &mut ctx.accounts.leaderboard;
        lb.total_games_played += 1;
        lb.last_updated = Clock::get()?.unix_timestamp;

        if game.has_winner {
            // Find or create entry for winner
            let winner = game.winner;
            let mut found = false;
            for entry in lb.entries.iter_mut() {
                if entry.is_active && entry.player == winner {
                    entry.wins += 1;
                    entry.total_games += 1;
                    found = true;
                    break;
                }
            }
            if !found {
                // Find empty slot
                for entry in lb.entries.iter_mut() {
                    if !entry.is_active {
                        entry.player = winner;
                        entry.wins = 1;
                        entry.total_games = 1;
                        entry.accuracy_bps = 0;
                        entry.is_active = true;
                        break;
                    }
                }
            }
        }

        Ok(())
    }

    // ── 11b. settle_game (TEE, commit + Magic Action) ──────────────────────

    #[allow(deprecated)]
    pub fn settle_game(ctx: Context<SettleGame>) -> Result<()> {
        let game = &ctx.accounts.game;
        let caller = ctx.accounts.payer.key();

        // Access control: only players can settle
        require!(
            game.status == GameStatus::Finished as u8,
            BattleshipError::GameNotFinished
        );
        require!(
            caller == game.player_a || caller == game.player_b,
            BattleshipError::NotAPlayer,
        );

        // Build Magic Action: update leaderboard on base layer
        let instruction_data =
            anchor_lang::InstructionData::data(&crate::instruction::UpdateLeaderboard {});
        let action = CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                ShortAccountMeta {
                    pubkey: ctx.accounts.leaderboard.key(),
                    is_writable: true,
                },
                ShortAccountMeta {
                    pubkey: ctx.accounts.game.key(),
                    is_writable: false,
                },
            ],
            args: ActionArgs::new(instruction_data),
            escrow_authority: ctx.accounts.payer.to_account_info(),
            compute_units: 200_000,
        };

        // Commit GameState + trigger leaderboard update + undelegate
        let magic_action = MagicInstructionBuilder {
            payer: ctx.accounts.payer.to_account_info(),
            magic_context: ctx.accounts.magic_context.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            magic_action: MagicAction::CommitAndUndelegate(CommitAndUndelegate {
                commit_type: CommitType::WithHandler {
                    commited_accounts: vec![ctx.accounts.game.to_account_info()],
                    call_handlers: vec![action],
                },
                undelegate_type: UndelegateType::Standalone,
            }),
        };
        magic_action.build_and_invoke()?;

        // Make both boards public for post-game reveal
        UpdatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .authority(&ctx.accounts.payer, true)
            .permissioned_account(&ctx.accounts.board_a, false)
            .permission(&ctx.accounts.permission_a)
            .args(MembersArgs { members: None })
            .invoke()?;

        UpdatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .authority(&ctx.accounts.payer, true)
            .permissioned_account(&ctx.accounts.board_b, false)
            .permission(&ctx.accounts.permission_b)
            .args(MembersArgs { members: None })
            .invoke()?;

        // Commit and undelegate both boards
        CommitAndUndelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .authority(&ctx.accounts.payer, true)
            .permissioned_account(&ctx.accounts.board_a, false)
            .permission(&ctx.accounts.permission_a)
            .magic_program(&ctx.accounts.magic_program)
            .magic_context(&ctx.accounts.magic_context)
            .invoke()?;

        CommitAndUndelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .authority(&ctx.accounts.payer, true)
            .permissioned_account(&ctx.accounts.board_b, false)
            .permission(&ctx.accounts.permission_b)
            .magic_program(&ctx.accounts.magic_program)
            .magic_context(&ctx.accounts.magic_context)
            .invoke()?;

        Ok(())
    }

    // ── 12. claim_prize ─────────────────────────────────────────────────��──

    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
        let game = &mut ctx.accounts.game;

        require!(
            game.status == GameStatus::Finished as u8
                || game.status == GameStatus::TimedOut as u8,
            BattleshipError::GameNotFinished
        );
        require!(game.has_winner, BattleshipError::GameNotFinished);
        require!(
            game.winner == ctx.accounts.winner.key(),
            BattleshipError::NotWinner
        );

        // Transfer entire pot to winner (set to 0 to prevent double-claim)
        let pot = game.pot_lamports;
        require!(pot > 0, BattleshipError::GameNotFinished);
        game.pot_lamports = 0;
        **game.to_account_info().try_borrow_mut_lamports()? -= pot;
        **ctx.accounts.winner.try_borrow_mut_lamports()? += pot;

        // Decrement active games for both players
        let profile_a = &mut ctx.accounts.profile_a;
        profile_a.active_games = profile_a.active_games.saturating_sub(1);
        profile_a.total_games += 1;

        let profile_b = &mut ctx.accounts.profile_b;
        profile_b.active_games = profile_b.active_games.saturating_sub(1);
        profile_b.total_games += 1;

        // Increment winner stats
        if game.winner == game.player_a {
            profile_a.total_wins += 1;
        } else {
            profile_b.total_wins += 1;
        }

        Ok(())
    }

    // ── 13. claim_timeout ───────────────────────────────────────────────���──

    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let claimer = ctx.accounts.claimer.key();
        let clock = Clock::get()?;

        require!(
            claimer == game.player_a || claimer == game.player_b,
            BattleshipError::NotAPlayer,
        );

        let elapsed = clock.unix_timestamp - game.last_action_ts;
        require!(elapsed > TIMEOUT_SECONDS, BattleshipError::NotTimedOut);

        match game.status {
            s if s == GameStatus::WaitingForPlayer as u8 => {
                // No opponent joined. Refund Player A.
                game.status = GameStatus::Cancelled as u8;
                let refund = game.buy_in_lamports;
                **game.to_account_info().try_borrow_mut_lamports()? -= refund;
                **ctx.accounts.claimer.try_borrow_mut_lamports()? += refund;

                // Only claimer exists — decrement their active_games
                ctx.accounts.claimer_profile.active_games =
                    ctx.accounts.claimer_profile.active_games.saturating_sub(1);
            }
            s if s == GameStatus::Placing as u8 => {
                // Validate wallet addresses match game players
                require!(
                    ctx.accounts.player_a_wallet.key() == game.player_a,
                    BattleshipError::NotAPlayer,
                );
                require!(
                    ctx.accounts.player_b_wallet.key() == game.player_b,
                    BattleshipError::NotAPlayer,
                );

                // Validate opponent_profile is the correct PDA for the other player
                let opponent = if claimer == game.player_a {
                    game.player_b
                } else {
                    game.player_a
                };
                let (expected_opponent_pda, _) = Pubkey::find_program_address(
                    &[PROFILE_SEED, opponent.as_ref()],
                    &crate::ID,
                );
                require!(
                    ctx.accounts.opponent_profile.key() == expected_opponent_pda,
                    BattleshipError::InvalidOpponentProfile,
                );

                // Someone didn't place ships. Refund both (no winner).
                game.status = GameStatus::TimedOut as u8;
                let each = game.buy_in_lamports;
                let total = each.checked_mul(2).ok_or(BattleshipError::Overflow)?;
                **game.to_account_info().try_borrow_mut_lamports()? -= total;
                **ctx.accounts.player_a_wallet.try_borrow_mut_lamports()? += each;
                **ctx.accounts.player_b_wallet.try_borrow_mut_lamports()? += each;

                // Decrement active_games for BOTH players
                ctx.accounts.claimer_profile.active_games =
                    ctx.accounts.claimer_profile.active_games.saturating_sub(1);
                ctx.accounts.opponent_profile.active_games =
                    ctx.accounts.opponent_profile.active_games.saturating_sub(1);
            }
            s if s == GameStatus::Playing as u8 => {
                // Opponent timed out during battle. Claimer wins.
                let timed_out_player = game.current_turn;
                let winner = if timed_out_player == game.player_a {
                    game.player_b
                } else {
                    game.player_a
                };
                require!(claimer == winner, BattleshipError::NotAPlayer);

                game.status = GameStatus::TimedOut as u8;
                game.winner = winner;
                game.has_winner = true;
                // Do NOT decrement active_games here — claim_prize handles
                // both profiles when the winner claims the pot.
            }
            _ => return Err(BattleshipError::WrongPhase.into()),
        }

        Ok(())
    }

    // ── 14. verify_board ───────────────────────────────────────────────────

    pub fn verify_board(
        ctx: Context<VerifyBoard>,
        placements: Vec<ShipPlacement>,
        salt: [u8; 32],
    ) -> Result<()> {
        let game = &ctx.accounts.game;
        let board_owner = ctx.accounts.board_owner.key();

        require!(
            game.status == GameStatus::Finished as u8
                || game.status == GameStatus::TimedOut as u8,
            BattleshipError::GameNotFinished,
        );

        // Reconstruct hash from revealed data
        let mut hasher = solana_program::hash::Hasher::default();
        for p in &placements {
            hasher.hash(&[
                p.start_row,
                p.start_col,
                p.size,
                if p.horizontal { 1 } else { 0 },
            ]);
        }
        hasher.hash(&salt);
        let computed_hash = hasher.result().to_bytes();

        // Compare to committed hash
        let stored_hash = if board_owner == game.player_a {
            game.board_hash_a
        } else if board_owner == game.player_b {
            game.board_hash_b
        } else {
            return Err(BattleshipError::NotAPlayer.into());
        };

        require!(
            computed_hash == stored_hash,
            BattleshipError::BoardTampered
        );

        msg!("Board verified for player: {}", board_owner);

        Ok(())
    }
}

// ── Helper functions ───────────────────────────────────────────────────────────

fn ship_occupies(ship: &Ship, row: u8, col: u8) -> bool {
    for i in 0..ship.size {
        let (sr, sc) = if ship.horizontal == 1 {
            (ship.start_row, ship.start_col + i)
        } else {
            (ship.start_row + i, ship.start_col)
        };
        if sr == row && sc == col {
            return true;
        }
    }
    false
}

// ── Accounts structs ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeProfile<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        init,
        payer = player,
        space = PLAYER_PROFILE_SIZE,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_profile: Account<'info, PlayerProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeLeaderboard<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = LEADERBOARD_SIZE,
        seeds = [LEADERBOARD_SEED],
        bump,
    )]
    pub leaderboard: Account<'info, Leaderboard>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(mut)]
    pub player_a: Signer<'info>,

    #[account(
        init,
        payer = player_a,
        space = GAME_STATE_SIZE,
        seeds = [GAME_SEED, player_a.key().as_ref(), &game_id.to_le_bytes()],
        bump,
    )]
    pub game: Account<'info, GameState>,

    #[account(
        init,
        payer = player_a,
        space = PLAYER_BOARD_SIZE,
        seeds = [BOARD_SEED, game.key().as_ref(), player_a.key().as_ref()],
        bump,
    )]
    pub player_board_a: Account<'info, PlayerBoard>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, player_a.key().as_ref()],
        bump = player_profile.profile_bump,
    )]
    pub player_profile: Account<'info, PlayerProfile>,

    /// CHECK: Permission PDA derived by Permission Program
    #[account(mut)]
    pub permission_a: AccountInfo<'info>,

    /// CHECK: Permission Program
    pub permission_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGame<'info> {
    #[account(mut)]
    pub player_b: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player_a.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.game_bump,
    )]
    pub game: Account<'info, GameState>,

    #[account(
        init,
        payer = player_b,
        space = PLAYER_BOARD_SIZE,
        seeds = [BOARD_SEED, game.key().as_ref(), player_b.key().as_ref()],
        bump,
    )]
    pub player_board_b: Account<'info, PlayerBoard>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, player_b.key().as_ref()],
        bump = player_profile.profile_bump,
    )]
    pub player_profile: Account<'info, PlayerProfile>,

    /// CHECK: Permission PDA
    #[account(mut)]
    pub permission_b: AccountInfo<'info>,
    /// CHECK: Permission Program
    pub permission_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelGame<'info> {
    #[account(mut)]
    pub player_a: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player_a.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.game_bump,
    )]
    pub game: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, player_a.key().as_ref()],
        bump = player_profile.profile_bump,
    )]
    pub player_profile: Account<'info, PlayerProfile>,
}

#[derive(Accounts)]
pub struct DelegateBoard<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player_a.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.game_bump,
    )]
    pub game: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [BOARD_SEED, game.key().as_ref(), player.key().as_ref()],
        bump = player_board.board_bump,
        constraint = player_board.owner == player.key() @ BattleshipError::NotYourBoard,
    )]
    pub player_board: Account<'info, PlayerBoard>,

    /// CHECK: Permission PDA for this board
    #[account(mut)]
    pub permission: AccountInfo<'info>,
    /// CHECK: Permission Program (ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1)
    pub permission_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Our own program (owner of the board account)
    pub owner_program: AccountInfo<'info>,
    /// CHECK: Delegation buffer PDA
    #[account(mut)]
    pub delegation_buffer: AccountInfo<'info>,
    /// CHECK: Delegation record PDA
    #[account(mut)]
    pub delegation_record: AccountInfo<'info>,
    /// CHECK: Delegation metadata PDA
    #[account(mut)]
    pub delegation_metadata: AccountInfo<'info>,
    /// CHECK: Delegation Program (DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh)
    pub delegation_program: AccountInfo<'info>,
    /// CHECK: TEE Validator (FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA)
    pub tee_validator: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct DelegateGameState<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player_a.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.game_bump,
    )]
    pub game: Account<'info, GameState>,

    /// CHECK: Permission PDA for game state
    #[account(mut)]
    pub game_permission: AccountInfo<'info>,
    /// CHECK: Permission Program
    pub permission_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Our own program
    pub owner_program: AccountInfo<'info>,
    /// CHECK: Delegation buffer PDA
    #[account(mut)]
    pub delegation_buffer: AccountInfo<'info>,
    /// CHECK: Delegation record PDA
    #[account(mut)]
    pub delegation_record: AccountInfo<'info>,
    /// CHECK: Delegation metadata PDA
    #[account(mut)]
    pub delegation_metadata: AccountInfo<'info>,
    /// CHECK: Delegation Program
    pub delegation_program: AccountInfo<'info>,
    /// CHECK: TEE Validator
    pub tee_validator: AccountInfo<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestTurnOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, GameState>,
    /// CHECK: Oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CallbackTurnOrderCtx<'info> {
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, GameState>,
}

#[derive(Accounts)]
pub struct PlaceShips<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(mut)]
    pub game: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [BOARD_SEED, game.key().as_ref(), player.key().as_ref()],
        bump = player_board.board_bump,
        constraint = player_board.owner == player.key() @ BattleshipError::NotYourBoard,
    )]
    pub player_board: Account<'info, PlayerBoard>,

    /// The other player's board (read-only, checking ships_placed for auto-transition)
    #[account(
        constraint = other_player_board.game == game.key() @ BattleshipError::WrongPhase,
        constraint = other_player_board.owner != player.key() @ BattleshipError::NotAPlayer,
    )]
    pub other_player_board: Account<'info, PlayerBoard>,
}

#[derive(Accounts)]
pub struct Fire<'info> {
    #[account(mut)]
    pub attacker: Signer<'info>,

    #[account(mut)]
    pub game: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [BOARD_SEED, game.key().as_ref(), target_board.owner.as_ref()],
        bump = target_board.board_bump,
    )]
    pub target_board: Account<'info, PlayerBoard>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, attacker.key().as_ref()],
        bump = attacker_profile.profile_bump,
    )]
    pub attacker_profile: Account<'info, PlayerProfile>,
}

#[action]
#[derive(Accounts)]
pub struct UpdateLeaderboard<'info> {
    #[account(mut, seeds = [LEADERBOARD_SEED], bump = leaderboard.leaderboard_bump)]
    pub leaderboard: Account<'info, Leaderboard>,
    /// CHECK: GameState (may be owned by Delegation Program at this point)
    pub game: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, GameState>,
    /// CHECK: Leaderboard PDA
    #[account(seeds = [LEADERBOARD_SEED], bump)]
    pub leaderboard: UncheckedAccount<'info>,
    /// CHECK: Board A account
    #[account(mut)]
    pub board_a: AccountInfo<'info>,
    /// CHECK: Board B account
    #[account(mut)]
    pub board_b: AccountInfo<'info>,
    /// CHECK: Permission PDA for board A
    #[account(mut)]
    pub permission_a: AccountInfo<'info>,
    /// CHECK: Permission PDA for board B
    #[account(mut)]
    pub permission_b: AccountInfo<'info>,
    /// CHECK: Permission Program
    pub permission_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player_a.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.game_bump,
    )]
    pub game: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, game.player_a.as_ref()],
        bump = profile_a.profile_bump,
    )]
    pub profile_a: Account<'info, PlayerProfile>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, game.player_b.as_ref()],
        bump = profile_b.profile_bump,
    )]
    pub profile_b: Account<'info, PlayerProfile>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player_a.as_ref(), &game.game_id.to_le_bytes()],
        bump = game.game_bump,
    )]
    pub game: Account<'info, GameState>,

    /// CHECK: Player A wallet — validated in instruction body for Placing branch
    #[account(mut)]
    pub player_a_wallet: AccountInfo<'info>,
    /// CHECK: Player B wallet — validated in instruction body for Placing branch
    #[account(mut)]
    pub player_b_wallet: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, claimer.key().as_ref()],
        bump = claimer_profile.profile_bump,
    )]
    pub claimer_profile: Account<'info, PlayerProfile>,

    /// Opponent's profile. PDA cannot be statically constrained because the
    /// opponent depends on who the claimer is (runtime value). Validated in
    /// the instruction body for the Placing branch, where both profiles must
    /// be decremented. For WaitingForPlayer (no opponent) and Playing
    /// (claim_prize handles profiles), the caller may pass any valid
    /// PlayerProfile — it will not be modified.
    #[account(mut)]
    pub opponent_profile: Account<'info, PlayerProfile>,
}

#[derive(Accounts)]
pub struct VerifyBoard<'info> {
    pub verifier: Signer<'info>,
    pub game: Account<'info, GameState>,
    /// CHECK: the player whose board is being verified
    pub board_owner: AccountInfo<'info>,
}
