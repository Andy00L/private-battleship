import { Connection, PublicKey } from "@solana/web3.js";

const ORACLE_PRICE_ACCOUNT = new PublicKey(
  "ORACLE_PRICE_ACCOUNT_ADDRESS" // Replace with actual MagicBlock Oracle price account
);

export async function getSolPriceUsd(
  connection: Connection,
): Promise<number> {
  const info = await connection.getAccountInfo(ORACLE_PRICE_ACCOUNT);
  if (!info) return 0;
  // Parse MagicBlock Oracle price account format
  // Return price in USD with 2 decimal precision
  const price = 0; // TODO: parse from info.data once Oracle account format is documented
  return price;
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
