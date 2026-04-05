"use client";

import { useState, useEffect, useRef } from "react";
import { BattleGrid } from "./BattleGrid";
import { TransactionLog, type TxEntry } from "./TransactionLog";

interface ShipPlacement {
  startRow: number;
  startCol: number;
  size: number;
  horizontal: boolean;
}

interface BattlePhaseProps {
  myGrid: number[];
  opponentHits: number[];
  isMyTurn: boolean;
  shipsRemainingMe: number;
  shipsRemainingOpponent: number;
  lastHit: { row: number; col: number } | null;
  txLog: TxEntry[];
  onFire: (row: number, col: number) => void;
  disabled: boolean;
  timeoutDeadline?: number | null;
  onClaimTimeout?: () => void;
  myShipPlacements?: ShipPlacement[] | null;
  recentShots?: { row: number; col: number; result: "hit" | "miss" | "sunk"; timestamp: number }[];
}

function ShipDots({ count, max }: { count: number; max: number }) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: max }).map((_, i) => (
        <span
          key={i}
          className={`w-2 h-2 rounded-full transition-colors ${
            i < count ? "bg-emerald-400" : "bg-slate-700/40"
          }`}
        />
      ))}
    </div>
  );
}

function TimeoutBar({ deadline, onClaim }: { deadline: number; onClaim: () => void }) {
  const [now, setNow] = useState(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const secsLeft = Math.max(0, Math.floor((deadline - now) / 1000));
  const m = Math.floor(secsLeft / 60);
  const s = secsLeft % 60;
  const expired = secsLeft === 0;

  if (!expired) {
    return (
      <p className="text-slate-600 font-mono text-[10px] text-center">
        Timeout in {m}:{s.toString().padStart(2, "0")}
      </p>
    );
  }

  return (
    <button
      onClick={onClaim}
      className="px-4 py-1.5 bg-orange-500/20 border border-orange-500/40 text-orange-400 hover:bg-orange-500/30 rounded-lg font-mono text-xs transition-all"
    >
      CLAIM TIMEOUT
    </button>
  );
}

export function BattlePhase({
  myGrid,
  opponentHits,
  isMyTurn,
  shipsRemainingMe,
  shipsRemainingOpponent,
  lastHit,
  txLog,
  onFire,
  disabled,
  timeoutDeadline,
  onClaimTimeout,
  myShipPlacements,
  recentShots,
}: BattlePhaseProps) {
  return (
    <div className="flex gap-6 px-6 py-8 items-start justify-center flex-wrap xl:flex-nowrap">
      {/* Left: My fleet */}
      <div className="flex flex-col items-center gap-3">
        <h3 className="text-game-label">
          Your Fleet
        </h3>
        <div className="glass-panel p-5">
          <BattleGrid grid={myGrid} isOpponent={false} disabled shipPlacements={myShipPlacements} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-600 uppercase">
            Ships
          </span>
          <ShipDots count={shipsRemainingMe} max={5} />
        </div>
      </div>

      {/* Center: Turn indicator */}
      <div className="flex flex-col items-center justify-center min-h-[380px] gap-4 px-4">
        {isMyTurn ? (
          <div className="px-5 py-2.5 border border-cyan-500/50 rounded-lg font-mono text-cyan-400 text-sm tracking-wider shadow-[0_0_20px_rgba(34,211,238,0.15)] animate-pulse">
            YOUR TURN
          </div>
        ) : (
          <div className="px-5 py-2.5 border border-slate-700/30 rounded-lg font-mono text-slate-600 text-sm tracking-wider">
            OPPONENT&apos;S TURN
          </div>
        )}
        <div className="w-px h-8 bg-slate-700/30" />
        <div className="text-[10px] font-mono text-slate-700 tracking-widest">
          VS
        </div>
        {timeoutDeadline && onClaimTimeout && (
          <div className="mt-4">
            <TimeoutBar deadline={timeoutDeadline} onClaim={onClaimTimeout} />
          </div>
        )}
      </div>

      {/* Right: Enemy waters */}
      <div className="flex flex-col items-center gap-3">
        <h3 className="text-game-label">
          Enemy Waters
        </h3>
        <div className="glass-panel p-5">
          <BattleGrid
            grid={opponentHits}
            isOpponent
            onCellClick={onFire}
            disabled={disabled || !isMyTurn}
            lastHit={lastHit}
            recentShots={recentShots}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-600 uppercase">
            Ships
          </span>
          <ShipDots count={shipsRemainingOpponent} max={5} />
        </div>
      </div>

      {/* Transaction log */}
      <TransactionLog entries={txLog} />
    </div>
  );
}
