"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { BattleGrid } from "./BattleGrid";

function TimeoutCountdown({ deadline, onClaim }: { deadline: number; onClaim: () => void }) {
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

  return (
    <div className="mt-2 flex flex-col items-center gap-1.5">
      <p className="text-slate-500 font-mono text-[10px]">
        {expired ? "Opponent timed out" : `Timeout in ${m}:${s.toString().padStart(2, "0")}`}
      </p>
      {expired && (
        <button
          onClick={onClaim}
          className="px-4 py-1.5 bg-orange-500/20 border border-orange-500/40 text-orange-400 hover:bg-orange-500/30 rounded-lg font-mono text-xs transition-all"
        >
          CLAIM TIMEOUT
        </button>
      )}
    </div>
  );
}

const SHIP_SIZES = [3, 2, 2, 1, 1] as const;
const SHIP_NAMES = ["Cruiser", "Destroyer", "Destroyer", "Scout", "Scout"];

interface ShipToPlace {
  size: number;
  placed: boolean;
  startRow: number;
  startCol: number;
  horizontal: boolean;
}

interface PlacementPhaseProps {
  onConfirm: (
    placements: {
      startRow: number;
      startCol: number;
      size: number;
      horizontal: boolean;
    }[],
  ) => void;
  confirmed: boolean;
  setupStatus?: string;
  setupError?: string | null;
  onRetrySetup?: () => void;
  timeoutDeadline?: number | null;
  onClaimTimeout?: () => void;
}

function canPlace(
  grid: number[],
  row: number,
  col: number,
  size: number,
  horizontal: boolean,
): boolean {
  for (let i = 0; i < size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    if (r >= 6 || c >= 6) return false;
    if (grid[r * 6 + c] !== 0) return false;
  }
  return true;
}

export function PlacementPhase({ onConfirm, confirmed, setupStatus, setupError, onRetrySetup, timeoutDeadline, onClaimTimeout }: PlacementPhaseProps) {
  const [ships, setShips] = useState<ShipToPlace[]>(
    SHIP_SIZES.map((size) => ({
      size,
      placed: false,
      startRow: 0,
      startCol: 0,
      horizontal: true,
    })),
  );
  const [selectedShip, setSelectedShip] = useState(0);
  const [horizontal, setHorizontal] = useState(true);
  const [grid, setGrid] = useState<number[]>(new Array(36).fill(0));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "r" || e.key === "R") setHorizontal((h) => !h);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (confirmed) return;
      const ship = ships[selectedShip];
      if (!ship || ship.placed) return;
      if (!canPlace(grid, row, col, ship.size, horizontal)) return;

      const newGrid = [...grid];
      for (let i = 0; i < ship.size; i++) {
        const r = horizontal ? row : row + i;
        const c = horizontal ? col + i : col;
        newGrid[r * 6 + c] = 1;
      }
      setGrid(newGrid);

      const newShips = [...ships];
      newShips[selectedShip] = {
        ...ship,
        placed: true,
        startRow: row,
        startCol: col,
        horizontal,
      };
      setShips(newShips);

      const next = newShips.findIndex((s) => !s.placed);
      if (next !== -1) setSelectedShip(next);
    },
    [grid, ships, selectedShip, horizontal, confirmed],
  );

  const handleReset = () => {
    setGrid(new Array(36).fill(0));
    setShips(
      SHIP_SIZES.map((size) => ({
        size,
        placed: false,
        startRow: 0,
        startCol: 0,
        horizontal: true,
      })),
    );
    setSelectedShip(0);
  };

  const allPlaced = ships.every((s) => s.placed);

  // Convert placed ships to the format BattleGrid expects for multi-cell rendering
  const placedShipPlacements = ships
    .filter((s) => s.placed)
    .map((s) => ({
      startRow: s.startRow,
      startCol: s.startCol,
      size: s.size,
      horizontal: s.horizontal,
    }));

  const handleConfirm = () => {
    if (!allPlaced) return;
    onConfirm(
      ships.map((s) => ({
        startRow: s.startRow,
        startCol: s.startCol,
        size: s.size,
        horizontal: s.horizontal,
      })),
    );
  };

  return (
    <div className="min-h-[calc(100vh-56px)] flex flex-col items-center justify-center gap-8 px-8 py-8">
      <div>
        <p className="text-game-label text-center mb-1">
          Deployment Phase
        </p>
        <h2 className="text-game-heading text-2xl font-mono text-white text-center tracking-wider">
          PLACE YOUR SHIPS
        </h2>
      </div>

      <div className="flex gap-10 items-start">
        {/* Grid */}
        <div className="glass-panel p-6">
          <BattleGrid
            grid={grid}
            isOpponent={false}
            onCellClick={handleCellClick}
            disabled={confirmed}
            shipPlacements={placedShipPlacements}
          />
        </div>

        {/* Ship palette */}
        <div className="glass-panel p-6 min-w-[220px] space-y-4">
          <h3 className="flex items-center gap-2 text-xs font-mono tracking-widest text-slate-500 uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
            Fleet Roster
          </h3>

          <div className="space-y-2">
            {ships.map((ship, i) => (
              <button
                key={i}
                onClick={() => !ship.placed && setSelectedShip(i)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm font-mono transition-all duration-200 ${
                  ship.placed
                    ? "border-emerald-800/40 text-emerald-600/60"
                    : i === selectedShip
                      ? "border-cyan-500/50 text-cyan-400 bg-cyan-950/20 shadow-[0_0_12px_rgba(34,211,238,0.08)]"
                      : "border-slate-700/30 text-slate-400 hover:border-slate-600/40"
                }`}
                disabled={ship.placed || confirmed}
              >
                <span className="flex gap-0.5">
                  {Array.from({ length: ship.size }).map((_, j) => (
                    <span
                      key={j}
                      className={`w-3.5 h-3.5 rounded-sm ${
                        ship.placed
                          ? "bg-emerald-700/50"
                          : i === selectedShip
                            ? "bg-cyan-500/60"
                            : "bg-slate-600/50"
                      }`}
                    />
                  ))}
                </span>
                <span className="text-xs">
                  {SHIP_NAMES[i]} ({ship.size})
                </span>
                {ship.placed && (
                  <span className="ml-auto text-emerald-500 text-xs">
                    &#10003;
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="border-t border-slate-700/20 pt-3 space-y-2">
            <button
              onClick={() => setHorizontal((h) => !h)}
              className="w-full h-10 border border-slate-700/30 rounded-lg text-xs font-mono text-slate-400 hover:border-slate-600/40 transition-all"
              disabled={confirmed}
            >
              {horizontal ? "HORIZONTAL" : "VERTICAL"}{" "}
              <span className="text-slate-600">/ R to rotate</span>
            </button>

            <button
              onClick={handleReset}
              className="w-full h-10 border border-slate-700/30 rounded-lg text-xs font-mono text-slate-600 hover:text-slate-400 transition-all"
              disabled={confirmed}
            >
              RESET ALL
            </button>
          </div>

          {allPlaced && !confirmed && (
            <button onClick={handleConfirm} className="btn-primary w-full">
              CONFIRM PLACEMENT
            </button>
          )}
          {!allPlaced && !confirmed && (
            <p className="text-[10px] font-mono text-slate-600 text-center">
              Place all 5 ships to continue
            </p>
          )}
          {confirmed && (
            <div className="flex flex-col items-center gap-2 justify-center py-2">
              {setupError ? (
                <>
                  <p className="text-red-400 font-mono text-xs text-center">
                    {setupError}
                  </p>
                  {onRetrySetup && (
                    <button
                      onClick={onRetrySetup}
                      className="mt-1 px-4 py-1.5 border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 rounded-lg font-mono text-xs transition-all"
                    >
                      RETRY
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <p className="text-emerald-400 font-mono text-xs text-center">
                    {setupStatus || "Deployed. Awaiting opponent..."}
                  </p>
                  {timeoutDeadline && onClaimTimeout && (
                    <TimeoutCountdown deadline={timeoutDeadline} onClaim={onClaimTimeout} />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
