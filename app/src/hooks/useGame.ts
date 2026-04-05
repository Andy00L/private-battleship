"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TeeConnectionManager } from "@/lib/tee-connection";
import { generateBoardHash } from "@/lib/board-hash";
import { getSfx } from "@/lib/sfx";
import { debugLog } from "@/lib/debug-logger";
import {
  PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
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
  getSessionAuthorityPda,
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

const STATUS_NAMES: Record<number, string> = {
  0: "WaitingForPlayer",
  1: "Placing",
  2: "Playing",
  3: "Finished",
  4: "Cancelled",
  5: "TimedOut",
};

const ERR_TOO_MANY_GAMES = 6020;
const ERR_ACCOUNT_OWNED_BY_WRONG_PROGRAM = 3007;

/** Must match the contract's TIMEOUT_SECONDS */
const TIMEOUT_SECONDS = 300;

/** Must match the contract's MIN_BUY_IN / MAX_BUY_IN */
const MIN_BUY_IN = 1_000_000; // 0.001 SOL
const MAX_BUY_IN = 100_000_000_000; // 100 SOL

const GAME_STATE_DISCRIMINATOR = Buffer.from([144, 94, 208, 172, 248, 99, 134, 120]);

// ── Error helpers ───────────────────────────────────────────────────────────

function hasErrorCode(e: unknown, code: number): boolean {
  const s = String(e);
  const hex = `0x${code.toString(16)}`;
  if (
    s.includes(`Error Number: ${code}`) ||
    s.includes(`custom program error: ${hex}`) ||
    s.includes(`"Custom":${code}`)
  ) return true;
  // Check transaction logs (SendTransactionError has .logs)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs = (e as any)?.logs;
  if (Array.isArray(logs) && logs.some((l: string) => typeof l === "string" && l.includes(hex))) return true;
  return false;
}

function hasAnchorError(e: unknown, code: number): boolean {
  const s = String(e);
  return (
    s.includes(`Error Number: ${code}`) ||
    s.includes(`Error Code: ${code}`)
  );
}

function isSkippableError(e: unknown): boolean {
  return (
    hasAnchorError(e, ERR_ACCOUNT_OWNED_BY_WRONG_PROGRAM) ||
    String(e).toLowerCase().includes("already delegated")
  );
}

/** Convert raw Solana/Anchor errors to human-readable messages. */
function toUserError(e: unknown): string {
  const s = String(e);
  if (s.includes("User rejected")) return "Transaction cancelled.";
  if (s.includes("insufficient lamports") || s.includes("0x1"))
    return "Not enough SOL for this transaction.";
  if (s.includes("AccountNotFound")) return "Game not found. It may have expired.";
  if (s.includes("BuyInTooLow")) return `Buy-in below minimum (${(MIN_BUY_IN / 1e9).toFixed(3)} SOL).`;
  if (s.includes("BuyInTooHigh")) return `Buy-in above maximum (${(MAX_BUY_IN / 1e9).toFixed(0)} SOL).`;
  if (s.includes("GameFull")) return "Game is full.";
  if (s.includes("NotInvited")) return "You are not invited to this game.";
  if (s.includes("NotTimedOut")) return "Timeout period has not elapsed yet.";
  if (e instanceof Error) return e.message.replace(/^(Error:\s*)+/, "").slice(0, 200);
  return s.replace(/^(Error:\s*)+/, "").slice(0, 200);
}

function pk(key: PublicKey | null | undefined): string {
  if (!key) return "null";
  const s = key.toBase58();
  return s === "11111111111111111111111111111111" ? "default" : s.slice(0, 8) + "...";
}

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
  lastActionTs: number;
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
  const [gameState, setGameState] = useState<GameStateData | null>(null);
  const [gamePda, setGamePda] = useState<PublicKey | null>(null);
  const [myGrid, setMyGrid] = useState<number[]>(new Array(36).fill(0));
  const [txLog, setTxLog] = useState<TxEntry[]>([]);
  const [lastHit, setLastHit] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [recentShots, setRecentShots] = useState<
    { row: number; col: number; result: "hit" | "miss" | "sunk"; timestamp: number }[]
  >([]);
  const [boardSalt, setBoardSalt] = useState<Uint8Array | null>(null);
  const [shipsPlaced, setShipsPlaced] = useState(false);
  const [prizeClaimed, setPrizeClaimed] = useState(false);
  const [setupStatus, setSetupStatus] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endGameStatus, setEndGameStatus] = useState<
    "none" | "settling" | "settled" | "claiming" | "claimed" | "error"
  >("none");

  // === Internal refs ===
  const teeRef = useRef<TeeConnectionManager | null>(null);
  const playerRoleRef = useRef<"a" | "b" | null>(null);
  const gameIdBnRef = useRef<BN | null>(null);
  const gamePdaRef = useRef<PublicKey | null>(null);
  const pendingBuyInRef = useRef(0);
  const pendingInvitedRef = useRef("");
  const storedPlacementsRef = useRef<ShipPlacementInput[] | null>(null);
  const gameStateRef = useRef<GameStateData | null>(null);
  const settledRef = useRef(false);
  const firingRef = useRef(false);
  const boardHashRef = useRef<Uint8Array | null>(null);
  const sessionKeypairRef = useRef<Keypair | null>(null);

  // Subscription IDs
  const baseSubRef = useRef<number | null>(null);
  const teeSubRef = useRef<number | null>(null);
  const teeBoardSubRef = useRef<number | null>(null);

  // Keep gameStateRef in sync (transaction functions use setGameState directly)
  useEffect(() => {
    gameStateRef.current = gameState;
    if (gameState) {
      debugLog.log("STATE", `gameState updated: status=${STATUS_NAMES[gameState.status] ?? gameState.status} boardsDelegated=${gameState.boardsDelegated} turn=${pk(gameState.currentTurn)} turnCount=${gameState.turnCount} shipsA=${gameState.shipsRemainingA} shipsB=${gameState.shipsRemainingB}`);
    }
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
      throw new Error("Wallet disconnected. Please reconnect and try again.");
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

  /** Anchor program using session keypair as signer (no wallet popups). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sessionTeeProgram(): any {
    if (!teeRef.current) throw new Error("TEE not initialized");
    if (!sessionKeypairRef.current) throw new Error("No session key");
    const kp = sessionKeypairRef.current;
    const conn = teeRef.current.getConnection();
    const wallet: AnchorWallet = {
      publicKey: kp.publicKey,
      signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
      signAllTransactions: async (txs) => { txs.forEach((tx) => tx.partialSign(kp)); return txs; },
    };
    return getProgram(conn, wallet);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Send multiple instructions in a single transaction (1 wallet popup).
   * Includes a ComputeBudget instruction to handle CPI-heavy batches.
   */
  async function sendBatchedTx(
    instructions: TransactionInstruction[],
    computeUnits: number,
    label: string,
  ): Promise<string> {
    if (!publicKey || !signTransaction) throw new Error("Wallet not connected");

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
    for (const ix of instructions) {
      tx.add(ix);
    }
    tx.feePayer = publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    debugLog.log("TX", `${label} BATCH SENDING`, { instructions: instructions.length, computeUnits });
    const start = Date.now();
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    const latency = Date.now() - start;

    debugLog.log("TX", `${label} BATCH SUCCESS sig=${sig} latency=${latency}ms`);
    addTxLog(sig, label, latency);
    return sig;
  }

  async function assertSufficientBalance(requiredLamports: number): Promise<void> {
    if (!publicKey) throw new Error("Wallet disconnected. Please reconnect and try again.");
    debugLog.log("RPC", `getBalance for ${pk(publicKey)}`);
    const balance = await connection.getBalance(publicKey);
    const needed = requiredLamports + 10_000_000;
    debugLog.log("RPC", `balance=${(balance / 1e9).toFixed(4)} SOL, needed=${(needed / 1e9).toFixed(4)} SOL`);
    if (balance < needed) {
      const needSol = (needed / 1e9).toFixed(4);
      const haveSol = (balance / 1e9).toFixed(4);
      throw new Error(`Not enough SOL. Need ~${needSol}, have ${haveSol}.`);
    }
  }

  /**
   * Find all active games for a player and call claim_timeout on each.
   * Used to free up active_games slots when TooManyGames (6020) is hit.
   */
  async function autoClaimTimeouts(player: PublicKey): Promise<number> {
    debugLog.log("RPC", `autoClaimTimeouts: scanning games for ${pk(player)}`);
    const program = baseProgram();

    const [gamesAsA, gamesAsB] = await Promise.all([
      connection.getProgramAccounts(PROGRAM_ID, {
        filters: [
          { memcmp: { offset: 0, bytes: GAME_STATE_DISCRIMINATOR.toString("base64"), encoding: "base64" } },
          { memcmp: { offset: 16, bytes: player.toBase58() } },
        ],
      }),
      connection.getProgramAccounts(PROGRAM_ID, {
        filters: [
          { memcmp: { offset: 0, bytes: GAME_STATE_DISCRIMINATOR.toString("base64"), encoding: "base64" } },
          { memcmp: { offset: 48, bytes: player.toBase58() } },
        ],
      }),
    ]);

    const seen = new Set<string>();
    const allGames = [...gamesAsA, ...gamesAsB].filter((g) => {
      const k = g.pubkey.toBase58();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    debugLog.log("RPC", `autoClaimTimeouts: found ${allGames.length} games`);

    // No games found but profile says active_games > 0: stale counter from redeploy
    if (allGames.length === 0) {
      debugLog.log("TX", "autoClaimTimeouts: 0 games found, resetting stale active_games counter");
      try {
        const [profilePda] = getProfilePda(player);
        const start = Date.now();
        const sig = await program.methods
          .resetActiveGames()
          .accounts({
            player,
            playerProfile: profilePda,
          })
          .rpc();
        debugLog.log("TX", `reset_active_games SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
        addTxLog(sig, "reset_active_games", Date.now() - start);
      } catch (e) {
        debugLog.error("reset_active_games failed (non-fatal)", e);
      }
      return 0;
    }

    let claimed = 0;
    for (const { pubkey: gamePubkey } of allGames) {
      try {
        const decoded = await program.account.gameState.fetch(gamePubkey);
        const gs = parseGameState(decoded);

        if (
          gs.status === GameStatus.Finished ||
          gs.status === GameStatus.Cancelled ||
          gs.status === GameStatus.TimedOut
        ) {
          debugLog.log("TX", `autoClaimTimeouts: skipping ${pk(gamePubkey)} (terminal status=${STATUS_NAMES[gs.status]})`);
          continue;
        }

        const isPlayerA = gs.playerA.equals(player);
        const opponent = isPlayerA ? gs.playerB : gs.playerA;
        const [claimerProfile] = getProfilePda(player);
        const opponentKey = opponent.equals(PublicKey.default) ? player : opponent;
        const [opponentProfile] = getProfilePda(opponentKey);

        debugLog.log("TX", `autoClaimTimeouts: claiming ${pk(gamePubkey)} status=${STATUS_NAMES[gs.status]}`);
        await program.methods
          .claimTimeout()
          .accounts({
            claimer: player,
            game: gamePubkey,
            playerAWallet: gs.playerA,
            playerBWallet: opponent.equals(PublicKey.default) ? player : gs.playerB,
            claimerProfile,
            opponentProfile,
          })
          .rpc();

        debugLog.log("TX", `autoClaimTimeouts: claimed ${pk(gamePubkey)}`);
        claimed++;
      } catch (e) {
        debugLog.error(`autoClaimTimeouts: failed for ${pk(gamePubkey)}`, e);
      }
    }

    debugLog.log("TX", `autoClaimTimeouts: claimed ${claimed}/${allGames.length}`);

    // All games exist but none were claimable (all terminal or all claims failed).
    // Counter is stale. Reset it so the player can create/join new games.
    if (claimed === 0) {
      debugLog.log("TX", "autoClaimTimeouts: 0 claimed (all terminal or failed), resetting stale counter");
      try {
        const [profilePda] = getProfilePda(player);
        const start = Date.now();
        const sig = await program.methods
          .resetActiveGames()
          .accounts({
            player,
            playerProfile: profilePda,
          })
          .rpc();
        debugLog.log("TX", `reset_active_games SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
        addTxLog(sig, "reset_active_games", Date.now() - start);
      } catch (e) {
        debugLog.error("reset_active_games failed (non-fatal)", e);
      }
    }

    return claimed;
  }

  /** Reset all internal state for a fresh game. */
  function resetForNewGame(): void {
    debugLog.log("STATE", "resetForNewGame");
    if (baseSubRef.current !== null) {
      connection.removeAccountChangeListener(baseSubRef.current);
      baseSubRef.current = null;
    }
    if (teeRef.current) {
      const teeConn = teeRef.current.getConnection();
      if (teeSubRef.current !== null) {
        teeConn.removeAccountChangeListener(teeSubRef.current);
        teeSubRef.current = null;
      }
      if (teeBoardSubRef.current !== null) {
        teeConn.removeAccountChangeListener(teeBoardSubRef.current);
        teeBoardSubRef.current = null;
      }
    }

    settledRef.current = false;
    firingRef.current = false;
    storedPlacementsRef.current = null;
    gameStateRef.current = null;
    gamePdaRef.current = null;
    playerRoleRef.current = null;
    gameIdBnRef.current = null;
    boardHashRef.current = null;
    if (sessionKeypairRef.current) {
      debugLog.log("SESSION", "Session key cleared", { reason: "game_reset" });
      sessionKeypairRef.current = null;
    }

    setGameState(null);
    setGamePda(null);
    setMyGrid(new Array(36).fill(0));
    setTxLog([]);
    setLastHit(null);
    setBoardSalt(null);
    setShipsPlaced(false);
    setPrizeClaimed(false);
    setSetupStatus("");
    setSetupError(null);
    setError(null);
    setEndGameStatus("none");

    try {
      let cleared = 0;
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key?.startsWith("battleship:")) {
          sessionStorage.removeItem(key);
          cleared++;
        }
      }
      debugLog.log("SESSION", `cleared ${cleared} sessionStorage keys`);
    } catch {
      // sessionStorage unavailable — non-fatal
    }
  }

  // ── Session persistence for commit-reveal data ──────────────────────────

  function persistCommitReveal(
    pda: PublicKey,
    salt: Uint8Array,
    placements: ShipPlacementInput[],
  ): void {
    try {
      const key = `battleship:${pda.toBase58()}`;
      sessionStorage.setItem(
        key,
        JSON.stringify({
          salt: Array.from(salt),
          placements,
        }),
      );
      debugLog.log("SESSION", `persisted commit-reveal for ${pk(pda)}`);
    } catch {
      // sessionStorage unavailable — non-fatal
    }
  }

  function restoreCommitReveal(
    pda: PublicKey,
  ): { salt: Uint8Array; placements: ShipPlacementInput[] } | null {
    try {
      const key = `battleship:${pda.toBase58()}`;
      const raw = sessionStorage.getItem(key);
      if (!raw) {
        debugLog.log("SESSION", `no commit-reveal found for ${pk(pda)}`);
        return null;
      }
      const data = JSON.parse(raw);
      debugLog.log("SESSION", `restored commit-reveal for ${pk(pda)}`);
      return {
        salt: new Uint8Array(data.salt),
        placements: data.placements,
      };
    } catch {
      return null;
    }
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
      lastActionTs:
        typeof d.lastActionTs === "number"
          ? d.lastActionTs
          : d.lastActionTs.toNumber(),
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ── Cleanup ─────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      debugLog.log("STATE", "useGame unmounting — cleaning up subscriptions");
      if (baseSubRef.current !== null) {
        connection.removeAccountChangeListener(baseSubRef.current);
        baseSubRef.current = null;
      }
      if (teeRef.current) {
        const teeConn = teeRef.current.getConnection();
        if (teeSubRef.current !== null) {
          teeConn.removeAccountChangeListener(teeSubRef.current);
          teeSubRef.current = null;
        }
        if (teeBoardSubRef.current !== null) {
          teeConn.removeAccountChangeListener(teeBoardSubRef.current);
          teeBoardSubRef.current = null;
        }
        teeRef.current.destroy();
      }
      if (sessionKeypairRef.current) {
        debugLog.log("SESSION", "Session key cleared", { reason: "unmount" });
        sessionKeypairRef.current = null;
      }
    };
  }, [connection]);

  // ── Subscription management ─────────────────────────────────────────────

  function setupBaseSubscription(pda: PublicKey): void {
    if (baseSubRef.current !== null) {
      connection.removeAccountChangeListener(baseSubRef.current);
    }
    debugLog.log("SUB", `setupBaseSubscription for ${pk(pda)}`);
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
          debugLog.log("SUB", `base update: status=${STATUS_NAMES[gs.status]} boardsDelegated=${gs.boardsDelegated} turn=${pk(gs.currentTurn)}`);
          setGameState(gs);
        } catch {
          debugLog.log("SUB", "base decode skipped (owner changed during delegation)");
        }
      },
      "confirmed",
    );
  }

  function setupTeeSubscription(pda: PublicKey): void {
    if (baseSubRef.current !== null) {
      connection.removeAccountChangeListener(baseSubRef.current);
      baseSubRef.current = null;
    }
    if (!teeRef.current) return;

    debugLog.log("SUB", `setupTeeSubscription for ${pk(pda)}`);
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
          debugLog.log("SUB", `TEE game update: status=${STATUS_NAMES[gs.status]} turn=${pk(gs.currentTurn)} turnCount=${gs.turnCount} shipsA=${gs.shipsRemainingA} shipsB=${gs.shipsRemainingB}`);

          // Detect enemy shot (turn switched TO me = opponent just fired at my board)
          const prev = gameStateRef.current;
          if (prev && publicKey && gs.currentTurn.equals(publicKey) && !prev.currentTurn.equals(publicKey) && gs.status === GameStatus.Playing) {
            const isA = gs.playerA.equals(publicKey);
            const myShipsNow = isA ? gs.shipsRemainingA : gs.shipsRemainingB;
            const myShipsBefore = isA ? prev.shipsRemainingA : prev.shipsRemainingB;
            if (myShipsNow < myShipsBefore) {
              getSfx().play("enemy_sunk");
            } else {
              // Check hit boards for new entries on my board
              const myHitsNow = isA ? gs.boardAHits : gs.boardBHits;
              const myHitsBefore = isA ? prev.boardAHits : prev.boardBHits;
              const newHit = myHitsNow.some((v: number, i: number) => v === 2 && myHitsBefore[i] === 0);
              if (newHit) getSfx().play("enemy_hit");
              else getSfx().play("enemy_miss");
            }
          }

          setGameState(gs);

          // Auto end-game: settle → wait for L1 → auto-claim
          if (gs.status === GameStatus.Finished && !settledRef.current) {
            settledRef.current = true;
            debugLog.log("ORCH", "auto end-game triggered (Finished)");
            runEndGameFlow().catch((e) => {
              console.error("End-game flow failed:", e);
              debugLog.error("runEndGameFlow failed", e);
            });
          }
        } catch {
          debugLog.log("SUB", "TEE game decode skipped");
        }
      },
      "confirmed",
    );

    if (publicKey) {
      if (teeBoardSubRef.current !== null) {
        teeConn.removeAccountChangeListener(teeBoardSubRef.current);
      }
      const [myBoardPda] = getBoardPda(pda, publicKey);
      debugLog.log("SUB", `TEE board subscription for ${pk(myBoardPda)}`);
      teeBoardSubRef.current = teeConn.onAccountChange(
        myBoardPda,
        (accountInfo) => {
          try {
            const decoded = program.coder.accounts.decode(
              "playerBoard",
              accountInfo.data,
            );
            setMyGrid(Array.from(decoded.grid));
            debugLog.log("SUB", "TEE board update received");
          } catch {
            debugLog.log("SUB", "TEE board decode skipped");
          }
        },
        "confirmed",
      );
    }
  }

  // ── Orchestration helpers ───────────────────────────────────────────────

  async function withRetry(
    fn: () => Promise<void>,
    maxRetries = 3,
    delayMs = 2000,
  ): Promise<void> {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        await fn();
        return;
      } catch (e) {
        if (isSkippableError(e)) {
          debugLog.log("ORCH", `withRetry: skipped (already done)`);
          return;
        }
        if (i === maxRetries) throw e;
        debugLog.log("ORCH", `withRetry: attempt ${i + 1}/${maxRetries} failed, retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  async function pollGameState(
    pda: PublicKey,
    condition: (gs: GameStateData) => boolean,
    statusMsg?: string,
    intervalMs = 3000,
    maxAttempts = 40,
  ): Promise<GameStateData> {
    if (statusMsg) setSetupStatus(statusMsg);
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const program = baseProgram();
        const decoded = await program.account.gameState.fetch(pda);
        const gs = parseGameState(decoded);
        debugLog.log("POLL", `attempt ${i + 1}/${maxAttempts}: status=${STATUS_NAMES[gs.status]} boardsDelegated=${gs.boardsDelegated} turn=${pk(gs.currentTurn)}`);
        setGameState(gs);
        if (condition(gs)) {
          debugLog.log("POLL", `condition met on attempt ${i + 1}`);
          return gs;
        }
      } catch {
        debugLog.log("POLL", `attempt ${i + 1}/${maxAttempts}: fetch failed (transition)`);
      }
      await sleep(intervalMs);
    }
    throw new Error("Timed out waiting for game state update. Please refresh and try again.");
  }

  /**
   * Sequential orchestration: runs the entire game setup as a single async flow.
   * Each step follows the previous. No useEffect. No flag refs.
   */
  async function runGameSetup(
    pda: PublicKey,
    role: "a" | "b",
    hash: Uint8Array,
  ): Promise<void> {
    debugLog.log("ORCH", `runGameSetup START role=${role} pda=${pk(pda)}`);
    const orchStart = Date.now();
    try {
      // ── Batched setup: profile + create/join + session key (1 popup) ──
      const existingAccount = await connection.getAccountInfo(pda);
      debugLog.log("RPC", `getAccountInfo(${pk(pda)}): ${existingAccount ? "exists" : "null"}`);
      const program = baseProgram();
      const [profilePda] = getProfilePda(publicKey!);

      // Pre-emptive stale counter reset: check profile BEFORE batch to avoid TooManyGames.
      // If active_games >= 3 and no real games exist, reset counter proactively.
      const profileCheck = await connection.getAccountInfo(profilePda);
      if (profileCheck) {
        try {
          const profileDecoded = program.coder.accounts.decode("playerProfile", profileCheck.data);
          if (profileDecoded.activeGames >= 3) {
            debugLog.log("ORCH", `pre-check: active_games=${profileDecoded.activeGames}, running autoClaimTimeouts`);
            setSetupStatus("Cleaning up stale games...");
            await autoClaimTimeouts(publicKey!);

            // Wait for RPC to catch up, then re-verify
            await sleep(2000);
            const rechecked = await connection.getAccountInfo(profilePda);
            if (rechecked) {
              try {
                const reDecoded = program.coder.accounts.decode("playerProfile", rechecked.data);
                debugLog.log("ORCH", `pre-check: after cleanup, active_games=${reDecoded.activeGames}`);
                if (reDecoded.activeGames >= 3) {
                  debugLog.log("ORCH", "pre-check: still stale after cleanup, forcing second reset");
                  const [ppda] = getProfilePda(publicKey!);
                  await program.methods.resetActiveGames().accounts({ player: publicKey!, playerProfile: ppda }).rpc();
                  await sleep(2000);
                }
              } catch { /* non-fatal */ }
            }
          }
        } catch (decErr) {
          debugLog.log("ORCH", `pre-check: profile decode failed (non-fatal): ${decErr}`);
        }
      }

      if (role === "a" && !existingAccount) {
        // Player A fresh game: batch ensureProfile + create_game + register_session_key
        debugLog.log("ORCH", "step 1: Player A BATCHED create START");
        setSetupStatus("Creating game...");
        await assertSufficientBalance(pendingBuyInRef.current);

        const instructions: TransactionInstruction[] = [];

        // ensureProfile (if needed)
        const profileInfo = await connection.getAccountInfo(profilePda);
        if (!profileInfo) {
          instructions.push(
            await program.methods.initializeProfile().accounts({
              player: publicKey!,
              playerProfile: profilePda,
              systemProgram: SystemProgram.programId,
            }).instruction(),
          );
          debugLog.log("ORCH", "batch: +initializeProfile");
        }

        // create_game
        const gameId = gameIdBnRef.current!;
        const buyIn = new BN(pendingBuyInRef.current);
        let invitedPlayer: PublicKey;
        try {
          invitedPlayer = pendingInvitedRef.current
            ? new PublicKey(pendingInvitedRef.current)
            : PublicKey.default;
        } catch {
          throw new Error(`Invalid invited player address: "${pendingInvitedRef.current}"`);
        }
        const seedA = Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const hashA = Array.from(hash);
        const [boardPda] = getBoardPda(pda, publicKey!);
        const permissionPda = getPermissionPda(boardPda);

        instructions.push(
          await program.methods.createGame(gameId, buyIn, invitedPlayer, seedA, hashA).accounts({
            playerA: publicKey!,
            game: pda,
            playerBoardA: boardPda,
            playerProfile: profilePda,
            permissionA: permissionPda,
            permissionProgram: PERMISSION_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }).instruction(),
        );
        debugLog.log("ORCH", "batch: +createGame");

        // register_session_key (preserve existing key if already registered)
        if (!sessionKeypairRef.current) {
          sessionKeypairRef.current = Keypair.generate();
          debugLog.log("SESSION", "Generated new session keypair", { publicKey: sessionKeypairRef.current.publicKey.toBase58() });
        } else {
          debugLog.log("SESSION", "Preserving existing session keypair", { publicKey: sessionKeypairRef.current.publicKey.toBase58() });
        }
        const sessionKp = sessionKeypairRef.current;
        const [sessionAuthorityPda] = getSessionAuthorityPda(pda, publicKey!);
        instructions.push(
          await program.methods.registerSessionKey(sessionKp.publicKey, new BN(3600)).accounts({
            player: publicKey!,
            game: pda,
            sessionAuthority: sessionAuthorityPda,
            systemProgram: SystemProgram.programId,
          }).instruction(),
        );
        debugLog.log("ORCH", "batch: +registerSessionKey");

        try {
          await sendBatchedTx(instructions, 400_000, "create+session");
        } catch (e) {
          debugLog.log("ORCH", `batch "create+session" failed: ${String(e).substring(0, 300)}`);
          debugLog.log("ORCH", `hasErrorCode(6020)=${hasErrorCode(e, ERR_TOO_MANY_GAMES)}`);
          if (hasErrorCode(e, ERR_TOO_MANY_GAMES)) {
            debugLog.log("ORCH", "TooManyGames in batch — running autoClaimTimeouts + retry");
            setSetupStatus("Cleaning up stale games...");
            await autoClaimTimeouts(publicKey!);
            // sendBatchedTx builds a fresh TX with new blockhash internally
            await sendBatchedTx(instructions, 400_000, "create+session (retry)");
          } else {
            throw e;
          }
        }

        const decoded = await program.account.gameState.fetch(pda);
        setGameState(parseGameState(decoded));
        debugLog.log("ORCH", `step 1: Player A BATCHED create DONE (${Date.now() - orchStart}ms)`);

      } else if (role === "a" && existingAccount) {
        // Player A page refresh: game already exists
        debugLog.log("ORCH", "step 1: game already exists (page refresh)");
        await ensureProfile();
        try {
          const decoded = await program.account.gameState.fetch(pda);
          setGameState(parseGameState(decoded));
        } catch {
          throw new Error("Stale game detected. Please create a new game.");
        }
        // Try to register session key (may fail if game already delegated)
        try {
          await registerSessionKey(pda);
        } catch (e) {
          if (sessionKeypairRef.current) {
            debugLog.log("SESSION", "registerSessionKey failed but existing key preserved", {
              publicKey: sessionKeypairRef.current.publicKey.toBase58(),
              error: String(e).slice(0, 120),
            });
          } else {
            debugLog.log("SESSION", "registerSessionKey failed, no existing key, wallet fallback");
          }
        }

      } else if (role === "b") {
        if (!existingAccount) throw new Error("Game not found.");
        let fetchedGs: GameStateData;
        try {
          const decoded = await program.account.gameState.fetch(pda);
          fetchedGs = parseGameState(decoded);
        } catch {
          throw new Error("Stale game detected. Cannot join.");
        }

        if (fetchedGs.playerB.equals(PublicKey.default)) {
          // Player B fresh join: batch ensureProfile + join_game + delegate_board + register_session_key
          debugLog.log("ORCH", "step 1: Player B BATCHED join START");
          setSetupStatus("Joining game...");
          await assertSufficientBalance(fetchedGs.buyInLamports);

          const instructions: TransactionInstruction[] = [];

          // ensureProfile (if needed)
          const profileInfo = await connection.getAccountInfo(profilePda);
          if (!profileInfo) {
            instructions.push(
              await program.methods.initializeProfile().accounts({
                player: publicKey!,
                playerProfile: profilePda,
                systemProgram: SystemProgram.programId,
              }).instruction(),
            );
            debugLog.log("ORCH", "batch: +initializeProfile");
          }

          // join_game
          const seedB = Array.from(crypto.getRandomValues(new Uint8Array(32)));
          const hashB = Array.from(hash);
          const [boardPdaB] = getBoardPda(pda, publicKey!);
          const permissionPdaB = getPermissionPda(boardPdaB);

          instructions.push(
            await program.methods.joinGame(seedB, hashB).accounts({
              playerB: publicKey!,
              game: pda,
              playerBoardB: boardPdaB,
              playerProfile: profilePda,
              permissionB: permissionPdaB,
              permissionProgram: PERMISSION_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            }).instruction(),
          );
          debugLog.log("ORCH", "batch: +joinGame");

          // delegate_board (status will be Placing after join_game in same TX)
          instructions.push(
            await program.methods.delegateBoard().accounts({
              player: publicKey!,
              game: pda,
              pda: boardPdaB,
              teeValidator: TEE_VALIDATOR,
            }).instruction(),
          );
          debugLog.log("ORCH", "batch: +delegateBoard");

          // register_session_key (preserve existing key if already registered)
          if (!sessionKeypairRef.current) {
            sessionKeypairRef.current = Keypair.generate();
            debugLog.log("SESSION", "Generated new session keypair", { publicKey: sessionKeypairRef.current.publicKey.toBase58() });
          } else {
            debugLog.log("SESSION", "Preserving existing session keypair", { publicKey: sessionKeypairRef.current.publicKey.toBase58() });
          }
          const sessionKpB = sessionKeypairRef.current;
          const [sessionAuthorityPda] = getSessionAuthorityPda(pda, publicKey!);
          instructions.push(
            await program.methods.registerSessionKey(sessionKpB.publicKey, new BN(3600)).accounts({
              player: publicKey!,
              game: pda,
              sessionAuthority: sessionAuthorityPda,
              systemProgram: SystemProgram.programId,
            }).instruction(),
          );
          debugLog.log("ORCH", "batch: +registerSessionKey");

          try {
            await sendBatchedTx(instructions, 500_000, "join+delegate+session");
          } catch (e) {
            debugLog.log("ORCH", `batch "join+delegate+session" failed: ${String(e).substring(0, 300)}`);
            debugLog.log("ORCH", `hasErrorCode(6020)=${hasErrorCode(e, ERR_TOO_MANY_GAMES)}`);
            if (hasErrorCode(e, ERR_TOO_MANY_GAMES)) {
              debugLog.log("ORCH", "TooManyGames in batch — running autoClaimTimeouts + retry");
              setSetupStatus("Cleaning up stale games...");
              await autoClaimTimeouts(publicKey!);
              await sendBatchedTx(instructions, 500_000, "join+delegate+session (retry)");
            } else {
              throw e;
            }
          }

          const decoded2 = await program.account.gameState.fetch(pda);
          setGameState(parseGameState(decoded2));
          debugLog.log("ORCH", `step 1: Player B BATCHED join DONE (${Date.now() - orchStart}ms)`);

        } else if (fetchedGs.playerB.equals(publicKey!)) {
          debugLog.log("ORCH", "step 1: player B already joined (page refresh)");
          await ensureProfile();
          setGameState(fetchedGs);
          // Try to register session key
          try {
            await registerSessionKey(pda);
          } catch (e) {
            if (sessionKeypairRef.current) {
              debugLog.log("SESSION", "registerSessionKey failed but existing key preserved", {
                publicKey: sessionKeypairRef.current.publicKey.toBase58(),
                error: String(e).slice(0, 120),
              });
            } else {
              debugLog.log("SESSION", "registerSessionKey failed, no existing key, wallet fallback");
            }
          }
        } else {
          throw new Error("Game is full.");
        }
      }

      // Step 2: Wait for Placing status
      debugLog.log("ORCH", "step 2: wait for Placing START");
      setupBaseSubscription(pda);
      setSetupStatus("Waiting for game to start...");
      let gs = await pollGameState(pda, (g) => g.status >= GameStatus.Placing);
      debugLog.log("ORCH", "step 2: wait for Placing DONE");

      // Step 3: Delegate my board (Player A only; Player B already batched)
      if (role === "a") {
        debugLog.log("ORCH", "step 3: delegateMyBoard START");
        const step3Start = Date.now();
        setSetupStatus("Delegating board to secure enclave...");
        await withRetry(() => delegateMyBoard(pda));
        debugLog.log("ORCH", `step 3: delegateMyBoard DONE (${Date.now() - step3Start}ms)`);
      } else {
        debugLog.log("ORCH", "step 3: SKIPPED (Player B board already delegated in batch)");
      }

      // Step 4: Wait for both boards delegated
      debugLog.log("ORCH", "step 4: wait for boardsDelegated>=2 START");
      gs = await pollGameState(
        pda,
        (g) => g.boardsDelegated >= 2,
        "Waiting for opponent to delegate...",
      );
      debugLog.log("ORCH", "step 4: wait for boardsDelegated>=2 DONE");

      // Step 5: Request VRF turn order (if not already determined)
      if (gs.currentTurn.equals(PublicKey.default)) {
        debugLog.log("ORCH", "step 5: requestVrfTurnOrder START");
        const step5Start = Date.now();
        setSetupStatus("Determining turn order...");
        await withRetry(() => requestVrfTurnOrder(pda));
        debugLog.log("ORCH", `step 5: VRF requested (${Date.now() - step5Start}ms), waiting for callback...`);
        gs = await pollGameState(
          pda,
          (g) => !g.currentTurn.equals(PublicKey.default),
          "Waiting for turn order...",
        );
        debugLog.log("ORCH", `step 5: VRF callback received, turn=${pk(gs.currentTurn)}`);
      } else {
        debugLog.log("ORCH", `step 5: SKIPPED (turn already set: ${pk(gs.currentTurn)})`);
      }

      // Step 6: Delegate game state to TEE
      debugLog.log("ORCH", "step 6: delegateGameState START");
      const step6Start = Date.now();
      setSetupStatus("Delegating game state...");
      await withRetry(() => delegateGameStateTx(pda));
      debugLog.log("ORCH", `step 6: delegateGameState DONE (${Date.now() - step6Start}ms)`);

      // Step 7: Connect to TEE
      debugLog.log("ORCH", "step 7: TEE connect START");
      setSetupStatus("Connecting to secure enclave...");
      if (!teeRef.current) {
        if (!signMessage) throw new Error("Wallet does not support message signing.");
        debugLog.log("TEE", "initializing TeeConnectionManager");
        const tee = new TeeConnectionManager({ publicKey: publicKey!, signMessage });
        await tee.init();
        teeRef.current = tee;
        debugLog.log("TEE", "TeeConnectionManager initialized");
      } else {
        debugLog.log("TEE", "already connected");
      }

      await sleep(2000);
      setupTeeSubscription(pda);
      debugLog.log("ORCH", "step 7: TEE connect DONE");

      // Step 8: Place ships on TEE
      debugLog.log("ORCH", "step 8: placeShipsOnTee START");
      const step8Start = Date.now();
      setSetupStatus("Placing ships in secure enclave...");
      let freshGs: GameStateData;
      try {
        debugLog.log("RPC", "fetching game state from TEE");
        const tp = teeProgram();
        const decoded = await tp.account.gameState.fetch(pda);
        freshGs = parseGameState(decoded);
        setGameState(freshGs);
      } catch {
        debugLog.log("RPC", "TEE fetch failed, retrying after 3s...");
        await sleep(3000);
        const tp = teeProgram();
        const decoded = await tp.account.gameState.fetch(pda);
        freshGs = parseGameState(decoded);
        setGameState(freshGs);
      }

      await placeShipsOnTee(pda, role, freshGs);
      debugLog.log("ORCH", `step 8: placeShipsOnTee DONE (${Date.now() - step8Start}ms)`);

      setSetupStatus("Waiting for opponent to place ships...");
      setSetupError(null);
      debugLog.log("ORCH", `runGameSetup COMPLETE (${Date.now() - orchStart}ms total)`);
    } catch (e) {
      console.error("Game setup failed:", e);
      debugLog.error("runGameSetup FAILED", e);
      setSetupError(toUserError(e));
      setSetupStatus("");
      setShipsPlaced(false);
    }
  }

  // ── Transaction helpers ─────────────────────────────────────────────────

  async function registerSessionKey(gamePda: PublicKey): Promise<void> {
    if (!publicKey) return;
    // Preserve existing key if already registered (e.g. from batch TX before retry)
    if (!sessionKeypairRef.current) {
      sessionKeypairRef.current = Keypair.generate();
      debugLog.log("SESSION", "Generated new session keypair", { publicKey: sessionKeypairRef.current.publicKey.toBase58() });
    } else {
      debugLog.log("SESSION", "Reusing existing session keypair for registration", { publicKey: sessionKeypairRef.current.publicKey.toBase58() });
    }
    const kp = sessionKeypairRef.current;

    const program = baseProgram();
    const [sessionAuthorityPda] = getSessionAuthorityPda(gamePda, publicKey);
    const duration = new BN(3600); // 1 hour

    debugLog.log("TX", "register_session_key SENDING", { sessionKey: kp.publicKey, game: gamePda, program: "base" });
    const start = Date.now();
    const sig = await program.methods
      .registerSessionKey(kp.publicKey, duration)
      .accounts({
        player: publicKey,
        game: gamePda,
        sessionAuthority: sessionAuthorityPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    debugLog.log("TX", `register_session_key SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "register_session_key", Date.now() - start);
  }

  async function ensureProfile(): Promise<void> {
    if (!publicKey) return;
    const [profilePda] = getProfilePda(publicKey);
    debugLog.log("RPC", `getAccountInfo(profile ${pk(profilePda)})`);
    const info = await connection.getAccountInfo(profilePda);
    if (info) {
      debugLog.log("TX", "ensureProfile: already exists");
      return;
    }

    debugLog.log("TX", "initialize_profile SENDING", { player: publicKey });
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
    debugLog.log("TX", `initialize_profile SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
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
    let invitedPlayer: PublicKey;
    try {
      invitedPlayer = pendingInvitedRef.current
        ? new PublicKey(pendingInvitedRef.current)
        : PublicKey.default;
    } catch {
      throw new Error(
        `Invalid invited player address: "${pendingInvitedRef.current}"`,
      );
    }
    const seedA = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    const hashA = Array.from(boardHash);

    const [boardPda] = getBoardPda(pda, publicKey);
    const [profilePda] = getProfilePda(publicKey);
    const permissionPda = getPermissionPda(boardPda);

    debugLog.log("TX", "create_game SENDING", { playerA: publicKey, game: pda, buyIn: pendingBuyInRef.current, invited: invitedPlayer, program: "base" });
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
    debugLog.log("TX", `create_game SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "create_game", Date.now() - start);

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

    debugLog.log("TX", "join_game SENDING", { playerB: publicKey, game: pda, program: "base" });
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
    debugLog.log("TX", `join_game SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "join_game", Date.now() - start);

    const decoded = await program.account.gameState.fetch(pda);
    setGameState(parseGameState(decoded));
  }

  async function delegateMyBoard(gamePda: PublicKey): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const [boardPda] = getBoardPda(gamePda, publicKey);

    debugLog.log("TX", "delegate_board SENDING", { player: publicKey, board: boardPda, program: "base" });
    const start = Date.now();
    const sig = await program.methods
      .delegateBoard()
      .accounts({
        player: publicKey,
        game: gamePda,
        pda: boardPda,
        teeValidator: TEE_VALIDATOR,
      })
      .rpc();
    debugLog.log("TX", `delegate_board SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "delegate_board", Date.now() - start);
  }

  async function requestVrfTurnOrder(pda: PublicKey): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const [programIdentity] = getProgramIdentityPda();

    debugLog.log("TX", "request_turn_order SENDING", { game: pda, program: "base" });
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
    debugLog.log("TX", `request_turn_order SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "request_turn_order", Date.now() - start);
  }

  async function delegateGameStateTx(gamePda: PublicKey): Promise<void> {
    if (!publicKey) return;
    const program = baseProgram();
    const gamePermission = getPermissionPda(gamePda);

    debugLog.log("TX", "delegate_game_state SENDING", { game: gamePda, program: "base" });
    const start = Date.now();
    const sig = await program.methods
      .delegateGameState()
      .accounts({
        payer: publicKey,
        pda: gamePda,
        gamePermission,
        permissionProgram: PERMISSION_PROGRAM_ID,
        teeValidator: TEE_VALIDATOR,
      })
      .rpc();
    debugLog.log("TX", `delegate_game_state SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "delegate_game_state", Date.now() - start);
  }

  async function placeShipsOnTee(
    pda: PublicKey,
    role: string,
    gs: GameStateData,
  ): Promise<void> {
    if (!publicKey || !storedPlacementsRef.current) return;

    if (!teeRef.current) {
      if (!signMessage) throw new Error("Wallet does not support message signing.");
      debugLog.log("TEE", "placeShipsOnTee: initializing TEE connection");
      const tee = new TeeConnectionManager({ publicKey, signMessage });
      await tee.init();
      teeRef.current = tee;
    }

    // Use session key if available, fall back to wallet
    const useSession = sessionKeypairRef.current != null;
    const program = useSession ? sessionTeeProgram() : teeProgram();
    const signerKey = useSession ? sessionKeypairRef.current!.publicKey : publicKey;

    // PDAs always derived from WALLET pubkey, not session key
    const [myBoard] = getBoardPda(pda, publicKey);
    const opponent = role === "a" ? gs.playerB : gs.playerA;
    const [otherBoard] = getBoardPda(pda, opponent);
    const [sessionAuthorityPda] = getSessionAuthorityPda(pda, publicKey);

    const placements = storedPlacementsRef.current.map((p) => ({
      startRow: p.startRow,
      startCol: p.startCol,
      size: p.size,
      horizontal: p.horizontal,
    }));

    debugLog.log("TX", `place_ships SENDING (${useSession ? "session" : "wallet"})`, { signer: signerKey, board: myBoard, otherBoard, program: "TEE" });
    const start = Date.now();
    const sig = await program.methods
      .placeShips(placements)
      .accounts({
        player: signerKey,
        game: pda,
        playerBoard: myBoard,
        otherPlayerBoard: otherBoard,
        sessionAuthority: useSession ? sessionAuthorityPda : null,
      })
      .rpc();
    debugLog.log("TX", `place_ships SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "place_ships", Date.now() - start);
  }

  async function doSettleGame(): Promise<void> {
    const gs = gameStateRef.current;
    const pda = gamePdaRef.current;
    if (!publicKey || !pda || !gs) return;

    // Use session key for settle (TEE is gasless, session key works with 0 lamports)
    const useSession = sessionKeypairRef.current != null;
    const program = useSession ? sessionTeeProgram() : teeProgram();
    const signerKey = useSession ? sessionKeypairRef.current!.publicKey : publicKey;
    const [leaderboardPda] = getLeaderboardPda();
    const [boardA] = getBoardPda(pda, gs.playerA);
    const [boardB] = getBoardPda(pda, gs.playerB);
    const [sessionAuthorityPda] = getSessionAuthorityPda(pda, publicKey);

    debugLog.log("TX", `settle_game SENDING (${useSession ? "session" : "wallet"})`, { game: pda, program: "TEE" });
    const start = Date.now();
    const sig = await program.methods
      .settleGame()
      .accounts({
        payer: signerKey,
        game: pda,
        leaderboard: leaderboardPda,
        boardA,
        boardB,
        sessionAuthority: useSession ? sessionAuthorityPda : null,
      })
      .rpc();
    debugLog.log("TX", `settle_game SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
    addTxLog(sig, "settle_game", Date.now() - start);

    if (teeRef.current) {
      const teeConn = teeRef.current.getConnection();
      if (teeSubRef.current !== null) {
        teeConn.removeAccountChangeListener(teeSubRef.current);
        teeSubRef.current = null;
      }
      if (teeBoardSubRef.current !== null) {
        teeConn.removeAccountChangeListener(teeBoardSubRef.current);
        teeBoardSubRef.current = null;
      }
    }

    await sleep(3000);
    try {
      const baseP = baseProgram();
      const decoded = await baseP.account.gameState.fetch(pda);
      setGameState(parseGameState(decoded));
      debugLog.log("TX", "settle_game: post-settlement fetch OK");
    } catch {
      debugLog.log("TX", "settle_game: post-settlement fetch not yet available");
    }
  }

  // ── End-game flow: settle → L1 confirm → auto-claim ─────────────────────

  async function runEndGameFlow(): Promise<void> {
    const pda = gamePdaRef.current;
    if (!publicKey || !pda) return;

    // Step 1: Settle
    setEndGameStatus("settling");
    try {
      await doSettleGame();
      debugLog.log("ORCH", "end-game: settle TX sent");
    } catch (e) {
      debugLog.log("ORCH", `end-game: settle failed (may be settled by opponent): ${e}`);
    }

    // Step 2: Wait for L1 confirmation (game account owned by battleship program)
    debugLog.log("ORCH", "end-game: waiting for L1 confirmation");
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const info = await connection.getAccountInfo(pda);
        if (info && info.owner.equals(PROGRAM_ID)) {
          debugLog.log("ORCH", `end-game: L1 confirmed on attempt ${attempt + 1}`);
          break;
        }
      } catch { /* ignore */ }
      if (attempt === 29) {
        debugLog.log("ORCH", "end-game: L1 confirmation timeout (90s), proceeding");
      }
      await sleep(3000);
    }

    // Fetch final game state from base layer
    setEndGameStatus("settled");
    let finalGs: GameStateData | null = null;
    try {
      const baseP = baseProgram();
      const decoded = await baseP.account.gameState.fetch(pda);
      finalGs = parseGameState(decoded);
      setGameState(finalGs);
      debugLog.log("ORCH", `end-game: final state fetched, winner=${pk(finalGs.winner)}`);
    } catch (e) {
      debugLog.error("end-game: failed to fetch final state", e);
      setEndGameStatus("error");
      return;
    }

    // Step 3: Auto-claim (winner only)
    if (!finalGs.hasWinner || !finalGs.winner.equals(publicKey)) {
      debugLog.log("ORCH", "end-game: not the winner, skipping claim");
      setEndGameStatus("claimed");
      return;
    }

    setEndGameStatus("claiming");
    debugLog.log("TX", "end-game: auto-claim starting");

    // Always use wallet for claim_prize (session key has 0 lamports for fees).
    // One wallet popup at game end is acceptable.
    const claimProgram = baseProgram();
    const [profileA] = getProfilePda(finalGs.playerA);
    const [profileB] = getProfilePda(finalGs.playerB);

    try {
      const start = Date.now();
      const sig = await claimProgram.methods
        .claimPrize()
        .accounts({
          winner: publicKey,
          winnerWallet: publicKey,
          game: pda,
          profileA,
          profileB,
          sessionAuthority: null,
        })
        .rpc();

      debugLog.log("TX", `auto-claim SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
      addTxLog(sig, "claim_prize (auto)", Date.now() - start);
      setPrizeClaimed(true);
      setEndGameStatus("claimed");
    } catch (e) {
      debugLog.error("auto-claim failed, manual fallback available", e);
      setEndGameStatus("settled");
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  const createGame = useCallback(
    async (buyInLamports: number, invitedPlayer: string) => {
      if (!publicKey) return;
      setError(null);
      debugLog.log("USER", `createGame buyIn=${buyInLamports} invited=${invitedPlayer || "open"}`);

      if (!Number.isFinite(buyInLamports) || buyInLamports <= 0) {
        setError("Invalid buy-in amount.");
        return;
      }
      if (buyInLamports < MIN_BUY_IN) {
        setError(`Buy-in below minimum (${(MIN_BUY_IN / 1e9).toFixed(3)} SOL).`);
        return;
      }
      if (buyInLamports > MAX_BUY_IN) {
        setError(`Buy-in above maximum (${(MAX_BUY_IN / 1e9).toFixed(0)} SOL).`);
        return;
      }

      resetForNewGame();

      const gameId = new BN(Date.now());
      const [pda] = getGamePda(publicKey, gameId);

      gameIdBnRef.current = gameId;
      gamePdaRef.current = pda;
      playerRoleRef.current = "a";
      pendingBuyInRef.current = buyInLamports;
      pendingInvitedRef.current = invitedPlayer;

      debugLog.log("USER", `createGame: pda=${pk(pda)} gameId=${gameId.toString()}`);
      setGamePda(pda);
    },
    [publicKey],
  );

  const joinGame = useCallback(
    async (gameAddress: string) => {
      if (!publicKey || !signTransaction || !signAllTransactions) return;
      setError(null);
      debugLog.log("USER", `joinGame address=${gameAddress}`);

      try {
        const pda = new PublicKey(gameAddress);

        resetForNewGame();

        gamePdaRef.current = pda;
        playerRoleRef.current = "b";
        setGamePda(pda);

        let decoded;
        try {
          const program = baseProgram();
          debugLog.log("RPC", `fetching game state for ${pk(pda)}`);
          decoded = await program.account.gameState.fetch(pda);
        } catch {
          throw new Error(
            "Game not found. It may have expired or the program was redeployed.",
          );
        }
        const gs = parseGameState(decoded);
        debugLog.log("USER", `joinGame: found game status=${STATUS_NAMES[gs.status]} playerB=${pk(gs.playerB)}`);

        if (
          gs.status === GameStatus.Finished ||
          gs.status === GameStatus.Cancelled ||
          gs.status === GameStatus.TimedOut
        ) {
          throw new Error("Game has already ended.");
        }

        if (gs.status !== GameStatus.WaitingForPlayer) {
          throw new Error("Game is not accepting new players.");
        }
        if (
          !gs.invitedPlayer.equals(PublicKey.default) &&
          !gs.invitedPlayer.equals(publicKey)
        ) {
          throw new Error("You are not invited to this game.");
        }

        gameIdBnRef.current = new BN(gs.gameId.toString());
        setGameState(gs);

        const restored = restoreCommitReveal(pda);
        if (restored) {
          setBoardSalt(restored.salt);
          storedPlacementsRef.current = restored.placements;
        }
      } catch (e) {
        debugLog.error("joinGame failed", e);
        gamePdaRef.current = null;
        playerRoleRef.current = null;
        gameIdBnRef.current = null;
        setGamePda(null);
        setGameState(null);
        setError(toUserError(e));
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

      debugLog.log("USER", `placeShips: ${placements.length} ships, role=${role}`);

      const { hash, salt } = generateBoardHash(placements);
      boardHashRef.current = hash;
      setBoardSalt(salt);
      storedPlacementsRef.current = placements;
      persistCommitReveal(pda, salt, placements);

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
      setSetupError(null);

      await runGameSetup(pda, role, hash);
    },
    [publicKey, signMessage, signTransaction, signAllTransactions, connection],
  );

  const retrySetup = useCallback(async () => {
    const role = playerRoleRef.current;
    const pda = gamePdaRef.current;
    const hash = boardHashRef.current;
    if (!role || !pda || !hash || !publicKey || !signMessage) return;
    debugLog.log("USER", "retrySetup");
    setSetupError(null);
    setSetupStatus("");
    setShipsPlaced(true);
    await runGameSetup(pda, role, hash);
  }, [publicKey, signMessage, signTransaction, signAllTransactions, connection]);

  const fire = useCallback(
    async (row: number, col: number) => {
      if (firingRef.current) return;
      const gs = gameStateRef.current;
      if (!publicKey || !gs || !gamePda) return;

      firingRef.current = true;
      debugLog.log("USER", `fire(${row},${col})`);
      const start = Date.now();
      setLastHit({ row, col });

      try {
        // Use session key if available, fall back to wallet
        const useSession = sessionKeypairRef.current != null;
        const program = useSession ? sessionTeeProgram() : teeProgram();
        const signerKey = useSession ? sessionKeypairRef.current!.publicKey : publicKey;

        // PDAs always derived from WALLET pubkey
        const isA = gs.playerA.equals(publicKey);
        const opponent = isA ? gs.playerB : gs.playerA;
        const [targetBoard] = getBoardPda(gamePda, opponent);
        const [sessionAuthorityPda] = getSessionAuthorityPda(gamePda, publicKey);

        debugLog.log("TX", `fire SENDING row=${row} col=${col} (${useSession ? "session" : "wallet"})`, { signer: signerKey, game: gamePda, targetBoard, program: "TEE" });
        const sig = await program.methods
          .fire(row, col)
          .accounts({
            attacker: signerKey,
            game: gamePda,
            targetBoard,
            sessionAuthority: useSession ? sessionAuthorityPda : null,
          })
          .rpc();

        const latency = Date.now() - start;

        // Fetch updated state (use wallet teeProgram for reads — signer doesn't matter)
        const readProgram = teeProgram();
        const decoded = await readProgram.account.gameState.fetch(gamePda);
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

        debugLog.log("TX", `fire SUCCESS sig=${sig} result=${result ?? "unknown"} latency=${latency}ms`);
        addTxLog(sig, `fire(${row},${col})`, latency, result);
        if (result) {
          setRecentShots(prev => [{ row, col, result, timestamp: Date.now() }, ...prev].slice(0, 3));
          // Play SFX for MY fire result
          if (result === "sunk") getSfx().play("my_sunk");
          else if (result === "hit") getSfx().play("my_hit");
          else if (result === "miss") getSfx().play("my_miss");
        }
        setGameState(updated);
      } catch (e) {
        const errStr = String(e);
        // Session key expired or invalid: clear it and retry with wallet signing
        if (
          sessionKeypairRef.current &&
          (errStr.includes("SessionExpired") ||
           errStr.includes("InvalidSessionKey") ||
           errStr.includes("SessionGameMismatch") ||
           errStr.includes("SessionPlayerMismatch"))
        ) {
          debugLog.log("SESSION", "Session key error in fire, switching to wallet signing");
          sessionKeypairRef.current = null;
          // Release the guard so the recursive retry can acquire it
          firingRef.current = false;
          try {
            await fire(row, col);
          } finally {
            // Prevent the outer finally from redundantly toggling firingRef
            // (the recursive call's own finally already handled it)
            return;
          }
        }
        console.error("fire failed:", e);
        debugLog.error(`fire(${row},${col}) FAILED`, e);
        addTxLog("failed", `fire(${row},${col})`, Date.now() - start);
      } finally {
        firingRef.current = false;
      }
    },
    [publicKey, gamePda, addTxLog],
  );

  const claimTimeout = useCallback(async () => {
    const gs = gameStateRef.current;
    const pda = gamePdaRef.current;
    if (!publicKey || !pda || !gs) return;
    debugLog.log("USER", "claimTimeout");
    const start = Date.now();

    try {
      const program = baseProgram();
      const isPlayerA = gs.playerA.equals(publicKey);
      const opponent = isPlayerA ? gs.playerB : gs.playerA;
      const [claimerProfile] = getProfilePda(publicKey);
      const opponentKey = opponent.equals(PublicKey.default) ? publicKey : opponent;
      const [opponentProfile] = getProfilePda(opponentKey);

      debugLog.log("TX", "claim_timeout SENDING", { claimer: publicKey, game: pda, program: "base" });
      const sig = await program.methods
        .claimTimeout()
        .accounts({
          claimer: publicKey,
          game: pda,
          playerAWallet: gs.playerA,
          playerBWallet: opponent.equals(PublicKey.default) ? publicKey : gs.playerB,
          claimerProfile,
          opponentProfile,
        })
        .rpc();

      debugLog.log("TX", `claim_timeout SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
      addTxLog(sig, "claim_timeout", Date.now() - start);

      try {
        const decoded = await program.account.gameState.fetch(pda);
        setGameState(parseGameState(decoded));
      } catch {
        // State may be delegated — subscription will update
      }
    } catch (e) {
      console.error("claimTimeout failed:", e);
      debugLog.error("claimTimeout FAILED", e);
      setError(toUserError(e));
      addTxLog("failed", "claim_timeout", Date.now() - start);
    }
  }, [publicKey, addTxLog, connection, signTransaction, signAllTransactions]);

  const claimPrize = useCallback(async () => {
    const gs = gameStateRef.current;
    if (!publicKey || !gamePda || !gs) return;
    if (prizeClaimed) return;
    debugLog.log("USER", "claimPrize");
    const start = Date.now();

    try {
      const program = baseProgram();
      const [profileA] = getProfilePda(gs.playerA);
      const [profileB] = getProfilePda(gs.playerB);

      debugLog.log("TX", "claim_prize SENDING", { winner: publicKey, game: gamePda, program: "base" });
      // Always use wallet for claim_prize (session key has 0 lamports for fees)
      const sig = await program.methods
        .claimPrize()
        .accounts({
          winner: publicKey,
          winnerWallet: publicKey,
          game: gamePda,
          profileA,
          profileB,
          sessionAuthority: null,
        })
        .rpc();

      debugLog.log("TX", `claim_prize SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
      setPrizeClaimed(true);
      addTxLog(sig, "claim_prize", Date.now() - start);
    } catch (e) {
      console.error("claimPrize failed:", e);
      debugLog.error("claimPrize FAILED", e);
      addTxLog("failed", "claim_prize", Date.now() - start);
    }
  }, [publicKey, gamePda, prizeClaimed, addTxLog, connection, signTransaction, signAllTransactions]);

  const verifyBoard = useCallback(async () => {
    if (!publicKey || !gamePda || !boardSalt || !storedPlacementsRef.current)
      return;
    debugLog.log("USER", "verifyBoard");
    const start = Date.now();

    const placements = storedPlacementsRef.current.map((p) => ({
      startRow: p.startRow,
      startCol: p.startCol,
      size: p.size,
      horizontal: p.horizontal,
    }));

    // Retry once on "Blockhash not found" (devnet RPC lag)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const program = baseProgram();
        debugLog.log("TX", `verify_board SENDING (attempt ${attempt + 1})`, { verifier: publicKey, game: gamePda });
        const sig = await program.methods
          .verifyBoard(placements, Array.from(boardSalt))
          .accounts({
            verifier: publicKey,
            game: gamePda,
            boardOwner: publicKey,
          })
          .rpc();

        debugLog.log("TX", `verify_board SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
        addTxLog(sig, "verify_board", Date.now() - start);

        try {
          sessionStorage.removeItem(`battleship:${gamePda.toBase58()}`);
          debugLog.log("SESSION", `removed commit-reveal for ${pk(gamePda)}`);
        } catch { /* non-fatal */ }
        return;
      } catch (e) {
        if (String(e).includes("Blockhash not found") && attempt === 0) {
          debugLog.log("TX", "verify_board: Blockhash not found, retrying in 2s");
          await sleep(2000);
          continue;
        }
        console.error("verifyBoard failed:", e);
        debugLog.error("verifyBoard FAILED", e);
        addTxLog("failed", "verify_board", Date.now() - start);
        return;
      }
    }
  }, [publicKey, gamePda, boardSalt, addTxLog, connection, signTransaction, signAllTransactions]);

  // ── Derived values ────────────────────────────────────────────────────────

  const phase: GamePhase = (() => {
    if (!gameState) return gamePda ? "placing" : "lobby";
    switch (gameState.status) {
      case GameStatus.WaitingForPlayer:
      case GameStatus.Placing:
        return "placing";
      case GameStatus.Playing:
        return "playing";
      case GameStatus.Finished:
      case GameStatus.TimedOut:
        return "finished";
      default:
        return "lobby";
    }
  })();

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

  /** Millisecond timestamp when the 5-min inactivity timeout is claimable, or null. */
  const timeoutDeadline: number | null = (() => {
    if (!gameState) return null;
    const s = gameState.status;
    if (
      s === GameStatus.Finished ||
      s === GameStatus.Cancelled ||
      s === GameStatus.TimedOut
    )
      return null;
    return (gameState.lastActionTs + TIMEOUT_SECONDS) * 1000;
  })();

  // ── Return ────────────────────────────────────────────────────────────────

  return {
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
    setupStatus,
    setupError,
    error,
    timeoutDeadline,
    myShipPlacements: storedPlacementsRef.current,
    recentShots,
    endGameStatus,
    createGame,
    joinGame,
    placeShips,
    retrySetup,
    fire,
    claimTimeout,
    claimPrize,
    verifyBoard,
    newGame: resetForNewGame,
    cancelGame: useCallback(async () => {
      const pda = gamePdaRef.current;
      if (!publicKey || !pda) return;
      const role = playerRoleRef.current;
      const gs = gameStateRef.current;

      // Only Player A can cancel, and only in WaitingForPlayer status
      if (role === "a" && gs && gs.status === 0 /* WaitingForPlayer */) {
        try {
          debugLog.log("TX", "cancel_game SENDING", { game: pda });
          const program = baseProgram();
          const [profilePda] = getProfilePda(publicKey);
          const start = Date.now();
          const sig = await program.methods
            .cancelGame()
            .accounts({
              playerA: publicKey,
              game: pda,
              playerProfile: profilePda,
            })
            .rpc();
          debugLog.log("TX", `cancel_game SUCCESS sig=${sig} latency=${Date.now() - start}ms`);
          addTxLog(sig, "cancel_game", Date.now() - start);
        } catch (e) {
          debugLog.error("cancel_game failed (non-fatal, resetting locally)", e);
        }
      }

      resetForNewGame();
    }, [publicKey, addTxLog, connection, signTransaction, signAllTransactions]),
    playerRole: playerRoleRef.current,
    setupInProgress: !!setupStatus && !setupError,
  };
}
