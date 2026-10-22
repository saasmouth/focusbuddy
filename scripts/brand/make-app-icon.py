#!/usr/bin/env python3
"""Regenerate the OS app icons (build/icon.png, .ico, .icns) from the brand
kit's measured geometry (Brand Motion mission, 2026-08-23).

The squircle is the app's established dock tile (832px rounded rect, radius
190, navy #021737) and the ii is drawn from the kit's master-artwork numbers
(stem 100x500 r50 — a true pill; dot 100x98.68 r31.83; dot->stem gap 93.42;
column gap 125), glyph at 55% of canvas height, ii in #0274FD.

    python3 scripts/brand/make-app-icon.py          # writes build/icon.png + .ico
    # then, on macOS, the icns:
    #   mkdir /tmp/plexi.iconset && for s in 16 32 128 256 512; do
    #     sips -z $s $s build/icon.png --out /tmp/plexi.iconset/icon_${s}x${s}.png
    #     sips -z $((s*2)) $((s*2)) build/icon.png --out /tmp/plexi.iconset/icon_${s}x${s}@2x.png
    #   done && iconutil -c icns /tmp/plexi.iconset -o build/icon.icns

Needs Pillow. The kit itself: the brand node's
brand-assets/plexi-brand-motion (geometry documented in its README).
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
NAVY = (2, 23, 55, 255)
BLUE = (2, 116, 253, 255)
S = 4  # supersample factor
C = 1024 * S


def main() -> None:
    img = Image.new('RGBA', (C, C), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([96 * S, 96 * S, 928 * S, 928 * S], radius=190 * S, fill=NAVY)

    gh = 0.55 * 1024 * S
    k = gh / 692.1  # kit units -> px (glyph is 325 x 692.1 in stem-width-100 units)
    stem_w, stem_h = 100 * k, 500 * k
    dot_h, dot_gap, col_gap = 98.68 * k, 93.42 * k, 125 * k
    gw = stem_w * 2 + col_gap
    x0, y0 = (C - gw) / 2, (C - gh) / 2
    for col in range(2):
        x = x0 + col * (stem_w + col_gap)
        d.rounded_rectangle([x, y0, x + stem_w, y0 + dot_h], radius=31.83 * k, fill=BLUE)
        ys = y0 + dot_h + dot_gap
        d.rounded_rectangle([x, ys, x + stem_w, ys + stem_h], radius=stem_w / 2, fill=BLUE)

    icon = img.resize((1024, 1024), Image.LANCZOS)
    icon.save(ROOT / 'build' / 'icon.png')
    icon.save(
        ROOT / 'build' / 'icon.ico',
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    print('wrote build/icon.png and build/icon.ico')


if __name__ == '__main__':
    main()
