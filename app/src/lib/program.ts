import { PublicKey, type Connection } from "@solana/web3.js";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import type { BN } from "@coral-xyz/anchor";
import {
  permissionPdaFromAccount,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import idlJson from "./idl.json";

// ── Program addresses ───────────────────────────────────────────────────────

export const PROGRAM_ID = new PublicKey(
  "9DiCaM3ugtjo1f3xoCpG7Nxij112Qc9znVfjQvT6KHRR",
);
export const PERMISSION_PROGRAM_ID = new PublicKey(
  "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1",
);
export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);
export const TEE_VALIDATOR = new PublicKey(
  "FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA",
);
export const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111",
);
export const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111",
);
export const VRF_PROGRAM_ID = new PublicKey(
  "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz",
);
export const ORACLE_QUEUE = new PublicKey(
  "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh",
);
export const SLOT_HASHES = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111",
);

// ── Seeds ───────────────────────────────────────────────────────────────────

const GAME_SEED = Buffer.from("game");
const BOARD_SEED = Buffer.from("board");
const PROFILE_SEED = Buffer.from("profile");
const LEADERBOARD_SEED = Buffer.from("leaderboard");
const IDENTITY_SEED = Buffer.from("identity");
const SESSION_SEED = Buffer.from("session");

// ── PDA derivation (battleship program) ─────────────────────────────────────

export function getGamePda(
  playerA: PublicKey,
  gameId: BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [GAME_SEED, playerA.toBuffer(), gameId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  );
}

export function getBoardPda(
  game: PublicKey,
  player: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BOARD_SEED, game.toBuffer(), player.toBuffer()],
    PROGRAM_ID,
  );
}

export function getProfilePda(player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PROFILE_SEED, player.toBuffer()],
    PROGRAM_ID,
  );
}

export function getLeaderboardPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([LEADERBOARD_SEED], PROGRAM_ID);
}

export function getProgramIdentityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([IDENTITY_SEED], PROGRAM_ID);
}

export function getSessionAuthorityPda(
  game: PublicKey,
  player: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, game.toBuffer(), player.toBuffer()],
    PROGRAM_ID,
  );
}

// ── PDA derivation (MagicBlock SDK) ─────────────────────────────────────────

export const getPermissionPda = permissionPdaFromAccount;
export const getDelegationRecordPda = delegationRecordPdaFromDelegatedAccount;
export const getDelegationMetadataPda =
  delegationMetadataPdaFromDelegatedAccount;
export const getDelegationBufferPda =
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram;

// ── Anchor program factory ──────────────────────────────────────────────────

export interface AnchorWallet {
  publicKey: PublicKey;
  signTransaction(tx: any): Promise<any>;
  signAllTransactions(txs: any[]): Promise<any[]>;
}

/**
 * Returns an untyped Anchor Program instance. Without generated IDL types,
 * the Program generic causes "excessively deep" recursion in method chains.
 * Callers access .methods / .account dynamically via the IDL at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProgram(conn: Connection, wallet: AnchorWallet): any {
  const provider = new AnchorProvider(conn, wallet as any, {
    commitment: "confirmed",
  });
  return new Program(idlJson as any, provider);
}
