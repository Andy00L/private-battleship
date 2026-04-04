"use client";

import { BattleGrid } from "./BattleGrid";
import { TransactionLog, type TxEntry } from "./TransactionLog";

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
}: BattlePhaseProps) {
  return (
    <div className="flex gap-6 px-6 py-8 items-start justify-center flex-wrap xl:flex-nowrap">
      {/* Left: My fleet */}
      <div className="flex flex-col items-center gap-3">
        <h3 className="text-xs font-mono tracking-widest text-slate-500 uppercase">
          Your Fleet
        </h3>
        <div className="bg-[#0f1520]/80 backdrop-blur-md border border-slate-700/30 rounded-xl p-4">
          <BattleGrid grid={myGrid} isOpponent={false} disabled />
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
      </div>

      {/* Right: Enemy waters */}
      <div className="flex flex-col items-center gap-3">
        <h3 className="text-xs font-mono tracking-widest text-slate-500 uppercase">
          Enemy Waters
        </h3>
        <div className="bg-[#0f1520]/80 backdrop-blur-md border border-slate-700/30 rounded-xl p-4">
          <BattleGrid
            grid={opponentHits}
            isOpponent
            onCellClick={onFire}
            disabled={disabled || !isMyTurn}
            lastHit={lastHit}
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
