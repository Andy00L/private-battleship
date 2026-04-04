"use client";

import { motion } from "framer-motion";

export interface TxEntry {
  sig: string;
  action: string;
  latencyMs: number;
  timestamp: number;
  result?: "hit" | "miss" | "sunk";
}

const RESULT_BORDER: Record<string, string> = {
  hit: "border-l-red-500",
  miss: "border-l-sky-600",
  sunk: "border-l-orange-400",
};

export function TransactionLog({ entries }: { entries: TxEntry[] }) {
  return (
    <div className="w-72 max-h-[480px] overflow-y-auto bg-[#0f1520]/80 backdrop-blur-md rounded-xl p-4 font-mono text-xs border border-slate-700/30">
      <h3 className="flex items-center gap-2 text-cyan-400/80 mb-4 text-xs tracking-widest uppercase">
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
        ONCHAIN TX LOG
      </h3>
      <div className="space-y-1">
        {entries.map((tx) => (
          <motion.div
            key={tx.sig}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className={`flex items-center gap-2 py-1.5 px-2 rounded border-l-2 ${
              tx.result
                ? RESULT_BORDER[tx.result] || "border-l-emerald-500"
                : "border-l-emerald-500/40"
            }`}
          >
            <span className="text-slate-700 w-14 shrink-0">
              {new Date(tx.timestamp).toLocaleTimeString("en", {
                hour12: false,
              })}
            </span>
            <span
              className={`truncate ${
                tx.result === "hit"
                  ? "text-red-400"
                  : tx.result === "miss"
                    ? "text-sky-500"
                    : tx.result === "sunk"
                      ? "text-orange-400 font-semibold"
                      : "text-emerald-400"
              }`}
            >
              {tx.action}
            </span>
            <span className="text-slate-700 ml-auto shrink-0">
              {tx.latencyMs}ms
            </span>
          </motion.div>
        ))}
        {entries.length === 0 && (
          <p className="text-slate-700 text-center py-4">
            No transactions yet
          </p>
        )}
      </div>
    </div>
  );
}
