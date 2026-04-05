"use client";

import { motion } from "framer-motion";
import { BattleGrid } from "./BattleGrid";
import { formatBuyInDisplay } from "@/lib/oracle";

interface ShipPlacement {
  startRow: number;
  startCol: number;
  size: number;
  horizontal: boolean;
}

type EndGameStatus = "none" | "settling" | "settled" | "claiming" | "claimed" | "error";

interface ResultPhaseProps {
  myGrid: number[];
  opponentGrid: number[];
  isWinner: boolean;
  winnerLabel: string;
  potLamports: number;
  solPriceUsd: number;
  onClaimPrize: () => void;
  onVerifyBoard: () => void;
  onNewGame: () => void;
  prizeClaimed: boolean;
  myShipPlacements?: ShipPlacement[] | null;
  endGameStatus: EndGameStatus;
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
  onNewGame,
  prizeClaimed,
  myShipPlacements,
  endGameStatus,
}: ResultPhaseProps) {
  const isSettling = endGameStatus === "settling" || endGameStatus === "none";
  const isClaiming = endGameStatus === "claiming";
  const isDone = endGameStatus === "claimed" || prizeClaimed;
  const showManualClaim = endGameStatus === "settled" && isWinner && !prizeClaimed;

  return (
    <div className="min-h-[calc(100vh-64px)] flex flex-col items-center justify-center gap-8 px-6 py-8">
      {/* Settling / claiming spinner */}
      {(isSettling || isClaiming) && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
          <p className="text-slate-400 font-mono text-sm tracking-wider">
            {isSettling ? "SETTLING GAME..." : "CLAIMING PRIZE..."}
          </p>
          <p className="text-slate-600 font-mono text-[10px]">
            {isSettling
              ? "Committing state to Solana (30-40s on devnet)"
              : "Sending prize to your wallet"}
          </p>
        </div>
      )}

      {/* Final result (after settle + claim done) */}
      {(isDone || showManualClaim || endGameStatus === "error") && (
        <>
          <p className="text-xs font-mono tracking-[0.3em] text-slate-600 uppercase">
            Game Over
          </p>

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
                <BattleGrid grid={myGrid} isOpponent={false} disabled shipPlacements={myShipPlacements} />
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
          <div className="flex gap-4 items-center flex-wrap justify-center">
            {/* Manual claim fallback (only if auto-claim failed and player is winner) */}
            {showManualClaim && (
              <motion.button
                onClick={onClaimPrize}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-mono font-semibold h-12 px-8 rounded-lg shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30 transition-all duration-200 tracking-wider text-sm"
              >
                CLAIM PRIZE
              </motion.button>
            )}

            {isDone && isWinner && (
              <div className="flex items-center gap-2 px-4 py-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-emerald-400 font-mono text-xs">Prize claimed</span>
              </div>
            )}

            {endGameStatus === "error" && (
              <p className="text-red-400 font-mono text-xs">
                Settlement error. Try claiming manually.
              </p>
            )}

            <button
              onClick={onVerifyBoard}
              className="bg-transparent border border-slate-700/30 text-slate-500 hover:text-cyan-400 hover:border-cyan-500/40 font-mono h-10 px-5 rounded-lg transition-all duration-200 text-xs tracking-wider"
            >
              VERIFY BOARD
            </button>

            <motion.button
              onClick={onNewGame}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className="bg-transparent border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 font-mono font-semibold h-12 px-8 rounded-lg transition-all duration-200 tracking-wider text-sm"
            >
              NEW GAME
            </motion.button>
          </div>
        </>
      )}
    </div>
  );
}
