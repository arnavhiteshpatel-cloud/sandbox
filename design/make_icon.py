"""Generates the Facelet app icon (1024x1024): a black squircle with a refined 3x3 facelet grid,
one facelet lit in white — echoing a timer's precision and csTimer's black/white identity."""
from PIL import Image, ImageDraw, ImageFilter
import sys
S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# macOS icon grid: 824px body centred
pad = 100
body = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(body)
d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=185, fill=(8, 8, 9, 255))
# subtle inner rim
d.rounded_rectangle([pad + 3, pad + 3, S - pad - 3, S - pad - 3], radius=182, outline=(40, 40, 44, 255), width=3)
# shadow
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sh).rounded_rectangle([pad, pad + 14, S - pad, S - pad + 14], radius=185, fill=(0, 0, 0, 150))
sh = sh.filter(ImageFilter.GaussianBlur(18))
img.alpha_composite(sh)
img.alpha_composite(body)
d = ImageDraw.Draw(img)
grid = 470
cell = grid / 3
gap = 26
x0 = (S - grid) / 2
y0 = (S - grid) / 2
for r in range(3):
    for c in range(3):
        x = x0 + c * cell + gap / 2
        y = y0 + r * cell + gap / 2
        w = cell - gap
        lit = (r, c) == (0, 2)
        col = (255, 255, 255, 255) if lit else (38, 38, 42, 255)
        d.rounded_rectangle([x, y, x + w, y + w], radius=26, fill=col)
img.save(sys.argv[1])
