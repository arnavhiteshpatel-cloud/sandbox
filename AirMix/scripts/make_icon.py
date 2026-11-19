# Renders the AirMix app icon: a macOS-style squircle with a deep gradient and three luminous faders.
import sys, math
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

S = 1024
def squircle_mask(size, inset):
    n = 5.0
    a = (size - 2 * inset) / 2
    c = size / 2
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    # supersample edge
    v = (np.abs((x + 0.5 - c) / a) ** n + np.abs((y + 0.5 - c) / a) ** n)
    m = np.clip((1.0 - v) * a / 2.5 + 0.5, 0, 1)
    return Image.fromarray((m * 255).astype(np.uint8))

inset = 100
mask = squircle_mask(S, inset)

# Background gradient: deep navy → indigo, diagonal
y, x = np.mgrid[0:S, 0:S].astype(np.float64)
t = np.clip((x * 0.35 + y * 0.65) / S, 0, 1)
top = np.array([22, 28, 54]); bot = np.array([10, 12, 26])
bg = (top[None, None, :] * (1 - t[..., None]) + bot[None, None, :] * t[..., None])
# soft radial glow
r = np.sqrt((x - S * 0.5) ** 2 + (y - S * 0.38) ** 2) / S
glow = np.clip(1 - r * 1.9, 0, 1) ** 2
bg += glow[..., None] * np.array([40, 60, 120])
img = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8), "RGB").convert("RGBA")

layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(layer)
c1 = np.array([107, 184, 255]); c2 = np.array([158, 140, 255])
xs = [S * 0.34, S * 0.5, S * 0.66]
levels = [0.62, 0.38, 0.52]   # knob positions (fraction from top of track)
top_y, bot_y = S * 0.27, S * 0.73
for i, (cx, lv) in enumerate(zip(xs, levels)):
    # track
    d.rounded_rectangle([cx - 14, top_y, cx + 14, bot_y], radius=14, fill=(255, 255, 255, 34))
    ky = top_y + (bot_y - top_y) * lv
    # filled part (below knob) with gradient
    steps = 60
    for s in range(steps):
        f0 = s / steps
        yy0 = ky + (bot_y - ky) * f0
        yy1 = min(bot_y - 14, ky + (bot_y - ky) * (s + 1) / steps + 1)
        col = c2 * (1 - f0) + c1 * f0
        if yy1 > yy0: d.rectangle([cx - 14, yy0, cx + 14, yy1], fill=(int(col[0]), int(col[1]), int(col[2]), 255))
    d.rounded_rectangle([cx - 14, bot_y - 28, cx + 14, bot_y], radius=14, fill=(int(c1[0]), int(c1[1]), int(c1[2]), 255))
    # knob
    d.rounded_rectangle([cx - 52, ky - 24, cx + 52, ky + 24], radius=18, fill=(255, 255, 255, 255))
    d.rectangle([cx - 30, ky - 2, cx + 30, ky + 2], fill=(150, 160, 190, 255))

# round the bottom of fills by masking with track shapes
glow_layer = layer.filter(ImageFilter.GaussianBlur(28))
img = Image.alpha_composite(img, Image.eval(glow_layer, lambda v: v))
img = Image.alpha_composite(img, layer)

# subtle top highlight
hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
hd.ellipse([inset - 200, inset - 520, S - inset + 200, S * 0.42], fill=(255, 255, 255, 18))
img = Image.alpha_composite(img, hl.filter(ImageFilter.GaussianBlur(60)))

out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
out.paste(img, (0, 0), mask)
# drop shadow
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sh.paste((0, 0, 0, 110), (0, 12), mask)
sh = sh.filter(ImageFilter.GaussianBlur(18))
final = Image.alpha_composite(sh, out)

dest = sys.argv[1]
for size in [16, 32, 128, 256, 512]:
    for scale in [1, 2]:
        px = size * scale
        name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
        final.resize((px, px), Image.LANCZOS).save(f"{dest}/{name}")
final.save(f"{dest}/../AppIcon-1024.png")
print("ok")
