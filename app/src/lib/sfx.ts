/**
 * Sound effects manager for battleship game.
 * Preloads all sounds. Clones on play for overlapping audio.
 * SFX toggle independent from background music.
 */

type SfxName = "my_miss" | "my_hit" | "my_sunk" | "enemy_miss" | "enemy_hit" | "enemy_sunk";

const SFX_PATHS: Record<SfxName, string> = {
  my_miss:    "/assets/sounds/my_miss.mp3",
  my_hit:     "/assets/sounds/my_hit.mp3",
  my_sunk:    "/assets/sounds/my_sunk.mp3",
  enemy_miss: "/assets/sounds/enemy_miss.mp3",
  enemy_hit:  "/assets/sounds/enemy_hit.mp3",
  enemy_sunk: "/assets/sounds/enemy_sunk.mp3",
};

class SfxManager {
  private cache: Map<SfxName, HTMLAudioElement> = new Map();
  private _enabled: boolean = true;
  private _volume: number = 0.6;

  constructor() {
    if (typeof window === "undefined") return;
    this.preload();
    try {
      this._enabled = localStorage.getItem("battleship-sfx") !== "disabled";
    } catch { /* localStorage unavailable */ }
  }

  private preload(): void {
    for (const [name, path] of Object.entries(SFX_PATHS)) {
      try {
        const audio = new Audio(path);
        audio.preload = "auto";
        audio.volume = this._volume;
        this.cache.set(name as SfxName, audio);
      } catch { /* SSR or unsupported */ }
    }
  }

  play(name: SfxName): void {
    if (!this._enabled) return;
    const audio = this.cache.get(name);
    if (!audio) return;
    const clone = audio.cloneNode() as HTMLAudioElement;
    clone.volume = this._volume;
    clone.play().catch(() => { /* silent fail */ });
  }

  get enabled(): boolean { return this._enabled; }

  set enabled(v: boolean) {
    this._enabled = v;
    try { localStorage.setItem("battleship-sfx", v ? "enabled" : "disabled"); } catch {}
  }

  toggle(): boolean {
    this.enabled = !this._enabled;
    return this._enabled;
  }
}

let instance: SfxManager | null = null;
export function getSfx(): SfxManager {
  if (!instance) instance = new SfxManager();
  return instance;
}
export type { SfxName };
