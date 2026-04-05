"use client";

import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ShipPlacement {
  startRow: number;
  startCol: number;
  size: number;
  horizontal: boolean;
}

interface RecentShot {
  row: number;
  col: number;
  result: "hit" | "miss" | "sunk";
  timestamp: number;
}

interface GridProps {
  grid: number[];
  isOpponent: boolean;
  onCellClick?: (row: number, col: number) => void;
  disabled?: boolean;
  lastHit?: { row: number; col: number } | null;
  shipPlacements?: ShipPlacement[] | null;
  recentShots?: RecentShot[];
}

// ── Ship cell map ──────────────────────────────────────────────────────────────

interface ShipCellInfo {
  isStart: boolean;
  size: number;
  horizontal: boolean;
}

function buildShipCellMap(
  placements: ShipPlacement[],
): Map<string, ShipCellInfo> {
  const map = new Map<string, ShipCellInfo>();
  for (const ship of placements) {
    for (let i = 0; i < ship.size; i++) {
      const r = ship.horizontal ? ship.startRow : ship.startRow + i;
      const c = ship.horizontal ? ship.startCol + i : ship.startCol;
      map.set(`${r},${c}`, {
        isStart: i === 0,
        size: ship.size,
        horizontal: ship.horizontal,
      });
    }
  }
  return map;
}

// ── Layout constants (rem) ─────────────────────────────────────────────────────

const CELL_REM = 3.5; // w-14
const GAP_REM = 0.375; // gap-1.5

/** Width/height for a ship spanning N cells including gaps. */
function shipSpanRem(n: number): string {
  return `${n * CELL_REM + (n - 1) * GAP_REM}rem`;
}

// ── Grid constants ─────────────────────────────────────────────────────────────

const COL_LABELS = ["1", "2", "3", "4", "5", "6"];
const ROW_LABELS = ["A", "B", "C", "D", "E", "F"];

function getCellState(cell: number, isOpponent: boolean): string {
  if (cell === 2) return "hit";
  if (cell === 3) return "miss";
  if (cell === 1 && !isOpponent) return "ship";
  return "water";
}

const CELL_STYLES: Record<string, string> = {
  hit: "bg-red-500/20 border-red-500/40 shadow-[inset_0_0_12px_rgba(239,68,68,0.15)]",
  miss: "bg-sky-900/20 border-sky-700/25",
  ship: "bg-slate-600/10 border-slate-500/20",
  water: "bg-[#0c1018] border-slate-700/20",
};

// ── Component ──────────────────────────────────────────────────────────────────

const SHOT_COLORS: Record<string, string> = {
  hit: "249,115,22",   // orange-500
  miss: "6,182,212",   // cyan-500
  sunk: "239,68,68",   // red-500
};
const SHOT_BORDER = [2, 1.5, 1];     // px per recency index
const SHOT_OPACITY = [1.0, 0.55, 0.25]; // per recency index

export function BattleGrid({
  grid,
  isOpponent,
  onCellClick,
  disabled,
  lastHit,
  shipPlacements,
  recentShots,
}: GridProps) {
  const shipMap = useMemo(
    () =>
      shipPlacements && shipPlacements.length > 0
        ? buildShipCellMap(shipPlacements)
        : null,
    [shipPlacements],
  );

  return (
    <div className="inline-block">
      {/* Keyframes for recent shot fade (CSS-only, no JS timers) */}
      <style>{`
        @keyframes recentShotFade {
          0% { opacity: var(--rs-opacity); }
          60% { opacity: calc(var(--rs-opacity) * 0.4); }
          100% { opacity: 0; }
        }
      `}</style>

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
            const clickable =
              !!onCellClick && state === "water" && !disabled;

            // Ship cell info (only when placements available)
            const shipInfo = shipMap?.get(`${row},${col}`) ?? null;
            const isShipStart = shipInfo?.isStart === true;
            const isMultiCellStart =
              isShipStart && shipInfo!.size > 1;

            return (
              <motion.button
                key={i}
                className={`
                  group relative w-14 h-14 rounded-md border transition-all duration-150
                  flex items-center justify-center
                  ${isMultiCellStart ? "overflow-visible" : "overflow-hidden"}
                  ${CELL_STYLES[state]}
                  ${clickable ? "cursor-crosshair hover:border-cyan-500/50 hover:bg-slate-800/30" : "cursor-default"}
                  ${disabled ? "opacity-50" : ""}
                `}
                onClick={() => clickable && onCellClick?.(row, col)}
                whileHover={clickable ? { scale: 1.08 } : {}}
                whileTap={clickable ? { scale: 0.92 } : {}}
                disabled={!clickable}
              >
                {/* ── Ship SVG layer (z-10) ── */}

                {/* Multi-cell horizontal ship */}
                {isMultiCellStart && shipInfo!.horizontal && (
                  <div
                    className="absolute top-0 left-0 pointer-events-none"
                    style={{
                      width: shipSpanRem(shipInfo!.size),
                      height: `${CELL_REM}rem`,
                      zIndex: 10,
                    }}
                  >
                    {/*
                     * object-fit: cover maintains the SVG's native aspect ratio
                     * and fills the container. The gap between cells makes the
                     * container ~5-7% wider than the SVG ratio. Cover clips
                     * ~2px of sky/water at top/bottom instead of stretching.
                     */}
                    <img
                      src={`/assets/ship-${shipInfo!.size}.svg`}
                      alt=""
                      aria-hidden="true"
                      className="w-full h-full object-cover opacity-70"
                    />
                  </div>
                )}

                {/* Multi-cell vertical ship: rotate the wrapper, img stays simple */}
                {isMultiCellStart && !shipInfo!.horizontal && (
                  <div
                    className="absolute top-0 left-0 pointer-events-none"
                    style={{
                      width: shipSpanRem(shipInfo!.size),
                      height: `${CELL_REM}rem`,
                      transformOrigin: "0 0",
                      transform: `translateX(${CELL_REM}rem) rotate(90deg) translateZ(0)`,
                      willChange: "transform",
                      backfaceVisibility: "hidden",
                      zIndex: 10,
                    }}
                  >
                    <img
                      src={`/assets/ship-${shipInfo!.size}.svg`}
                      alt=""
                      aria-hidden="true"
                      className="w-full h-full object-cover opacity-70"
                    />
                  </div>
                )}

                {/* Single-cell ship (size 1) */}
                {isShipStart && shipInfo!.size === 1 && (
                  <img
                    src="/assets/ship-1.svg"
                    alt=""
                    aria-hidden="true"
                    className="w-9 h-9 object-contain opacity-70"
                    style={{ zIndex: 10 }}
                  />
                )}

                {/* Fallback: ship cell with no placement data */}
                {state === "ship" && !shipMap && (
                  <img
                    src="/assets/ship-1.svg"
                    alt=""
                    aria-hidden="true"
                    className="w-9 h-9 object-contain opacity-70"
                    style={{ zIndex: 10 }}
                  />
                )}

                {/* ── Hit/miss SVG layer (z-20, on top of ship) ── */}

                {state === "hit" && (
                  <img
                    src="/assets/hit.svg"
                    alt=""
                    aria-hidden="true"
                    className="relative w-10 h-10 object-contain"
                    style={{ zIndex: 20 }}
                  />
                )}

                {state === "miss" && (
                  <img
                    src="/assets/miss.svg"
                    alt=""
                    aria-hidden="true"
                    className="relative w-8 h-8 object-contain opacity-70"
                    style={{ zIndex: 20 }}
                  />
                )}

                {/* ── Crosshair layer (z-30, hover only) ── */}
                {clickable && isOpponent && (
                  <img
                    src="/assets/crosshair.svg"
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 m-auto w-8 h-8 object-contain opacity-0 group-hover:opacity-80 transition-opacity duration-150 pointer-events-none"
                    style={{ zIndex: 30 }}
                  />
                )}

                {/* ── Recent shot border (z-35, CSS fade) ── */}
                {(() => {
                  if (!recentShots) return null;
                  const idx = recentShots.findIndex(s => s.row === row && s.col === col);
                  if (idx < 0) return null;
                  const shot = recentShots[idx];
                  const rgb = SHOT_COLORS[shot.result] ?? SHOT_COLORS.hit;
                  return (
                    <div
                      key={shot.timestamp}
                      className="absolute inset-0 rounded-md pointer-events-none"
                      style={{
                        boxShadow: `inset 0 0 0 ${SHOT_BORDER[idx]}px rgba(${rgb},0.9), 0 0 8px 1px rgba(${rgb},0.3)`,
                        zIndex: 35,
                        // CSS custom property drives the keyframe start opacity
                        // @ts-expect-error -- CSS custom properties
                        "--rs-opacity": SHOT_OPACITY[idx],
                        animation: `recentShotFade 5s ease-out forwards`,
                      }}
                    />
                  );
                })()}

                {/* ── Last-hit animation (z-40) ── */}
                <AnimatePresence>
                  {isLastHit && state === "hit" && (
                    <motion.div
                      initial={{ scale: 0, opacity: 0 }}
                      animate={{ scale: 1.5, opacity: 1 }}
                      exit={{ scale: 2, opacity: 0 }}
                      className="absolute w-full h-full rounded-md bg-orange-400/40"
                      style={{ zIndex: 40 }}
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
