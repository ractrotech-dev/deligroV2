"""Synthesise a loopable siren (wail) as 16-bit mono 44.1 kHz WAV.

One 2 s cycle: pitch sweeps 650 -> 1450 -> 650 Hz on a sine LFO. The carrier
completes a whole number of cycles over the file, so it loops without a click.
Odd harmonics give it the hard edge of an electronic siren.
"""
import math, struct, sys, wave

RATE = 44100
SECONDS = 2.0
CENTER, DEPTH = 1050.0, 400.0  # Hz
N = int(RATE * SECONDS)

def sample(phase):
    # fundamental + 3rd + 5th, softly: square-ish but not harsh
    return (math.sin(phase) + 0.33 * math.sin(3 * phase) + 0.15 * math.sin(5 * phase)) / 1.48

frames = bytearray()
phase = 0.0
for i in range(N):
    t = i / RATE
    # LFO starts at its lowest point so the loop seam sits on the low note
    f = CENTER - DEPTH * math.cos(2 * math.pi * t / SECONDS)
    phase += 2 * math.pi * f / RATE
    v = 0.85 * sample(phase)
    frames += struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))

for out in sys.argv[1:]:
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))
    print("wrote", out)
