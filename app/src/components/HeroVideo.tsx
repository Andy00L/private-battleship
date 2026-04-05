"use client";

// Zero hooks. HTML video with autoPlay/loop/muted/playsInline handles itself.
// prefers-reduced-motion is handled via CSS (hidden, not JS-paused).

export function HeroVideo() {
  return (
    <>
      <video
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover pointer-events-none motion-reduce:hidden"
      >
        <source src="/hero-bg.mp4" type="video/mp4" />
      </video>
      {/* Dark gradient overlay for text readability over bright video frames */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-black/60 to-black/80 pointer-events-none"
      />
    </>
  );
}
