"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { useGame } from "@/hooks/useGame";
import { GameLobby } from "@/components/GameLobby";
import { HeroVideo } from "@/components/HeroVideo";
import { PlacementPhase } from "@/components/PlacementPhase";
import { BattlePhase } from "@/components/BattlePhase";
import { ResultPhase } from "@/components/ResultPhase";

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

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-800/60 shadow-[0_1px_0_rgba(34,211,238,0.05)]">
        <h1 className="text-lg font-mono font-semibold tracking-wider">
          <span className="text-cyan-400">PRIVATE</span>{" "}
          <span className="text-slate-300">BATTLESHIP</span>
        </h1>
        <div className="flex items-center gap-4">
          {game.gamePda && (
            <span
              className="bg-slate-800/50 px-3 py-1 rounded-full text-xs font-mono text-slate-500 border border-slate-700/30 cursor-pointer hover:border-cyan-400/50 hover:text-slate-400 transition-colors"
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
        <div className="mx-6 mt-3 px-4 py-2.5 bg-red-950/40 border border-red-800/30 rounded-lg">
          <p className="text-red-400 font-mono text-xs">{game.error}</p>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1">
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
            opponentGrid={game.opponentHits}
            isWinner={game.isWinner}
            winnerLabel={
              game.gameState?.hasWinner
                ? game.gameState.winner.toBase58().slice(0, 8) + "..."
                : "None"
            }
            potLamports={game.gameState?.potLamports ?? 0}
            solPriceUsd={0}
            onClaimPrize={game.claimPrize}
            onVerifyBoard={game.verifyBoard}
            onNewGame={game.newGame}
            prizeClaimed={game.prizeClaimed}
            myShipPlacements={game.myShipPlacements}
            endGameStatus={game.endGameStatus}
          />
        )}
      </main>
    </div>
  );
}
