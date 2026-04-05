import { Connection, PublicKey } from "@solana/web3.js";

const TEE_RPC = "https://devnet.magicblock.app";
const SOL_USD_FEED = new PublicKey(
  "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
);

// PriceUpdateV2 byte offsets (Anchor discriminator 8 + write_authority 32 +
// verification_level 1 + feed_id 32 = 73 for price start)
const PRICE_OFFSET = 73;
const EXPONENT_OFFSET = 89; // price(8) + conf(8) + offset 73
const PUBLISH_TIME_OFFSET = 93; // exponent(4) + offset 89

// Cache to avoid spamming TEE RPC
let cachedPrice: number = 0;
let lastFetchMs: number = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Fetch SOL/USD price from MagicBlock's real-time pricing oracle.
 * Returns 0 if the oracle is unreachable or data is stale.
 */
export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();

  if (cachedPrice > 0 && now - lastFetchMs < CACHE_TTL_MS) {
    return cachedPrice;
  }

  try {
    const connection = new Connection(TEE_RPC, "confirmed");
    const accountInfo = await connection.getAccountInfo(SOL_USD_FEED);

    if (!accountInfo?.data) {
      console.warn("Oracle: account not found");
      return cachedPrice;
    }

    const data = accountInfo.data;

    const price = Number(data.readBigInt64LE(PRICE_OFFSET));
    const rawExponent = data.readInt32LE(EXPONENT_OFFSET);
    const publishTime = Number(data.readBigInt64LE(PUBLISH_TIME_OFFSET));

    // Staleness check: reject prices older than 5 minutes
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - publishTime > 300) {
      console.warn("Oracle: price is stale", { publishTime, nowSec });
      return cachedPrice;
    }

    // MagicBlock stores exponent as positive (8); standard Pyth uses negative (-8).
    // Both mean "multiply by 10^-8". Handle either convention.
    const exponent = rawExponent > 0 ? -rawExponent : rawExponent;
    const usdPrice = price * Math.pow(10, exponent);

    // Sanity check
    if (usdPrice < 1 || usdPrice > 10_000) {
      console.warn("Oracle: price out of range", usdPrice);
      return cachedPrice;
    }

    cachedPrice = usdPrice;
    lastFetchMs = now;
    return usdPrice;
  } catch (err) {
    console.warn("Oracle: fetch failed", err);
    return cachedPrice;
  }
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
