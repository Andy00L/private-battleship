"use client";

import { motion } from "framer-motion";
import { BattleGrid } from "./BattleGrid";
import { formatBuyInDisplay } from "@/lib/oracle";

interface ResultPhaseProps {
  myGrid: number[];
  opponentGrid: number[];
  isWinner: boolean;
  winnerLabel: string;
  potLamports: number;
  solPriceUsd: number;
  onClaimPrize: () => void;
  onVerifyBoard: () => void;
  prizeClaimed: boolean;
}

export function ResultPhase({
  myGrid,
  opponentGrid,
  isWinner,
  winnerLabel,
  potLamports,
  solPriceUsd,
  onClaimPrize,
  onVerifyBoard,
  prizeClaimed,
}: ResultPhaseProps) {
  return (
    <div className="min-h-[calc(100vh-64px)] flex flex-col items-center justify-center gap-8 px-6 py-8">
      {/* GAME OVER label */}
      <p className="text-xs font-mono tracking-[0.3em] text-slate-600 uppercase">
        Game Over
      </p>

      {/* Winner banner */}
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", damping: 15, stiffness: 200 }}
        className="text-center"
      >
        <h2
          className={`text-4xl font-mono font-bold tracking-wider ${
            isWinner
              ? "bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent"
              : "text-red-400"
          }`}
        >
          {isWinner ? "VICTORY" : "DEFEAT"}
        </h2>
        <p className="text-slate-500 mt-2 font-mono text-xs tracking-wider">
          Winner: {winnerLabel}
        </p>
        <p className="text-2xl font-mono text-slate-200 mt-1">
          {formatBuyInDisplay(potLamports, solPriceUsd)}
        </p>
      </motion.div>

      {/* Revealed boards */}
      <div className="flex gap-8 flex-wrap justify-center">
        <div className="flex flex-col items-center gap-3">
          <h3 className="text-xs font-mono tracking-widest text-slate-500 uppercase">
            Your Board
          </h3>
          <div className="bg-[#0f1520]/80 backdrop-blur-md border border-slate-700/30 rounded-xl p-4">
            <BattleGrid grid={myGrid} isOpponent={false} disabled />
          </div>
        </div>
        <div className="flex flex-col items-center gap-3">
          <h3 className="text-xs font-mono tracking-widest text-slate-500 uppercase">
            Opponent Board
          </h3>
          <div className="bg-[#0f1520]/80 backdrop-blur-md border border-slate-700/30 rounded-xl p-4">
            <BattleGrid grid={opponentGrid} isOpponent={false} disabled />
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-4 items-center">
        {isWinner && !prizeClaimed && (
          <motion.button
            onClick={onClaimPrize}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-mono font-semibold h-12 px-8 rounded-lg shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30 transition-all duration-200 tracking-wider text-sm"
          >
            CLAIM PRIZE
          </motion.button>
        )}
        {prizeClaimed && (
          <div className="flex items-center gap-2 px-4 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-emerald-400 font-mono text-xs">
              Prize claimed
            </span>
          </div>
        )}
        <button
          onClick={onVerifyBoard}
          className="bg-transparent border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-400/60 font-mono font-semibold h-12 px-6 rounded-lg transition-all duration-200 tracking-wider text-sm"
        >
          VERIFY BOARD
        </button>
      </div>
    </div>
  );
}
