"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { useGame } from "@/hooks/useGame";
import { getSolPriceUsd } from "@/lib/oracle";
import { GameLobby } from "@/components/GameLobby";
import { HeroVideo } from "@/components/HeroVideo";
import { PlacementPhase } from "@/components/PlacementPhase";
import { BattlePhase } from "@/components/BattlePhase";
import { ResultPhase } from "@/components/ResultPhase";
import { GameBackground } from "@/components/GameBackground";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton,
    ),
  { ssr: false },
);

export default function Home() {
  const { publicKey } = useWallet();
  const game = useGame();
  const [copied, setCopied] = useState(false);
  const [solPriceUsd, setSolPriceUsd] = useState(0);

  useEffect(() => {
    getSolPriceUsd().then(setSolPriceUsd);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="glass-panel-strong fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-3" style={{ borderRadius: 0, borderTop: "none", borderLeft: "none", borderRight: "none", borderBottom: "1px solid rgba(6,182,212,0.1)" }}>
        <h1 className="text-game-heading text-xl font-mono tracking-[0.15em]">
          <span className="text-cyan-400">PRIVATE</span>{" "}
          <span className="text-white">BATTLESHIP</span>
        </h1>
        <div className="flex items-center gap-4">
          {game.gamePda && (
            <span
              className="glass-panel px-3 py-1.5 text-xs font-mono text-slate-400 cursor-pointer hover:text-cyan-400 transition-colors"
              style={{ borderRadius: 20 }}
              onClick={() => {
                navigator.clipboard.writeText(game.gamePda!.toBase58());
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied!" : `${game.gamePda.toBase58().slice(0, 8)}...`}
            </span>
          )}
          <WalletMultiButton />
        </div>
      </header>

      {/* Error banner */}
      {game.error && (
        <div className="fixed top-16 left-6 right-6 z-[60] px-4 py-2.5 bg-red-950/90 border border-red-800/30 rounded-lg backdrop-blur-sm">
          <p className="text-red-400 font-mono text-xs">{game.error}</p>
        </div>
      )}

      {/* Game background video (placement, battle, result phases) */}
      {game.phase !== "lobby" && <GameBackground />}

      {/* Main content */}
      <main className="flex-1 text-game pt-14">
        {game.phase === "lobby" && (
          <div className="relative overflow-hidden">
            <HeroVideo />
            <div className="relative z-10">
              <GameLobby
                walletConnected={!!publicKey}
                onCreateGame={game.createGame}
                onJoinGame={game.joinGame}
              />
            </div>
          </div>
        )}

        {game.phase === "placing" && (
          <PlacementPhase
            onConfirm={game.placeShips}
            confirmed={game.shipsPlaced}
            setupStatus={game.setupStatus}
            setupError={game.setupError}
            onRetrySetup={game.retrySetup}
            timeoutDeadline={game.timeoutDeadline}
            onClaimTimeout={game.claimTimeout}
            onBack={game.cancelGame}
            canCancel={game.playerRole === "a" && (!game.gameState || game.gameState.status === 0)}
            setupInProgress={game.setupInProgress}
          />
        )}

        {game.phase === "playing" && (
          <BattlePhase
            myGrid={game.myGrid}
            opponentHits={game.opponentHits}
            isMyTurn={game.isMyTurn}
            shipsRemainingMe={game.shipsRemainingMe}
            shipsRemainingOpponent={game.shipsRemainingOpponent}
            lastHit={game.lastHit}
            txLog={game.txLog}
            onFire={game.fire}
            disabled={!game.isMyTurn}
            timeoutDeadline={game.timeoutDeadline}
            onClaimTimeout={game.claimTimeout}
            myShipPlacements={game.myShipPlacements}
            recentShots={game.recentShots}
          />
        )}

        {game.phase === "finished" && (
          <ResultPhase
            myGrid={game.myGrid}
            opponentGrid={game.opponentRevealedGrid ?? game.opponentHits}
            isWinner={game.isWinner}
            winnerLabel={
              game.gameState?.hasWinner
                ? game.gameState.winner.toBase58().slice(0, 8) + "..."
                : "None"
            }
            potLamports={game.gameState?.potLamports ?? 0}
            buyInLamports={game.gameState?.buyInLamports ?? 0}
            solPriceUsd={solPriceUsd}
            onClaimPrize={game.claimPrize}
            onVerifyBoard={game.verifyBoard}
            onNewGame={game.newGame}
            prizeClaimed={game.prizeClaimed}
            myShipPlacements={game.myShipPlacements}
            opponentShipPlacements={game.opponentShipPlacements}
            endGameStatus={game.endGameStatus}
          />
        )}
      </main>
    </div>
  );
}
