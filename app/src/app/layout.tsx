import type { Metadata } from "next";
import { IBM_Plex_Mono, DM_Sans } from "next/font/google";
import { SolanaProviders } from "@/components/wallet-provider";
import { DebugLogButton } from "@/components/DebugLogButton";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Private Battleship",
  description:
    "Fully onchain Battleship on Solana. Your opponent cannot see your ships.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body
        className="min-h-full flex flex-col font-sans antialiased"
        style={{ backgroundColor: "#070a0f", color: "#e2e8f0" }}
      >
        <SolanaProviders>
          {children}
          <DebugLogButton />
        </SolanaProviders>
      </body>
    </html>
  );
}
