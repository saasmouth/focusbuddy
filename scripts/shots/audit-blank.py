"""Reject a shot that captured nothing.

A clip cannot tell whether anything was inside it, so a widget that failed to
render came back as bare canvas and was counted as captured. That is a false
pass, and the whole point of this folder is that every file shows the thing its
name claims. Anything near-uniform is reported, not shipped quietly."""
from PIL import Image
import glob, os, sys

def flatness(path):
    im = Image.open(path).convert('RGB')
    im.thumbnail((160, 160))
    px = list(im.getdata())
    # Share of pixels within a whisker of the single most common colour.
    counts = {}
    for p in px:
        q = (p[0] // 12, p[1] // 12, p[2] // 12)
        counts[q] = counts.get(q, 0) + 1
    return max(counts.values()) / len(px)

bad = []
for f in sorted(glob.glob(sys.argv[1] + '/*.png')):
    fl = flatness(f)
    if fl > 0.94:
        bad.append((os.path.basename(f), round(fl, 3)))
print('  audited', len(glob.glob(sys.argv[1] + '/*.png')), 'files')
if bad:
    print('  BLANK / near-empty (captured nothing):')
    for n, fl in bad: print(f'    {n:<24} {int(fl*100)}% one colour')
else:
    print('  none blank')
