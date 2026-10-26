/**
 * The alert sounds a kitchen or rider board can play for a new order —
 * shared between `kitchen-alert.tsx` and `rider-alert.tsx`, and between the
 * live boards and the admin Settings "Test" button.
 *
 * Presets are synthesized with the Web Audio API rather than shipped as audio
 * files: no asset to host, cache, or ever 404 on — see the reasoning this
 * carries over from the original vendor-only chime. A custom upload is the
 * escape hatch for an operator who wants something specific; presets are
 * what every fresh install gets for free.
 */

export type AlertPreset = "siren" | "chime" | "beep" | "alarm" | "bell";

export const ALERT_PRESETS: { id: AlertPreset; label: string }[] = [
  { id: "siren", label: "Siren" },
  { id: "chime", label: "Two-tone chime" },
  { id: "beep", label: "Triple beep" },
  { id: "alarm", label: "Rising alarm" },
  { id: "bell", label: "Soft bell" },
];

function tone(
  ctx: AudioContext,
  start: number,
  freq: number,
  durationS: number,
  peakGain = 0.35
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationS);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + durationS + 0.02);
}

/** The original vendor chime: a rising pair, reads as a summons over kitchen noise. */
function playChime(ctx: AudioContext) {
  const now = ctx.currentTime;
  for (const [i, freq] of [880, 1318.5].entries()) {
    tone(ctx, now + i * 0.18, freq, 0.34);
  }
}

/** Three short, even beeps — an appliance-style alert. */
function playBeep(ctx: AudioContext) {
  const now = ctx.currentTime;
  for (let i = 0; i < 3; i++) {
    tone(ctx, now + i * 0.16, 1000, 0.11);
  }
}

/** A climbing four-note run — the most urgent of the set. */
function playAlarm(ctx: AudioContext) {
  const now = ctx.currentTime;
  for (const [i, freq] of [660, 784, 932, 1108].entries()) {
    tone(ctx, now + i * 0.11, freq, 0.16, 0.3);
  }
}

/**
 * A siren wail: one pitch sweeping 650 → 1450 → 650 Hz, twice — the same sound
 * the rider and Partner apps ring with (`res/raw/deligro_ring.wav`,
 * scripts/make-siren-wav.py). A square wave through a low-pass keeps the hard
 * electronic edge without the fizz.
 */
function playSiren(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = "square";
  filter.type = "lowpass";
  filter.frequency.value = 3000;
  const cycle = 1.0;
  for (let i = 0; i < 2; i++) {
    const t = now + i * cycle;
    osc.frequency.setValueAtTime(650, t);
    osc.frequency.linearRampToValueAtTime(1450, t + cycle / 2);
    osc.frequency.linearRampToValueAtTime(650, t + cycle);
  }
  const end = now + 2 * cycle;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.03);
  gain.gain.setValueAtTime(0.18, end - 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(filter).connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(end + 0.02);
}

/** One long, soft note — the quietest option. */
function playBell(ctx: AudioContext) {
  tone(ctx, ctx.currentTime, 987.8, 0.9, 0.22);
}

const PRESET_PLAYERS: Record<AlertPreset, (ctx: AudioContext) => void> = {
  siren: playSiren,
  chime: playChime,
  beep: playBeep,
  alarm: playAlarm,
  bell: playBell,
};

/** Unknown/legacy values fall back to the original chime rather than staying silent. */
function playPreset(ctx: AudioContext, preset: string): void {
  (PRESET_PLAYERS[preset as AlertPreset] ?? playChime)(ctx);
}

/**
 * Play a board's configured alert: the uploaded custom sound if one is set,
 * otherwise the chosen preset. A custom file that fails to load or play
 * (deleted from storage, a network blip) falls back to the preset rather than
 * leaving the alert silent — the one thing this control must never do.
 */
export function playAlertSound(
  ctx: AudioContext,
  preset: string,
  url?: string | null
): void {
  if (!url) {
    playPreset(ctx, preset);
    return;
  }
  const audio = new Audio(url);
  audio.play().catch(() => playPreset(ctx, preset));
}
