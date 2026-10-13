"""Render the Euclidean mark (circle inscribed in a rounded square, gold axis) to PNG and ICO."""
import sys
from PIL import Image, ImageDraw

def mark(size):
    s = size * 4  # supersample
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = s * 0.06
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=s * 0.24, fill=(225, 242, 239, 255), outline=(63, 154, 146, 255), width=int(s * 0.055))
    r = s * 0.235
    c = s / 2
    d.ellipse([c - r, c - r, c + r, c + r], outline=(35, 102, 95, 255), width=int(s * 0.062))
    w = s * 0.062
    d.rounded_rectangle([c - w / 2, c - r * 1.02, c + w / 2, c + r * 1.02], radius=w / 2, fill=(201, 160, 67, 255))
    return im.resize((size, size), Image.LANCZOS)

out = sys.argv[1]
big = mark(1024)
big.save(f"{out}/icon.png")
mark(256).save(f"{out}/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
mark(32).save(f"{out}/tray.png")
mark(64).save(f"{out}/tray@2x.png")
print("ok")
