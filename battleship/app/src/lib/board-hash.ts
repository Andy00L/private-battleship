import { sha256 } from "@noble/hashes/sha256";

interface ShipPlacement {
  startRow: number;
  startCol: number;
  size: number;
  horizontal: boolean;
}

export function generateBoardHash(placements: ShipPlacement[]): {
  hash: Uint8Array;
  salt: Uint8Array;
} {
  // Generate random salt
  const salt = crypto.getRandomValues(new Uint8Array(32));

  // Serialize placements deterministically
  const shipBytes = new Uint8Array(placements.length * 4);
  placements.forEach((p, i) => {
    shipBytes[i * 4] = p.startRow;
    shipBytes[i * 4 + 1] = p.startCol;
    shipBytes[i * 4 + 2] = p.size;
    shipBytes[i * 4 + 3] = p.horizontal ? 1 : 0;
  });

  // Hash: SHA256(ships || salt)
  const combined = new Uint8Array(shipBytes.length + salt.length);
  combined.set(shipBytes);
  combined.set(salt, shipBytes.length);

  const hash = sha256(combined);

  // IMPORTANT: store salt locally. You need it for verify_board later.
  // Do NOT send salt to the chain until post-game verification.
  return { hash: new Uint8Array(hash), salt };
}
