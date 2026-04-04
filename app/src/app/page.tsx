"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { useGame } from "@/hooks/useGame";
import { GameLobby } from "@/components/GameLobby";
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
            <span className="bg-slate-800/50 px-3 py-1 rounded-full text-xs font-mono text-slate-500 border border-slate-700/30">
              {game.gamePda.toBase58().slice(0, 8)}...
            </span>
          )}
          <WalletMultiButton />
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1">
        {game.phase === "lobby" && (
          <GameLobby
            walletConnected={!!publicKey}
            onCreateGame={game.createGame}
            onJoinGame={game.joinGame}
          />
        )}

        {game.phase === "placing" && (
          <PlacementPhase
            onConfirm={game.placeShips}
            confirmed={game.shipsPlaced}
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
            disabled={false}
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
            prizeClaimed={game.prizeClaimed}
          />
        )}
      </main>
    </div>
  );
}
