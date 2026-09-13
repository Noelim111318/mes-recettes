#!/usr/bin/env python3
"""Genere les icones PWA : un glyphe sur une tuile jaune, sur un ciel violet
etoile (le look par defaut du moteur pwa-engine).

Sorties (a la racine du projet) :
    icons/icon-192.png
    icons/icon-512.png
    icons/icon-512-maskable.png   (motif reduit + marge de securite)
    icons/apple-touch-icon.png    (180x180, opaque)
    favicon.ico                   (16 / 32 / 48)

Depend de Pillow :  python3 -m pip install pillow

--- Personnaliser ---
Le plus simple : change GLYPH (une ou deux lettres, un emoji ne marche pas
avec la police) et les couleurs ci-dessous. Pour un dessin geometrique a la
place du texte, remplace l'appel draw_glyph() dans compose() par tes propres
primitives ImageDraw.
"""
import os
import urllib.request

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    raise SystemExit("Pillow requis :  python3 -m pip install pillow")

try:
    LANCZOS = Image.Resampling.LANCZOS
except AttributeError:                       # Pillow < 9.1
    LANCZOS = Image.LANCZOS

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICONS = os.path.join(ROOT, "icons")
FONT = os.path.join(HERE, "Nunito.ttf")
FONT_URL = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nunito/Nunito%5Bwght%5D.ttf"

# ------------------------------------------------------------------ reglages
GLYPH = "R"                      # 1-2 caracteres poses sur la tuile
S = 2048                         # resolution de travail (reduite ensuite)

BASE_TOP = (43, 27, 18)          # #2B1B12  haut du fond (brun chaud)
BASE_LOW = (29, 18, 11)          # #1D120B  bas du fond
GLOW = (232, 163, 61)            # #E8A33D  halo ambre
INK = (43, 27, 18)               # couleur du glyphe (brun fonce sur tuile ambre)
Y_TOP = (240, 179, 99)           # haut de la tuile
Y_BOT = (216, 137, 53)           # bas de la tuile
Y_RIM = (168, 99, 34)            # lisere

TILE = 0.72                      # cote de la tuile, fraction de l'icone
TILE_RADIUS = 0.34               # arrondi des coins (fraction du cote)
GLYPH_SCALE = 0.62               # hauteur du glyphe, fraction du cote de la tuile

STARS = [(0.16, 0.14, 7, 90), (0.83, 0.11, 10, 120), (0.90, 0.44, 6, 80),
         (0.10, 0.52, 8, 95), (0.22, 0.83, 6, 80), (0.78, 0.85, 9, 110),
         (0.50, 0.07, 5, 70), (0.93, 0.70, 5, 70), (0.07, 0.30, 5, 65)]


# ------------------------------------------------------------------ helpers
def _font():
    if not os.path.exists(FONT):
        try:
            print("Telechargement de Nunito (une fois)...")
            urllib.request.urlretrieve(FONT_URL, FONT)
        except Exception as e:                # pas de reseau, URL morte, proxy...
            raise SystemExit(
                "Impossible de telecharger la police (%s).\n"
                "Options : se connecter le temps du 1er run, OU deposer une police\n"
                "TrueType lisible sous  %s" % (e, FONT)
            )
    return FONT


def vgrad(w, h, top, bot):
    base = Image.new("RGB", (w, h), top)
    grad = Image.new("L", (1, h))
    for y in range(h):
        grad.putpixel((0, y), int(255 * y / max(1, h - 1)))
    return Image.composite(Image.new("RGB", (w, h), bot), base, grad.resize((w, h)))


def background(scale):
    img = vgrad(S, S, BASE_TOP, BASE_LOW).convert("RGBA")
    g = Image.radial_gradient("L").resize((int(S * 2.2), int(S * 2.2)), LANCZOS)
    glow_a = Image.new("L", (S, S), 0)
    glow_a.paste(g, (int(S * 0.5 - g.width / 2), int(S * 0.26 - g.height / 2)))
    glow_a = glow_a.point(lambda v: int(v * 0.50))
    img = Image.composite(Image.new("RGBA", (S, S), GLOW + (255,)), img, glow_a)

    d = ImageDraw.Draw(img)
    cx = cy = S / 2
    for fx, fy, rr, a in STARS:
        x = cx + (fx * S - cx) * scale
        y = cy + (fy * S - cy) * scale
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 255, 255, a))
    return img


def draw_tile(img, scale):
    cx = cy = S / 2
    tw = S * TILE * scale
    x0, y0 = cx - tw / 2, cy - tw / 2
    x1, y1 = x0 + tw, y0 + tw
    rad = tw * TILE_RADIUS

    shape = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shape).rounded_rectangle([x0, y0, x1, y1], radius=rad, fill=255)

    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sh.paste((0, 0, 0, 140), (0, int(S * 0.015)), shape)
    sh = sh.filter(ImageFilter.GaussianBlur(int(S * 0.03)))
    img.alpha_composite(sh)

    grad = vgrad(int(tw), int(tw), Y_TOP, Y_BOT).convert("RGBA")
    tile_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle([x0, y0, x1, y1], radius=rad, fill=255)
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(grad, (int(x0), int(y0)))
    img.paste(canvas, (0, 0), tile_mask)

    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x0, y0, x1, y1], radius=rad, outline=Y_RIM + (170,), width=int(S * 0.006))
    # reflet doux en haut de la tuile
    gloss = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).rounded_rectangle(
        [x0 + tw * 0.10, y0 + tw * 0.08, x1 - tw * 0.10, y0 + tw * 0.30],
        radius=rad * 0.6, fill=(255, 255, 255, 32))
    img.alpha_composite(gloss.filter(ImageFilter.GaussianBlur(int(S * 0.006))))
    return (x0, y0, x1, y1)


def draw_glyph(img, box):
    x0, y0, x1, y1 = box
    tw = x1 - x0
    try:
        fnt = ImageFont.truetype(_font(), int(tw * GLYPH_SCALE))
        try:
            fnt.set_variation_by_axes([900])
        except Exception:
            pass
    except SystemExit:
        raise
    except Exception:
        fnt = ImageFont.load_default()       # repli : icone quand meme generee
    d = ImageDraw.Draw(img)
    tb = d.textbbox((0, 0), GLYPH, font=fnt)
    d.text(((x0 + x1) / 2 - (tb[2] - tb[0]) / 2 - tb[0],
            (y0 + y1) / 2 - (tb[3] - tb[1]) / 2 - tb[1]),
           GLYPH, font=fnt, fill=INK + (255,))


def compose(size, maskable=False, opaque=False):
    scale = 0.68 if maskable else 1.0
    img = background(scale)
    box = draw_tile(img, scale)
    draw_glyph(img, box)

    if not maskable and not opaque:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
        img.putalpha(Image.composite(img.getchannel("A"), Image.new("L", (S, S), 0), mask))

    img = img.resize((size, size), LANCZOS)
    if opaque:
        out = Image.new("RGB", img.size, BASE_LOW)
        out.paste(img, (0, 0), img)
        return out
    return img


def main():
    os.makedirs(ICONS, exist_ok=True)
    compose(192).save(os.path.join(ICONS, "icon-192.png"))
    compose(512).save(os.path.join(ICONS, "icon-512.png"))
    compose(512, maskable=True).save(os.path.join(ICONS, "icon-512-maskable.png"))
    compose(180, opaque=True).save(os.path.join(ICONS, "apple-touch-icon.png"))
    compose(64, opaque=True).save(os.path.join(ROOT, "favicon.ico"),
                                  sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("Icones regenerees dans", ICONS, "+ favicon.ico")


if __name__ == "__main__":
    main()
