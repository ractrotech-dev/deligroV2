// Renders the new-order ring the Android RingService loops: the website's
// "chime" preset (src/lib/alerts/tones.ts — 880 Hz then 1318.5 Hz, 0.18 s
// apart, 0.34 s each, exponential attack/decay) followed by a short gap.
//   node apps/rider/tool/ring_sound.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;
const LOOP_S = 1.1; // chime + silence, then the service loops it
const samples = new Float32Array(Math.round(RATE * LOOP_S));

function tone(start, freq, dur, peak = 0.6) {
  const s0 = Math.round(start * RATE);
  const n = Math.round((dur + 0.02) * RATE);
  for (let i = 0; i < n && s0 + i < samples.length; i++) {
    const t = i / RATE;
    // 0.0001 → peak in 20 ms, then → 0.0001 by `dur` (WebAudio exponential ramps)
    const env =
      t < 0.02
        ? 0.0001 * Math.pow(peak / 0.0001, t / 0.02)
        : t < dur
          ? peak * Math.pow(0.0001 / peak, (t - 0.02) / (dur - 0.02))
          : 0;
    samples[s0 + i] += env * Math.sin(2 * Math.PI * freq * t);
  }
}

tone(0, 880, 0.34);
tone(0.18, 1318.5, 0.34);

const pcm = Buffer.alloc(samples.length * 2);
samples.forEach((v, i) => pcm.writeInt16LE(Math.max(-1, Math.min(1, v)) * 32767, i * 2));
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "android", "app", "src", "main", "res", "raw", "deligro_ring.wav");
writeFileSync(out, Buffer.concat([header, pcm]));
console.log("wrote", out, `${(pcm.length / 1024).toFixed(0)} KB`);
