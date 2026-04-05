"use client";

import { useRef, useState, useCallback, useEffect } from "react";

export function GameBackground() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMuted, setIsMuted] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("battleship-audio") !== "unmuted";
    }
    return true;
  });
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  // Release 31MB video buffer on unmount
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      }
    };
  }, []);

  // Respect prefers-reduced-motion
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      videoRef.current?.pause();
      setVideoFailed(true);
    }
  }, []);

  const toggleAudio = useCallback(() => {
    if (videoRef.current) {
      const newMuted = !videoRef.current.muted;
      videoRef.current.muted = newMuted;
      setIsMuted(newMuted);
      localStorage.setItem("battleship-audio", newMuted ? "muted" : "unmuted");
    }
  }, []);

  return (
    <>
      {/* Video layer (z -2) */}
      {!videoFailed && (
        <video
          ref={videoRef}
          className="fixed inset-0 w-full h-full object-cover"
          style={{
            zIndex: -2,
            willChange: "transform",
            transform: "translateZ(0)",
            opacity: videoReady ? 1 : 0,
            transition: "opacity 0.6s ease-in",
          }}
          autoPlay
          muted={isMuted}
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          onCanPlay={() => setVideoReady(true)}
          onError={() => setVideoFailed(true)}
        >
          <source src="/assets/game-bg.mp4" type="video/mp4" />
        </video>
      )}

      {/* Gradient fallback (always present behind video, visible when video not ready or failed) */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          zIndex: -3,
          background: "radial-gradient(ellipse at center, #0a1628 0%, #050d1a 50%, #020409 100%)",
        }}
        aria-hidden="true"
      />

      {/* Dark overlay for readability (z -1) */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          zIndex: -1,
          background: "linear-gradient(to bottom, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.72) 50%, rgba(0,0,0,0.82) 100%)",
        }}
        aria-hidden="true"
      />

      {/* Audio toggle (bottom-right, above debug button which is bottom-left) */}
      <button
        onClick={toggleAudio}
        className="fixed bottom-4 right-4 z-50 p-2.5 rounded-full bg-black/50 hover:bg-black/70 text-white/60 hover:text-white transition-all duration-200 backdrop-blur-sm border border-white/10 hover:border-white/20"
        aria-label={isMuted ? "Unmute background audio" : "Mute background audio"}
        title={isMuted ? "Unmute" : "Mute"}
      >
        {isMuted ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M19.07 4.93a10 10 0 010 14.14" />
            <path d="M15.54 8.46a5 5 0 010 7.07" />
          </svg>
        )}
      </button>
    </>
  );
}
