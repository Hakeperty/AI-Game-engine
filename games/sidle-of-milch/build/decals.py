"""
Grime decal textures (PNG with alpha) for the Resident Evil-style decay of the cabin:
water_stain, mold, drips, floor_stain, drag. Procedural, so they tile nowhere and never repeat exactly.

    tools/tts/.venv/Scripts/python.exe games/sidle-of-milch/build/decals.py
"""

import os

import numpy as np
from PIL import Image, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "textures", "decals")
N = 512
rng = np.random.default_rng(7)


def noise(scale: int, octaves: int = 4) -> np.ndarray:
    """Smooth value noise in 0..1."""
    out = np.zeros((N, N))
    amp, total = 1.0, 0.0
    for o in range(octaves):
        s = max(2, scale * 2**o)
        g = rng.random((s + 1, s + 1))
        img = Image.fromarray((g * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC)
        out += np.asarray(img, dtype=float) / 255 * amp
        total += amp
        amp *= 0.5
    return out / total


yy, xx = np.mgrid[0:N, 0:N] / N - 0.5
radius = np.sqrt(xx**2 + yy**2) * 2


def save(name: str, rgb: tuple, alpha: np.ndarray, rgb_var: np.ndarray | None = None):
    a = np.clip(alpha, 0, 1)
    img = np.zeros((N, N, 4), dtype=np.uint8)
    var = rgb_var if rgb_var is not None else np.ones((N, N))
    for k in range(3):
        img[..., k] = np.clip(rgb[k] * var, 0, 255)
    img[..., 3] = (a * 255).astype(np.uint8)
    Image.fromarray(img, "RGBA").filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(OUT, f"{name}.png"))


os.makedirs(OUT, exist_ok=True)
n = noise(3)
edge = np.clip(1 - (radius + (n - 0.5) * 0.6), 0, 1)

# water stain: pale brown fill with darker tide-mark rings where the water dried
rings = 0.5 + 0.5 * np.sin((radius + (noise(5) - 0.5) * 0.9) * 13)
tide = np.clip((rings - 0.86) * 5, 0, 1) * (edge > 0.05) * (0.4 + noise(7) * 0.9)
# on dark wood a dried water stain shows as a darker patch ringed by pale mineral tide marks
save("water_stain", (80, 66, 48), np.clip(edge * 0.6 + tide * 0.25, 0, 0.85), 0.5 + tide * 0.55 + 0.25 * noise(8))

# mold: dense, clustered black-green blotches that fade out at the edges
spots = noise(10, 3)
mold = np.clip((spots - 0.52) * 6, 0, 1) * np.clip(edge * 1.8, 0, 1)
save("mold", (28, 34, 22), mold * 0.95, 0.7 + 0.6 * noise(16))

# drips: vertical grime streaks running down from the top
streak_x = noise(24, 2)[0:1, :].repeat(N, axis=0)
streaks = np.clip((streak_x - 0.55) * 5, 0, 1)
fall = np.clip(1 - (yy + 0.5) * (0.6 + noise(6) * 0.8), 0, 1)
save("drips", (22, 17, 12), np.clip(streaks * fall * 1.1 * np.clip(1 - np.abs(xx) * 1.6, 0, 1), 0, 0.95), 0.8 + 0.4 * noise(12))

# floor stain: a dark dried spill with a slightly darker rim
spill = np.clip(1 - (radius * 1.3 + (noise(4) - 0.5) * 0.9), 0, 1)
rim = np.clip(1 - np.abs(spill - 0.12) * 12, 0, 1)
save("floor_stain", (14, 9, 6), np.clip(spill * 0.95 + rim * 0.3, 0, 0.97), 0.8 + 0.3 * noise(10))

# drag: long scraped streaks with dirt, as if something heavy was pulled along the floor
lanes = np.clip((noise(40, 2)[:, 0:1].repeat(N, axis=1) - 0.5) * 4, 0, 1)
lane_mask = np.clip(1 - np.abs(yy) * 3.2, 0, 1) * np.clip(1 - np.abs(xx) * 2.1, 0, 1)
save("drag", (20, 15, 10), np.clip(lanes * lane_mask * (0.7 + noise(8) * 0.5) * 1.3, 0, 0.95), 0.9 + 0.2 * noise(6))

print("wrote", OUT)
