"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TeeConnectionManager } from "@/lib/tee-connection";
import { generateBoardHash } from "@/lib/board-hash";
import {
  PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  TEE_VALIDATOR,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  VRF_PROGRAM_ID,
  ORACLE_QUEUE,
  SLOT_HASHES,
  getGamePda,
  getBoardPda,
  getProfilePda,
  getLeaderboardPda,
  getProgramIdentityPda,
  getPermissionPda,
  getDelegationRecordPda,
  getDelegationMetadataPda,
  getDelegationBufferPda,
  getProgram,
} from "@/lib/program";
import type { AnchorWallet } from "@/lib/program";
import type { TxEntry } from "@/components/TransactionLog";

// ── Constants ───────────────────────────────────────────────────────────────

const GameStatus = {
  WaitingForPlayer: 0,
  Placing: 1,
  Playing: 2,
  Finished: 3,
  Cancelled: 4,
  TimedOut: 5,
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

type GamePhase = "lobby" | "placing" | "playing" | "finished";

interface GameStateData {
  gameId: bigint;
  playerA: PublicKey;
  playerB: PublicKey;
  invitedPlayer: PublicKey;
  status: number;
  currentTurn: PublicKey;
  turnCount: number;
  potLamports: number;
  buyInLamports: number;
  boardAHits: number[];
  boardBHits: number[];
  shipsRemainingA: number;
  shipsRemainingB: number;
  winner: PublicKey;
  hasWinner: boolean;
  boardsDelegated: number;
}

interface ShipPlacementInput {
  startRow: number;
  startCol: number;
  size: number;
  horizontal: boolean;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useGame() {
  const { publicKey, signTransaction, signAllTransactions, signMessage } =
    useWallet();
  const { connection } = useConnection();

  // === Public state ===
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [gameState, setGameState] = useState<GameStateData | null>(null);
  const [gamePda, setGamePda] = useState<PublicKey | null>(null);
  const [myGrid, setMyGrid] = useState<number[]>(new Array(36).fill(0));
  const [txLog, setTxLog] = useState<TxEntry[]>([]);
  const [lastHit, setLastHit] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [boardSalt, setBoardSalt] = useState<Uint8Array | null>(null);
  const [shipsPlaced, setShipsPlaced] = useState(false);
  const [prizeClaimed, setPrizeClaimed] = useState(false);

  // === Internal refs (avoid stale closures in subscriptions/effects) ===
  const teeRef = useRef<TeeConnectionManager | null>(null);
  const playerRoleRef = useRef<"a" | "b" | null>(null);
  const gameIdBnRef = useRef<BN | null>(null);
  const gamePdaRef = useRef<PublicKey | null>(null);
  const pendingBuyInRef = useRef(0);
  const pendingInvitedRef = useRef("");
  const storedPlacementsRef = useRef<ShipPlacementInput[] | null>(null);
  const gameStateRef = useRef<GameStateData | null>(null);

  // Orchestration step flags
  const boardDelegatedRef = useRef(false);
  const vrfRequestedRef = useRef(false);
  const gameStateDelegatedRef = useRef(false);
  const shipsPlacedOnTeeRef = useRef(false);
  const settledRef = useRef(false);
  const orchestratingRef = useRef(false);

  // Subscription IDs
  const baseSubRef = useRef<number | null>(null);
  const teeSubRef = useRef<number | null>(null);

  // Keep gameStateRef in sync
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // ── Helpers ─────────────────────────────────────────────────────────────

  const addTxLog = useCallback(
    (
      sig: string,
      action: string,
      latencyMs: number,
      result?: "hit" | "miss" | "sunk",
    ) => {
      setTxLog((prev) => [
        { sig, action, latencyMs, timestamp: Date.now(), result },
        ...prev,
      ]);
    },
    [],
  );

  function makeWallet(): AnchorWallet {
    if (!publicKey || !signTransaction || !signAllTransactions) {
      throw new Error("Wallet not connected");
    }
    return { publicKey, signTransaction, signAllTransactions };
  }

  function baseProgram() {
    return getProgram(connection, makeWallet());
  }

  function teeProgram() {
    if (!teeRef.current) throw new Error("TEE not initialized");
    return getProgram(teeRef.current.getConnection(), makeWallet());
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  function parseGameState(d: any): GameStateData {
    return {
      gameId: BigInt(d.gameId.toString()),
      playerA: d.playerA,
      playerB: d.playerB,
      invitedPlayer: d.invitedPlayer,
      status: d.status,
      currentTurn: d.currentTurn,
      turnCount: d.turnCount,
      potLamports:
        typeof d.potLamports === "number"
          ? d.potLamports
          : d.potLamports.toNumber(),
      buyInLamports:
        typeof d.buyInLamports === "number"
          ? d.buyInLamports
          : d.buyInLamports.toNumber(),
      boardAHits: Array.from(d.boardAHits),
      boardBHits: Array.from(d.boardBHits),
      shipsRemainingA: d.shipsRemainingA,
      shipsRemainingB: d.shipsRemainingB,
      winner: d.winner,
      hasWinner: d.hasWinner,
      boardsDelegated: d.boardsDelegated,
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ── Phase derived from on-chain status ──────────────────────────────────

  useEffect(() => {
    if (!gameState) return; // don't reset to lobby when state is null
    switch (gameState.status) {
      case GameStatus.WaitingForPlayer:
      case GameStatus.Placing:
        setPhase("placing");
        break;
      case GameStatus.Playing:
        setPhase("playing");
        break;
      case GameStatus.Finished:
      case GameStatus.TimedOut:
        setPhase("finished");
        break;
      default:
        setPhase("lobby");
    }
  }, [gameState]);

  // ── Cleanup ─────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (baseSubRef.current !== null) {
        connection.removeAccountChangeListener(baseSubRef.current);
      }
      teeRef.current?.destroy();
    };
  }, [connection]);

  // ── Subscription management ─────────────────────────────────────────────

  function setupBaseSubscription(pda: PublicKey): void {
    if (baseSubRef.current !== null) {
      connection.removeAccountChangeListener(baseSubRef.current);
    }
    const program = baseProgram();
    baseSubRef.current = connection.onAccountChange(
      pda,
      (accountInfo) => {
        try {
          const decoded = program.coder.accounts.decode(
            "gameState",
            accountInfo.data,
          );
          const gs = parseGameState(decoded);
          setGameState(gs);
        } catch {
          // account may be in transition (delegation)
        }
      },
      "confirmed",
    );
  }

  function setupTeeSubscription(pda: PublicKey): void {
    // Remove base subscription
    if (baseSubRef.current !== null) {
      connection.removeAccountChangeListener(baseSubRef.current);
      baseSubRef.current = null;
    }
    if (!teeRef.current) return;

    const teeConn = teeRef.current.getConnection();
    const program = teeProgram();

    if (teeSubRef.current !== null) {
      teeConn.removeAccountChangeListener(teeSubRef.current);
    }

    teeSubRef.current = teeConn.onAccountChange(
      pda,
      (accountInfo) => {
        try {
          const decoded = program.coder.accounts.decode(
            "gameState",
            accountInfo.data,
          );
          const gs = parseGameState(decoded);
          setGameState(gs);
        } catch {
          // decode error during transition
        }
      },
      "confirmed",
    );

    // Also subscribe to own board for real-time hit updates
    if (publicKey) {
      const [myBoardPda] = getBoardPda(pda, publicKey);
      teeConn.onAccountChange(
        myBoardPda,
        (accountInfo) => {
          try {
            const decoded = program.coder.accounts.decode(
              "playerBoard",
              accountInfo.data,
            );
            setMyGrid(Array.from(decoded.grid));
          } catch {
            // decode error
          }
        },
        "confirmed",
      );
    }
  }

  // ── Transaction helpers ─────────────────────────────────────────────────

  async function ensureProfile(): Promise<void> {
    if (!publicKey) return;
    const [profilePda] = getProfilePda(publicKey);
    const info = await connection.getAccountInfo(profilePda);
    if (info) return;

    const program = baseProgram();
    const start = Date.now();
    const sig = await program.methods
      .initializeProfile()
      .accounts({
        player: publicKey,
        playerProfile: profilePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    addTxLog(sig, "initialize_profile", Date.now() - start);
  }

  async function sendCreateGameTx(
    pda: PublicKey,
    boardHash: Uint8Array,
  ): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const gameId = gameIdBnRef.current!;
    const buyIn = new BN(pendingBuyInRef.current);
    const invitedPlayer = pendingInvitedRef.current
      ? new PublicKey(pendingInvitedRef.current)
      : PublicKey.default;
    const seedA = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    const hashA = Array.from(boardHash);

    const [boardPda] = getBoardPda(pda, publicKey);
    const [profilePda] = getProfilePda(publicKey);
    const permissionPda = getPermissionPda(boardPda);

    const start = Date.now();
    const sig = await program.methods
      .createGame(gameId, buyIn, invitedPlayer, seedA, hashA)
      .accounts({
        playerA: publicKey,
        game: pda,
        playerBoardA: boardPda,
        playerProfile: profilePda,
        permissionA: permissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    addTxLog(sig, "create_game", Date.now() - start);

    // Fetch initial game state
    const decoded = await program.account.gameState.fetch(pda);
    setGameState(parseGameState(decoded));
  }

  async function sendJoinGameTx(
    pda: PublicKey,
    boardHash: Uint8Array,
  ): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const seedB = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    const hashB = Array.from(boardHash);

    const [boardPda] = getBoardPda(pda, publicKey);
    const [profilePda] = getProfilePda(publicKey);
    const permissionPda = getPermissionPda(boardPda);

    const start = Date.now();
    const sig = await program.methods
      .joinGame(seedB, hashB)
      .accounts({
        playerB: publicKey,
        game: pda,
        playerBoardB: boardPda,
        playerProfile: profilePda,
        permissionB: permissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    addTxLog(sig, "join_game", Date.now() - start);

    const decoded = await program.account.gameState.fetch(pda);
    setGameState(parseGameState(decoded));
  }

  async function delegateMyBoard(pda: PublicKey): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const [boardPda] = getBoardPda(pda, publicKey);
    const permissionPda = getPermissionPda(boardPda);

    const start = Date.now();
    const sig = await program.methods
      .delegateBoard()
      .accounts({
        player: publicKey,
        game: pda,
        playerBoard: boardPda,
        permission: permissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ownerProgram: PROGRAM_ID,
        delegationBuffer: getDelegationBufferPda(boardPda, PROGRAM_ID),
        delegationRecord: getDelegationRecordPda(boardPda),
        delegationMetadata: getDelegationMetadataPda(boardPda),
        delegationProgram: DELEGATION_PROGRAM_ID,
        teeValidator: TEE_VALIDATOR,
      })
      .rpc();
    addTxLog(sig, "delegate_board", Date.now() - start);
  }

  async function requestVrfTurnOrder(pda: PublicKey): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const [programIdentity] = getProgramIdentityPda();

    const start = Date.now();
    const sig = await program.methods
      .requestTurnOrder()
      .accounts({
        payer: publicKey,
        game: pda,
        oracleQueue: ORACLE_QUEUE,
        programIdentity,
        vrfProgram: VRF_PROGRAM_ID,
        slotHashes: SLOT_HASHES,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    addTxLog(sig, "request_turn_order", Date.now() - start);
  }

  async function delegateGameStateTx(pda: PublicKey): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const gamePermission = getPermissionPda(pda);

    const start = Date.now();
    const sig = await program.methods
      .delegateGameState()
      .accounts({
        payer: publicKey,
        game: pda,
        gamePermission,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ownerProgram: PROGRAM_ID,
        delegationBuffer: getDelegationBufferPda(pda, PROGRAM_ID),
        delegationRecord: getDelegationRecordPda(pda),
        delegationMetadata: getDelegationMetadataPda(pda),
        delegationProgram: DELEGATION_PROGRAM_ID,
        teeValidator: TEE_VALIDATOR,
      })
      .rpc();
    addTxLog(sig, "delegate_game_state", Date.now() - start);
  }

  async function placeShipsOnTee(
    pda: PublicKey,
    role: string,
    gs: GameStateData,
  ): Promise<void> {
    if (!publicKey || !storedPlacementsRef.current) return;

    // Ensure TEE connection exists
    if (!teeRef.current) {
      if (!signMessage) throw new Error("signMessage not available");
      const tee = new TeeConnectionManager({ publicKey, signMessage });
      await tee.init();
      teeRef.current = tee;
    }

    const program = teeProgram();
    const [myBoard] = getBoardPda(pda, publicKey);
    const opponent = role === "a" ? gs.playerB : gs.playerA;
    const [otherBoard] = getBoardPda(pda, opponent);

    const placements = storedPlacementsRef.current.map((p) => ({
      startRow: p.startRow,
      startCol: p.startCol,
      size: p.size,
      horizontal: p.horizontal,
    }));

    const start = Date.now();
    const sig = await program.methods
      .placeShips(placements)
      .accounts({
        player: publicKey,
        game: pda,
        playerBoard: myBoard,
        otherPlayerBoard: otherBoard,
      })
      .rpc();
    addTxLog(sig, "place_ships", Date.now() - start);
  }

  async function doSettleGame(): Promise<void> {
    const gs = gameStateRef.current;
    const pda = gamePdaRef.current;
    if (!publicKey || !pda || !gs) return;

    const program = teeProgram();
    const [leaderboardPda] = getLeaderboardPda();
    const [boardA] = getBoardPda(pda, gs.playerA);
    const [boardB] = getBoardPda(pda, gs.playerB);

    const start = Date.now();
    const sig = await program.methods
      .settleGame()
      .accounts({
        payer: publicKey,
        game: pda,
        leaderboard: leaderboardPda,
        boardA,
        boardB,
        permissionA: getPermissionPda(boardA),
        permissionB: getPermissionPda(boardB),
        permissionProgram: PERMISSION_PROGRAM_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT_ID,
      })
      .rpc();
    addTxLog(sig, "settle_game", Date.now() - start);

    // After settlement, game is back on base layer
    if (teeSubRef.current !== null && teeRef.current) {
      teeRef.current
        .getConnection()
        .removeAccountChangeListener(teeSubRef.current);
      teeSubRef.current = null;
    }

    // Wait for base layer to have the committed data, then fetch
    await sleep(3000);
    try {
      const baseP = baseProgram();
      const decoded = await baseP.account.gameState.fetch(pda);
      setGameState(parseGameState(decoded));
    } catch {
      // May take longer to settle; state will still show Finished
    }
  }

  // ── Orchestration ─────────────────────────────────────────────────────────
  // Drives the multi-step setup: delegate boards → VRF → delegate game → place ships

  useEffect(() => {
    if (!gameState || !gamePdaRef.current || !playerRoleRef.current) return;
    if (!publicKey || !signTransaction || !signAllTransactions) return;
    if (!shipsPlaced) return;

    // Only orchestrate during setup phases
    if (
      gameState.status !== GameStatus.WaitingForPlayer &&
      gameState.status !== GameStatus.Placing
    )
      return;

    if (orchestratingRef.current) return;

    const pda = gamePdaRef.current;
    const role = playerRoleRef.current;
    let cancelled = false;

    (async () => {
      orchestratingRef.current = true;
      try {
        const gs = gameState;

        // Step 1: Delegate my board (requires Placing status)
        if (
          gs.status === GameStatus.Placing &&
          !boardDelegatedRef.current &&
          !cancelled
        ) {
          try {
            await delegateMyBoard(pda);
            boardDelegatedRef.current = true;
          } catch (e) {
            console.warn("delegate_board failed (may already be done):", e);
            boardDelegatedRef.current = true;
          }
        }

        // Step 2: Request VRF (after both boards delegated)
        if (
          gs.boardsDelegated >= 2 &&
          !vrfRequestedRef.current &&
          !cancelled
        ) {
          try {
            await requestVrfTurnOrder(pda);
            vrfRequestedRef.current = true;
          } catch (e) {
            console.warn("request_turn_order failed (may be duplicate):", e);
            vrfRequestedRef.current = true;
          }
        }

        // Step 3: Delegate game state (after VRF callback sets current_turn)
        if (
          !gs.currentTurn.equals(PublicKey.default) &&
          gs.boardsDelegated >= 2 &&
          !gameStateDelegatedRef.current &&
          !cancelled
        ) {
          try {
            await delegateGameStateTx(pda);
            gameStateDelegatedRef.current = true;
          } catch (e) {
            console.warn(
              "delegate_game_state failed (may already be done):",
              e,
            );
            gameStateDelegatedRef.current = true;
          }

          // Switch to TEE subscription
          await sleep(2000);
          if (!cancelled) {
            setupTeeSubscription(pda);
          }
        }

        // Step 4: Place ships on TEE
        if (
          gameStateDelegatedRef.current &&
          !shipsPlacedOnTeeRef.current &&
          storedPlacementsRef.current &&
          !cancelled
        ) {
          // Allow TEE time to pick up delegated accounts
          await sleep(2000);
          if (cancelled) return;

          // Refresh game state from TEE before placing
          let freshGs = gs;
          try {
            const tp = teeProgram();
            const decoded = await tp.account.gameState.fetch(pda);
            freshGs = parseGameState(decoded);
            setGameState(freshGs);
          } catch {
            // TEE might need more time; retry on next orchestration cycle
            return;
          }

          try {
            await placeShipsOnTee(pda, role, freshGs);
            shipsPlacedOnTeeRef.current = true;
          } catch (e) {
            console.warn("place_ships failed:", e);
          }
        }
      } finally {
        orchestratingRef.current = false;
      }
    })().catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [
    gameState,
    shipsPlaced,
    publicKey,
    signTransaction,
    signAllTransactions,
    signMessage,
    connection,
  ]);

  // ── Auto-settle on Finished ─────────────────────────────────────────────

  useEffect(() => {
    if (
      gameState?.status === GameStatus.Finished &&
      !settledRef.current &&
      gamePdaRef.current &&
      publicKey
    ) {
      settledRef.current = true;
      doSettleGame().catch((e) => {
        console.error("Auto-settle failed:", e);
        settledRef.current = false;
      });
    }
  }, [gameState?.status, publicKey]);

  // ── Public API ────────────────────────────────────────────────────────────

  const initTeeConnection = useCallback(async () => {
    if (!publicKey || !signMessage || teeRef.current) return;
    const tee = new TeeConnectionManager({ publicKey, signMessage });
    await tee.init();
    teeRef.current = tee;
  }, [publicKey, signMessage]);

  const createGame = useCallback(
    async (buyInLamports: number, invitedPlayer: string) => {
      if (!publicKey) return;

      // Compute game ID and PDA
      const gameId = new BN(Math.floor(Date.now() / 1000));
      const [pda] = getGamePda(publicKey, gameId);

      // Store pending config for placeShips to use
      gameIdBnRef.current = gameId;
      gamePdaRef.current = pda;
      playerRoleRef.current = "a";
      pendingBuyInRef.current = buyInLamports;
      pendingInvitedRef.current = invitedPlayer;

      setGamePda(pda);
      setPhase("placing");
    },
    [publicKey],
  );

  const joinGame = useCallback(
    async (gameAddress: string) => {
      if (!publicKey || !signTransaction || !signAllTransactions) return;
      try {
        const pda = new PublicKey(gameAddress);
        gamePdaRef.current = pda;
        playerRoleRef.current = "b";
        setGamePda(pda);

        // Fetch game to get player_a and game_id
        const program = baseProgram();
        const decoded = await program.account.gameState.fetch(pda);
        const gs = parseGameState(decoded);
        gameIdBnRef.current = new BN(gs.gameId.toString());
        setGameState(gs);
        setPhase("placing");
      } catch (e) {
        console.error("Failed to join game:", e);
      }
    },
    [publicKey, signTransaction, signAllTransactions, connection],
  );

  const placeShips = useCallback(
    async (placements: ShipPlacementInput[]) => {
      if (!publicKey || !signMessage) return;
      const role = playerRoleRef.current;
      const pda = gamePdaRef.current;
      if (!role || !pda) return;

      try {
        // Generate board hash and store salt
        const { hash, salt } = generateBoardHash(placements);
        setBoardSalt(salt);
        storedPlacementsRef.current = placements;

        // Build grid for local display
        const grid = new Array(36).fill(0);
        for (const p of placements) {
          for (let i = 0; i < p.size; i++) {
            const r = p.horizontal ? p.startRow : p.startRow + i;
            const c = p.horizontal ? p.startCol + i : p.startCol;
            grid[r * 6 + c] = 1;
          }
        }
        setMyGrid(grid);
        setShipsPlaced(true);

        // Ensure profile exists
        await ensureProfile();

        // Send create_game or join_game TX
        if (role === "a") {
          await sendCreateGameTx(pda, hash);
        } else {
          await sendJoinGameTx(pda, hash);
        }

        // Init TEE connection
        if (!teeRef.current) {
          const tee = new TeeConnectionManager({ publicKey, signMessage });
          await tee.init();
          teeRef.current = tee;
        }

        // Set up base layer subscription + initial fetch
        setupBaseSubscription(pda);
        const program = baseProgram();
        const decoded = await program.account.gameState.fetch(pda);
        const gs = parseGameState(decoded);
        setGameState(gs);
      } catch (e) {
        console.error("placeShips failed:", e);
        setShipsPlaced(false);
      }
    },
    [publicKey, signMessage, signTransaction, signAllTransactions, connection],
  );

  const fire = useCallback(
    async (row: number, col: number) => {
      const gs = gameStateRef.current;
      if (!publicKey || !gs || !gamePda) return;
      const start = Date.now();
      setLastHit({ row, col });

      try {
        const program = teeProgram();
        const isA = gs.playerA.equals(publicKey);
        const opponent = isA ? gs.playerB : gs.playerA;
        const [targetBoard] = getBoardPda(gamePda, opponent);
        const [attackerProfile] = getProfilePda(publicKey);

        const sig = await program.methods
          .fire(row, col)
          .accounts({
            attacker: publicKey,
            game: gamePda,
            targetBoard,
            attackerProfile,
          })
          .rpc();

        const latency = Date.now() - start;

        // Determine hit/miss/sunk from updated state
        const decoded = await program.account.gameState.fetch(gamePda);
        const updated = parseGameState(decoded);
        const idx = row * 6 + col;
        const hitsBoard = isA ? updated.boardBHits : updated.boardAHits;
        const hitValue = hitsBoard[idx];

        let result: "hit" | "miss" | "sunk" | undefined;
        if (hitValue === 2) {
          const prevRemaining = isA
            ? gs.shipsRemainingB
            : gs.shipsRemainingA;
          const newRemaining = isA
            ? updated.shipsRemainingB
            : updated.shipsRemainingA;
          result = newRemaining < prevRemaining ? "sunk" : "hit";
        } else if (hitValue === 1) {
          result = "miss";
        }

        addTxLog(sig, `fire(${row},${col})`, latency, result);
        setGameState(updated);
      } catch (e) {
        console.error("fire failed:", e);
        addTxLog("failed", `fire(${row},${col})`, Date.now() - start);
      }
    },
    [publicKey, gamePda, addTxLog],
  );

  const claimPrize = useCallback(async () => {
    const gs = gameStateRef.current;
    if (!publicKey || !gamePda || !gs) return;
    const start = Date.now();

    try {
      const program = baseProgram();
      const [profileA] = getProfilePda(gs.playerA);
      const [profileB] = getProfilePda(gs.playerB);

      const sig = await program.methods
        .claimPrize()
        .accounts({
          winner: publicKey,
          game: gamePda,
          profileA,
          profileB,
        })
        .rpc();

      setPrizeClaimed(true);
      addTxLog(sig, "claim_prize", Date.now() - start);
    } catch (e) {
      console.error("claimPrize failed:", e);
      addTxLog("failed", "claim_prize", Date.now() - start);
    }
  }, [publicKey, gamePda, addTxLog, connection, signTransaction, signAllTransactions]);

  const verifyBoard = useCallback(async () => {
    if (!publicKey || !gamePda || !boardSalt || !storedPlacementsRef.current)
      return;
    const start = Date.now();

    try {
      const program = baseProgram();
      const placements = storedPlacementsRef.current.map((p) => ({
        startRow: p.startRow,
        startCol: p.startCol,
        size: p.size,
        horizontal: p.horizontal,
      }));

      const sig = await program.methods
        .verifyBoard(placements, Array.from(boardSalt))
        .accounts({
          verifier: publicKey,
          game: gamePda,
          boardOwner: publicKey,
        })
        .rpc();

      addTxLog(sig, "verify_board", Date.now() - start);
    } catch (e) {
      console.error("verifyBoard failed:", e);
      addTxLog("failed", "verify_board", Date.now() - start);
    }
  }, [publicKey, gamePda, boardSalt, addTxLog, connection, signTransaction, signAllTransactions]);

  // ── Derived values ────────────────────────────────────────────────────────

  const isMyTurn =
    gameState && publicKey
      ? gameState.currentTurn.equals(publicKey)
      : false;

  const isPlayerA =
    gameState && publicKey ? gameState.playerA.equals(publicKey) : false;

  const opponentHits = gameState
    ? isPlayerA
      ? gameState.boardBHits
      : gameState.boardAHits
    : new Array(36).fill(0);

  const shipsRemainingMe = gameState
    ? isPlayerA
      ? gameState.shipsRemainingA
      : gameState.shipsRemainingB
    : 5;

  const shipsRemainingOpponent = gameState
    ? isPlayerA
      ? gameState.shipsRemainingB
      : gameState.shipsRemainingA
    : 5;

  const isWinner =
    gameState && publicKey && gameState.hasWinner
      ? gameState.winner.equals(publicKey)
      : false;

  // ── Return (same API as before) ───────────────────────────────────────────

  return {
    // State
    phase,
    gameState,
    gamePda,
    myGrid,
    opponentHits,
    isMyTurn,
    shipsRemainingMe,
    shipsRemainingOpponent,
    lastHit,
    txLog,
    isWinner,
    shipsPlaced,
    prizeClaimed,
    boardSalt,
    // Actions
    createGame,
    joinGame,
    placeShips,
    fire,
    claimPrize,
    verifyBoard,
    initTeeConnection,
  };
}
