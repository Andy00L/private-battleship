"use client";

import { useState, useEffect } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { getSolPriceUsd, formatBuyInDisplay } from "@/lib/oracle";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton,
    ),
  { ssr: false },
);

interface GameLobbyProps {
  walletConnected: boolean;
  onCreateGame: (buyInLamports: number, invitedPlayer: string) => void;
  onJoinGame: (gameAddress: string) => void;
}

export function GameLobby({
  walletConnected,
  onCreateGame,
  onJoinGame,
}: GameLobbyProps) {
  const { connection } = useConnection();
  const [buyInSol, setBuyInSol] = useState("0.01");
  const [invitedPlayer, setInvitedPlayer] = useState("");
  const [joinAddress, setJoinAddress] = useState("");
  const [solPriceUsd, setSolPriceUsd] = useState(0);

  useEffect(() => {
    getSolPriceUsd(connection).then(setSolPriceUsd);
  }, [connection]);

  const buyInLamports = Math.round(
    parseFloat(buyInSol || "0") * 1_000_000_000,
  );

  if (!walletConnected) {
    return (
      <div className="min-h-[calc(100vh-56px)] flex flex-col items-center justify-center gap-6">
        <p className="text-game-label tracking-[0.2em]">
          Naval Command System
        </p>
        <h2 className="text-game-heading text-3xl font-mono text-white">
          Connect wallet to deploy
        </h2>
        <WalletMultiButton />
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-6 py-12">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-3xl w-full">
        {/* Create Game */}
        <div className="glass-panel p-6 space-y-6 hover:border-[rgba(100,180,255,0.2)] transition-all duration-200">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            <h3 className="text-xs font-mono tracking-widest text-slate-400 uppercase">
              Create Game
            </h3>
          </div>

          <div>
            <label className="text-xs font-mono tracking-wider text-slate-500 uppercase block mb-2">
              Buy-in
            </label>
            <input
              type="number"
              step="0.001"
              min="0.001"
              max="100"
              value={buyInSol}
              onChange={(e) => setBuyInSol(e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700/40 rounded-lg h-12 px-4 text-xl text-slate-100 font-mono focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/20 focus:outline-none"
            />
            <p className="text-xs text-slate-500 mt-1.5 font-mono">
              {formatBuyInDisplay(buyInLamports, solPriceUsd)}
            </p>
          </div>

          <div className="border-t border-slate-700/20 pt-4">
            <label className="text-xs font-mono tracking-wider text-slate-500 uppercase block mb-2">
              Invite Player (optional)
            </label>
            <input
              type="text"
              placeholder="Pubkey or leave empty for open lobby"
              value={invitedPlayer}
              onChange={(e) => setInvitedPlayer(e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700/40 rounded-lg h-12 px-4 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/20 focus:outline-none"
            />
          </div>

          <button
            onClick={() => onCreateGame(buyInLamports, invitedPlayer)}
            className="btn-primary w-full"
          >
            CREATE GAME
          </button>
        </div>

        {/* Join Game */}
        <div className="glass-panel p-6 space-y-6 hover:border-[rgba(100,180,255,0.2)] transition-all duration-200">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
            <h3 className="text-xs font-mono tracking-widest text-slate-400 uppercase">
              Join Game
            </h3>
          </div>

          <div>
            <label className="text-xs font-mono tracking-wider text-slate-500 uppercase block mb-2">
              Game Address
            </label>
            <input
              type="text"
              placeholder="Paste game address"
              value={joinAddress}
              onChange={(e) => setJoinAddress(e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700/40 rounded-lg h-12 px-4 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/20 focus:outline-none"
            />
          </div>

          <button
            onClick={() => joinAddress && onJoinGame(joinAddress)}
            disabled={!joinAddress}
            className="btn-secondary w-full disabled:opacity-30 disabled:cursor-not-allowed"
          >
            JOIN GAME
          </button>
        </div>
      </div>
    </div>
  );
}
