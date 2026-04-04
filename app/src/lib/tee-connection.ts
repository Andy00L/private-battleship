import {
  verifyTeeRpcIntegrity,
  getAuthToken,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

type AuthToken = { token: string; expiresAt: number };

const TEE_URL = "https://tee.magicblock.app";
const TEE_WS = "wss://tee.magicblock.app";
const REFRESH_INTERVAL_MS = 240_000; // 4 min (assuming 5 min expiry)

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
    // Verify TEE hardware attestation
    const isVerified = await verifyTeeRpcIntegrity(TEE_URL);
    if (!isVerified) {
      throw new Error(
        "TEE attestation failed. Cannot establish secure connection.",
      );
    }

    await this.refresh();

    // Auto-refresh before expiry
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        console.error("TEE token refresh failed:", err);
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
