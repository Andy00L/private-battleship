"use client";

import { useState } from "react";
import { debugLog } from "@/lib/debug-logger";

export function DebugLogButton() {
  const [count, setCount] = useState(0);

  if (!debugLog.isEnabled()) return null;

  return (
    <button
      onClick={() => {
        debugLog.download();
        setCount(debugLog.getLogCount());
      }}
      onMouseEnter={() => setCount(debugLog.getLogCount())}
      className="fixed bottom-4 left-4 z-50 bg-yellow-600 text-black text-xs font-mono px-3 py-1.5 rounded shadow-lg hover:bg-yellow-500 transition-colors"
    >
      Download Log ({count})
    </button>
  );
}
