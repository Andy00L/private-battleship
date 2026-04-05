"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => {
    const custom = process.env.NEXT_PUBLIC_RPC_URL;
    if (!custom || custom.trim() === "") {
      return clusterApiUrl("devnet");
    }
    try {
      new URL(custom);
      return custom;
    } catch {
      console.error(`Invalid NEXT_PUBLIC_RPC_URL: "${custom}". Falling back to public devnet.`);
      return clusterApiUrl("devnet");
    }
  }, []);
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
