const DEBUG_ENABLED = process.env.NEXT_PUBLIC_DEBUG_LOG === "true";

type LogCategory =
  | "TX"
  | "STATE"
  | "ORCH"
  | "SUB"
  | "RPC"
  | "WALLET"
  | "TEE"
  | "USER"
  | "ERROR"
  | "POLL"
  | "SESSION";

class DebugLogger {
  private logs: string[] = [];
  private sessionId: string;

  constructor() {
    this.sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  }

  log(
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!DEBUG_ENABLED) return;
    const timestamp = new Date().toISOString();
    const dataStr = data ? " " + JSON.stringify(data, this.replacer, 0) : "";
    const line = `[${timestamp}] [${category}] ${message}${dataStr}`;
    this.logs.push(line);
    console.debug(line);
  }

  error(message: string, err: unknown): void {
    if (!DEBUG_ENABLED) return;
    const timestamp = new Date().toISOString();
    const errStr =
      err instanceof Error
        ? `${err.message}\n${err.stack}`
        : String(err);
    const line = `[${timestamp}] [ERROR] ${message}: ${errStr}`;
    this.logs.push(line);
    console.debug(line);
  }

  download(): void {
    const content = this.logs.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `battleship-debug-${this.sessionId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  isEnabled(): boolean {
    return DEBUG_ENABLED;
  }

  getLogCount(): number {
    return this.logs.length;
  }

  private replacer(_key: string, value: unknown): unknown {
    if (value && typeof value === "object" && "toBase58" in value) {
      return (value as { toBase58(): string }).toBase58();
    }
    if (
      value &&
      typeof value === "object" &&
      "toString" in value &&
      value.constructor?.name === "BN"
    ) {
      return (value as { toString(): string }).toString();
    }
    if (value instanceof Uint8Array) {
      return `Uint8Array(${value.length})`;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  }
}

export const debugLog = new DebugLogger();
