"""Draws the Airwave Discovery icon (Aqua glass tile, white note, broadcast arcs) -> airwave-discovery.ico/.png.
Run: python launcher/make_icon.py   (needs Pillow)"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops

S = 1024
out = Path(__file__).parent


def vgrad(size, top, bottom):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size))


def rr_mask(box, r):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, r, fill=255)
    return m


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
tile = rr_mask((40, 40, S - 40, S - 40), 210)
# drop shadow
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sh.putalpha(tile.filter(ImageFilter.GaussianBlur(22)).point(lambda v: v * 0.45))
img.alpha_composite(Image.composite(Image.new("RGBA", (S, S), (10, 40, 90, 255)), sh, sh.getchannel("A")).transform((S, S), Image.AFFINE, (1, 0, 0, 0, 1, -14)))
# body gradient
body = vgrad(S, (96, 190, 255), (8, 92, 214)).convert("RGBA")
body.putalpha(tile)
img.alpha_composite(body)
# gloss on the top half
gl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gm = Image.new("L", (S, S), 0)
ImageDraw.Draw(gm).ellipse((-120, -420, S + 120, 560), fill=255)
gm = ImageChops.multiply(gm, tile)
gl.paste(Image.new("RGBA", (S, S), (255, 255, 255, 110)), mask=gm)
img.alpha_composite(gl)
# rim
rim = ImageDraw.Draw(img)
rim.rounded_rectangle((40, 40, S - 40, S - 40), 210, outline=(255, 255, 255, 120), width=6)

# glyph layer: broadcast arcs + eighth note
g = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(g)
cx, cy = 330, 590
for i, r in enumerate((250, 380, 510)):
    d.arc((cx - r, cy - r, cx + r, cy + r), -48, 48, fill=(255, 255, 255, 235 - i * 55), width=46)
    # round caps
    import math
    for a in (-48, 48):
        x = cx + r * math.cos(math.radians(a)); y = cy + r * math.sin(math.radians(a))
        d.ellipse((x - 23, y - 23, x + 23, y + 23), fill=(255, 255, 255, 235 - i * 55))
# note
d.ellipse((cx - 150, cy + 20, cx + 70, cy + 190), fill=(255, 255, 255, 255))
d.rounded_rectangle((cx + 20, cy - 250, cx + 70, cy + 120), 22, fill=(255, 255, 255, 255))
d.polygon([(cx + 55, cy - 250), (cx + 200, cy - 170), (cx + 200, cy - 80), (cx + 55, cy - 150)], fill=(255, 255, 255, 255))
gs = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gs.putalpha(g.getchannel("A").filter(ImageFilter.GaussianBlur(14)).point(lambda v: v * 0.5))
gs = Image.composite(Image.new("RGBA", (S, S), (0, 40, 120, 255)), gs, gs.getchannel("A"))
img.alpha_composite(gs.transform((S, S), Image.AFFINE, (1, 0, 0, 0, 1, -10)))
img.alpha_composite(g)

img.resize((256, 256), Image.LANCZOS).save(out / "airwave-discovery.png")
sizes = [16, 24, 32, 48, 64, 128, 256]
img.save(out / "airwave-discovery.ico", sizes=[(s, s) for s in sizes])
print("wrote", out / "airwave-discovery.ico")
