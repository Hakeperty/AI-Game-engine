"""
Ages the generated family photos and tears the mother's head out of them (Chapter 1: "a person whose head is
ripped off"), and crops the Sacred Heart print. Inputs come from tools/tts/imagegen.py (FLUX.1-schnell).

    tools/tts/.venv/Scripts/python.exe games/sidle-of-milch/build/photos.py <generated-dir>

Writes textures/story/photo1.png, photo2.png and sacred_heart.png.
"""

import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "textures", "story")


def aged(img: Image.Image, seed: int) -> Image.Image:
    """An old print: faded, warm, soft, scratched, with a white border."""
    rnd = random.Random(seed)
    img = img.convert("RGB")
    # fade toward a warm cream and lift the blacks
    cream = Image.new("RGB", img.size, (236, 222, 190))
    img = Image.blend(img, cream, 0.22)
    img = ImageOps.autocontrast(img, cutoff=1)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    # vignette
    w, h = img.size
    vig = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(vig)
    for i in range(40):
        t = i / 40
        d.ellipse([-w * 0.25 + t * w * 0.2, -h * 0.25 + t * h * 0.2, w * 1.25 - t * w * 0.2, h * 1.25 - t * h * 0.2], fill=int(255 * t))
    vig = vig.filter(ImageFilter.GaussianBlur(w * 0.05))
    img = Image.composite(img, Image.new("RGB", img.size, (60, 45, 30)), vig.point(lambda v: 150 + v * 105 // 255))
    # fine scratches and dust
    d = ImageDraw.Draw(img)
    for _ in range(9):
        x = rnd.uniform(0, w)
        y = rnd.uniform(0, h)
        L = rnd.uniform(20, 160)
        a = rnd.uniform(-0.4, 0.4) + math.pi / 2 * rnd.choice([0, 1])
        d.line([x, y, x + math.cos(a) * L, y + math.sin(a) * L], fill=(235, 230, 215), width=1)
    for _ in range(300):
        x, y = rnd.uniform(0, w), rnd.uniform(0, h)
        c = rnd.choice([(240, 236, 225), (40, 32, 26)])
        d.point([x, y], fill=c)
    # white print border
    b = int(min(w, h) * 0.045)
    framed = Image.new("RGB", (w + 2 * b, h + 2 * b), (238, 233, 220))
    framed.paste(img, (b, b))
    return framed


def torn(img: Image.Image, cx: float, cy: float, rx: float, ry: float, seed: int) -> Image.Image:
    """Tears an irregular hole (the face) out of the print: a dark backing shows through, ringed by a
    white fibrous edge where the paper split."""
    rnd = random.Random(seed)
    w, h = img.size
    pts_in, pts_out = [], []
    n = 90
    phase = [rnd.uniform(0, 6.28) for _ in range(4)]
    for i in range(n):
        a = i / n * math.tau
        wobble = 1 + 0.16 * math.sin(a * 3 + phase[0]) + 0.1 * math.sin(a * 7 + phase[1]) + rnd.uniform(-0.07, 0.07)
        r_in = wobble
        r_out = wobble * (1.05 + 0.08 * abs(math.sin(a * 5 + phase[2])) + rnd.uniform(0, 0.05))
        pts_in.append((cx * w + math.cos(a) * rx * w * r_in, cy * h + math.sin(a) * ry * h * r_in))
        pts_out.append((cx * w + math.cos(a) * rx * w * r_out, cy * h + math.sin(a) * ry * h * r_out))
    fiber = Image.new("L", (w, h), 0)
    ImageDraw.Draw(fiber).polygon(pts_out, fill=255)
    hole = Image.new("L", (w, h), 0)
    ImageDraw.Draw(hole).polygon(pts_in, fill=255)
    fiber = fiber.filter(ImageFilter.GaussianBlur(1.2))
    out = Image.composite(Image.new("RGB", (w, h), (232, 226, 212)), img, fiber)  # torn white paper edge
    backing = Image.new("RGB", (w, h), (52, 38, 28))  # the frame's cardboard backing
    noise = Image.effect_noise((w, h), 18).convert("RGB")
    backing = ImageChops.add(backing, noise, scale=6.0)
    out = Image.composite(backing, out, hole.filter(ImageFilter.GaussianBlur(0.8)))
    return out


def main():
    src = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    p1 = aged(Image.open(os.path.join(src, "photo1.png")), 1)
    torn(p1, 0.528, 0.30, 0.062, 0.12, 5).save(os.path.join(OUT, "photo1.png"))
    p2 = aged(Image.open(os.path.join(src, "photo2.png")), 2)
    torn(p2, 0.315, 0.445, 0.14, 0.12, 9).save(os.path.join(OUT, "photo2.png"))
    sh = Image.open(os.path.join(src, "sacred_heart.png")).convert("RGB")
    w, h = sh.size
    sh.crop((int(w * 0.07), int(h * 0.02), int(w * 0.93), int(h * 0.78))).save(os.path.join(OUT, "sacred_heart.png"))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
