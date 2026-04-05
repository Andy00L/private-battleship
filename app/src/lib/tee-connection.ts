import {
  verifyTeeRpcIntegrity,
  getAuthToken,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { debugLog } from "./debug-logger";

type AuthToken = { token: string; expiresAt: number };

const TEE_URL = "https://tee.magicblock.app";
const TEE_WS = "wss://tee.magicblock.app";
const REFRESH_INTERVAL_MS = 240_000; // 4 min (assuming 5 min expiry)
const TPM_MAX_RETRIES = 3;

export class TeeConnectionManager {
  private token: AuthToken | null = null;
  private connection: Connection | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private wallet: {
    publicKey: PublicKey;
    signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
  };

  constructor(wallet: typeof this.wallet) {
    this.wallet = wallet;
  }

  async init(): Promise<Connection> {
    // Verify TEE hardware attestation with retry + backoff
    let tpmVerified = false;
    for (let attempt = 1; attempt <= TPM_MAX_RETRIES; attempt++) {
      try {
        const isVerified = await verifyTeeRpcIntegrity(TEE_URL);
        if (isVerified) {
          tpmVerified = true;
          debugLog.log("TEE", `TPM attestation passed on attempt ${attempt}`);
          break;
        }
      } catch (e) {
        debugLog.log("TEE", `TPM attestation attempt ${attempt}/${TPM_MAX_RETRIES} failed: ${e}`);
      }
      if (attempt < TPM_MAX_RETRIES) {
        const delayMs = 2000 * attempt;
        debugLog.log("TEE", `Retrying attestation in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (!tpmVerified) {
      // Default TEE endpoint is devnet. Anything else is treated as mainnet (strict).
      const teeUrl: string = TEE_URL;
      const isDevnet =
        teeUrl === "https://tee.magicblock.app" ||
        teeUrl.includes("devnet");

      if (isDevnet) {
        debugLog.log(
          "TEE",
          "TPM attestation failed after retries. Proceeding without attestation (devnet only). Auth token + TLS still active.",
        );
      } else {
        throw new Error(
          "TEE attestation failed after 3 retries. Cannot establish secure connection on mainnet.",
        );
      }
    }

    // Auth token is always required (provides HTTP authentication)
    await this.refresh();

    // Auto-refresh before expiry
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        console.error("TEE token refresh failed:", err);
        debugLog.log("TEE", `Token refresh failed: ${err}`);
      });
    }, REFRESH_INTERVAL_MS);

    return this.connection!;
  }

  private async refresh(): Promise<void> {
    this.token = await getAuthToken(
      TEE_URL,
      this.wallet.publicKey,
      (message: Uint8Array) => this.wallet.signMessage(message),
    );

    this.connection = new Connection(`${TEE_URL}?token=${this.token.token}`, {
      wsEndpoint: `${TEE_WS}?token=${this.token.token}`,
      commitment: "confirmed",
    });
  }

  getConnection(): Connection {
    if (!this.connection) throw new Error("TEE connection not initialized");
    return this.connection;
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.connection = null;
    this.token = null;
  }
}
