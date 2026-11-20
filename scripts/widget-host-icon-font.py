#!/usr/bin/env python3
"""The widget host's icon font: Material Symbols Outlined, pinned to the one
style the host draws (F2 item 4, "trim the fonts").

The desktop ships the full variable font (material-symbols, 3.9 MB): four axes,
because a person can choose the icons' weight and fill in Appearance. The widget
host has no Appearance: every icon is drawn at wght 500, GRAD 0, opsz 24 (the
defaults in styles/globals.css and components/Icon.tsx), filled or not. Pinning
those three axes keeps every one of the 6,589 icons and the fill axis, and
leaves about 0.5 MB.

Run when the material-symbols package changes (tests/unit/widgetHostIconFont
fails until you do):

    python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools brotli
    /tmp/fontvenv/bin/python scripts/widget-host-icon-font.py

It writes src/web/widgetHost/fonts/material-symbols-outlined.woff2 and
icon-font.json (what it was made from, and how).
"""
import hashlib
import json
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'node_modules/material-symbols/material-symbols-outlined.woff2')
OUT_DIR = os.path.join(ROOT, 'src/web/widgetHost/fonts')
OUT = os.path.join(OUT_DIR, 'material-symbols-outlined.woff2')
PINNED = {'GRAD': 0, 'opsz': 24, 'wght': 500}


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    with open(os.path.join(ROOT, 'node_modules/material-symbols/package.json')) as f:
        version = json.load(f)['version']
    font = TTFont(SOURCE)
    glyphs = len(font.getGlyphOrder())
    out = instancer.instantiateVariableFont(font, PINNED)
    out.flavor = 'woff2'
    os.makedirs(OUT_DIR, exist_ok=True)
    out.save(OUT)
    kept = [a.axisTag for a in out['fvar'].axes] if 'fvar' in out else []
    if len(out.getGlyphOrder()) != glyphs:
        sys.exit(f'glyph count changed: {glyphs} -> {len(out.getGlyphOrder())}')
    manifest = {
        'source': 'material-symbols/material-symbols-outlined.woff2',
        'sourceVersion': version,
        'sourceSha256': sha256(SOURCE),
        'pinned': PINNED,
        'keptAxes': kept,
        'glyphs': glyphs,
        'sha256': sha256(OUT),
        'bytes': os.path.getsize(OUT),
    }
    with open(os.path.join(OUT_DIR, 'icon-font.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print(f"{glyphs} icons, axes kept {kept}, {os.path.getsize(SOURCE) // 1024} KB -> {manifest['bytes'] // 1024} KB")


if __name__ == '__main__':
    main()
