"use client";

import { motion, AnimatePresence } from "framer-motion";

interface GridProps {
  grid: number[];
  isOpponent: boolean;
  onCellClick?: (row: number, col: number) => void;
  disabled?: boolean;
  lastHit?: { row: number; col: number } | null;
}

const COL_LABELS = ["1", "2", "3", "4", "5", "6"];
const ROW_LABELS = ["A", "B", "C", "D", "E", "F"];

function getCellState(cell: number, isOpponent: boolean): string {
  if (cell === 2) return "hit";
  if (cell === 3) return "miss";
  if (cell === 1 && !isOpponent) return "ship";
  return "water";
}

const CELL_STYLES: Record<string, string> = {
  hit: "bg-red-500/80 border-red-500/60 shadow-[inset_0_0_12px_rgba(239,68,68,0.3)]",
  miss: "bg-sky-900/30 border-sky-700/30",
  ship: "bg-slate-600/40 border-slate-500/40",
  water:
    "bg-[#0c1018] border-slate-700/20 hover:border-cyan-500/50 hover:bg-slate-800/40",
};

export function BattleGrid({
  grid,
  isOpponent,
  onCellClick,
  disabled,
  lastHit,
}: GridProps) {
  return (
    <div className="inline-block">
      {/* Column labels */}
      <div className="flex ml-8">
        {COL_LABELS.map((l) => (
          <div
            key={l}
            className="w-14 text-center text-[10px] font-mono text-slate-600 pb-1"
          >
            {l}
          </div>
        ))}
      </div>

      <div className="flex">
        {/* Row labels */}
        <div className="flex flex-col">
          {ROW_LABELS.map((l) => (
            <div
              key={l}
              className="h-14 w-8 flex items-center justify-center text-[10px] font-mono text-slate-600"
            >
              {l}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-6 gap-1.5">
          {grid.map((cell, i) => {
            const row = Math.floor(i / 6);
            const col = i % 6;
            const state = getCellState(cell, isOpponent);
            const isLastHit = lastHit?.row === row && lastHit?.col === col;
            const clickable = !!onCellClick && state === "water" && !disabled;

            return (
              <motion.button
                key={i}
                className={`
                  w-14 h-14 rounded-md border transition-all duration-150
                  flex items-center justify-center
                  ${CELL_STYLES[state]}
                  ${clickable ? (isOpponent ? "cursor-crosshair" : "cursor-pointer") : "cursor-default"}
                  ${disabled ? "opacity-50" : ""}
                `}
                onClick={() => clickable && onCellClick?.(row, col)}
                whileHover={clickable ? { scale: 1.08 } : {}}
                whileTap={clickable ? { scale: 0.92 } : {}}
                disabled={!clickable}
              >
                {state === "hit" && (
                  <span className="text-red-300 text-lg">&#10005;</span>
                )}
                {state === "miss" && (
                  <span className="w-2 h-2 rounded-full bg-sky-600/60" />
                )}
                <AnimatePresence>
                  {isLastHit && state === "hit" && (
                    <motion.div
                      initial={{ scale: 0, opacity: 0 }}
                      animate={{ scale: 1.5, opacity: 1 }}
                      exit={{ scale: 2, opacity: 0 }}
                      className="absolute w-full h-full rounded-md bg-orange-400/40"
                      transition={{ duration: 0.4 }}
                    />
                  )}
                </AnimatePresence>
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
