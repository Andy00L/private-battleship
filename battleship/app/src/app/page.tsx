"use client";

import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton,
    ),
  { ssr: false },
);

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-8 p-8">
      <h1 className="text-5xl font-bold tracking-tight font-mono">
        <span className="text-cyan-400">PRIVATE</span>{" "}
        <span className="text-slate-200">BATTLESHIP</span>
      </h1>
      <p className="text-slate-400 text-lg max-w-md text-center">
        Fully onchain. Nobody can see your ships. Not your opponent, not
        validators, not blockchain explorers.
      </p>
      <WalletMultiButton />
    </main>
  );
}
