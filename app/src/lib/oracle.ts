import { Connection, PublicKey } from "@solana/web3.js";

// Replace with actual MagicBlock Oracle price account address once available
const ORACLE_PRICE_ACCOUNT_ADDRESS =
  "11111111111111111111111111111111"; // System program as placeholder

export async function getSolPriceUsd(
  _connection: Connection,
): Promise<number> {
  // Oracle integration pending — returns 0 until price account is configured.
  // Avoids wasting an RPC call on the placeholder system program address.
  return 0;
}

export function formatBuyInDisplay(
  lamports: number,
  solPriceUsd: number,
): string {
  const sol = lamports / 1_000_000_000;
  if (solPriceUsd > 0) {
    const usd = (sol * solPriceUsd).toFixed(2);
    return `${sol} SOL (~$${usd})`;
  }
  return `${sol} SOL`;
}
