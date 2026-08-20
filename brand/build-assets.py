#!/usr/bin/env python3
"""
Regenerate every Tupo brand asset from the single source of truth,
`brand/src/icon-source.png`.

    python3 brand/build-assets.py

Pipeline
--------
The master is `src/mark.svg` — a hand-authored vector. Its `#artwork` children
are copied verbatim into every output, so geometry is never re-derived and
never degrades.

1. Read the master and the brand colour.
2. Compose the SVG collection: bare mark, mono, square icons at several
   paddings, plate variants, favicon and the horizontal lockups.
3. Rasterise the PNG/ICO set from those SVGs, so every size is genuinely sharp
   rather than a resampled bitmap.
4. Regenerate `apps/web/src/components/Logo.tsx` from the same artwork.

`src/icon-source.png` (the supplied raster artwork) is additionally traced with
potrace into `svg/tupo-mark-detailed.svg` — the full-detail illustrative version,
kept for large/print use where its finer line work still reads.

Requires: potrace, ImageMagick (`magick`), Pillow, numpy, and a Chrome binary.
"""
# Postponed annotations: the system python here is 3.9, which cannot evaluate
# `str | None` or bare `list[str]` at definition time.
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
SRC, SVG, PNG = ROOT / 'src', ROOT / 'svg', ROOT / 'png'
WEB_PUBLIC = ROOT.parent / 'apps' / 'web' / 'public'

TRACE_SCALE = 2             # trace at 2x so potrace has sub-pixel detail
FLAT_COLOUR_TOLERANCE = 12  # RGB distance below which a mark counts as flat
BRAND_COLOR = '#005EF9'     # measured from the supplied artwork
NARGS = {'m': 2, 'l': 2, 't': 2, 'c': 6, 's': 4, 'q': 4, 'a': 7, 'h': 1, 'v': 1, 'z': 0}

PLATE_DARK = '#0B1220'
PLATE_LIGHT = '#FFFFFF'


def find_chrome() -> str:
    for c in Path.home().glob('.cache/puppeteer/chrome/*/chrome-mac-arm64/'
                              'Google Chrome for Testing.app/Contents/MacOS/*'):
        return str(c)
    for c in ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              shutil.which('chromium'), shutil.which('google-chrome')):
        if c and Path(c).exists():
            return c
    sys.exit('no Chrome binary found — needed to rasterise the PNGs')


# ── 1. normalise the source ──────────────────────────────────────────────────
def normalise(source: Path) -> Image.Image:
    im = Image.open(source)
    has_alpha = im.mode in ('RGBA', 'LA') and np.asarray(im.convert('RGBA'))[..., 3].min() < 255

    if has_alpha:
        arr = np.asarray(im.convert('RGBA')).astype(np.float32)
        rgb, alpha = arr[..., :3] / 255.0, arr[..., 3] / 255.0
        # A glow render surrounds crisp line-art with a wide, faint halo. The
        # alpha is bimodal (mostly 0 or near-1) so remapping about the midpoint
        # discards the halo while keeping the genuine anti-aliased edge, which
        # crosses that midpoint within about a pixel.
        alpha = np.clip((alpha - 0.5) / 0.5, 0.0, 1.0)
    else:
        a = np.asarray(im.convert('RGB')).astype(np.float32) / 255.0
        # Bright line-art on black: the max channel doubles as coverage. Using
        # the max rather than a weighted luminance stops saturated blues (whose
        # weighted luminance is low) from being eaten away at the edges.
        alpha = a.max(axis=2)
        rgb = np.clip(a / np.maximum(alpha, 1e-6)[..., None], 0, 1)  # un-premultiply
        alpha = np.where(alpha < 0.02, 0.0, alpha)

    out = (np.concatenate([rgb, alpha[..., None]], axis=2) * 255).astype(np.uint8)
    img = Image.fromarray(out)
    bbox = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    return img.crop(bbox)


# ── 2. trace ─────────────────────────────────────────────────────────────────
def trace(trimmed: Image.Image, view_w: int, view_h: int) -> list[str]:
    big = trimmed.resize((trimmed.width * TRACE_SCALE, trimmed.height * TRACE_SCALE),
                         Image.LANCZOS)
    pbm = SRC / 'mask.pbm'
    big.getchannel('A').point(lambda v: 0 if v > 128 else 255).convert('1').save(pbm)

    traced = SRC / 'traced.svg'
    subprocess.run(['potrace', str(pbm), '-b', 'svg', '-o', str(traced),
                    '--turdsize', '4', '--alphamax', '1.0', '--opttolerance', '0.2'],
                   check=True)

    import re
    raw = traced.read_text()
    m = re.search(r'<g transform="translate\(([\d.\-]+),([\d.\-]+)\) '
                  r'scale\(([\d.\-]+),([\d.\-]+)\)"', raw)
    tx, ty, sx, sy = (float(m.group(i)) for i in range(1, 5))
    inner = re.search(r'(<g transform="[^"]+"[^>]*>)(.*?)(</g>)', raw, re.S).group(2)
    k = view_w / big.width

    def bake(d: str) -> str:
        toks = re.findall(r'[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?', d)
        out, i, cmd = [], 0, None
        absolute = lambda x, y: ((tx + x * sx) * k, (ty + y * sy) * k)
        # Every pair in a relative command is relative to the SAME current
        # point, so the linear part of the transform applies to each directly.
        relative = lambda x, y: (x * sx * k, y * sy * k)
        while i < len(toks):
            t = toks[i]
            if t.isalpha():
                cmd = t
                i += 1
                if cmd.lower() == 'z':
                    out.append('Z')
                continue
            n = NARGS[cmd.lower()]
            args = [float(v) for v in toks[i:i + n]]
            i += n
            conv = relative if cmd.islower() else absolute
            out.append(cmd)
            for j in range(0, n, 2):
                x, y = conv(args[j], args[j + 1])
                out += [f'{x:.2f}', f'{y:.2f}']
        s = ''
        for t in out:
            s += t if t.isalpha() else ('' if not s or s[-1].isalpha() else ' ') + t
        return s

    return [bake(d) for d in re.findall(r'<path d="([^"]+)"', inner)]


# ── 3. measure the paint ─────────────────────────────────────────────────────
def fit_paint(trimmed: Image.Image) -> dict:
    """Flat colour if the mark is uniform, otherwise a fitted linear gradient."""
    t = np.asarray(trimmed.convert('RGBA')).astype(np.float32)
    h, w, _ = t.shape
    ys, xs = np.nonzero(t[..., 3] > 230)
    cols = t[ys, xs, :3]

    best = (0.0, 1.0, 0.0, None)
    for deg in range(0, 180, 5):
        th = np.deg2rad(deg)
        ux, uy = np.cos(th) * w, np.sin(th) * h
        n = np.hypot(ux, uy)
        proj = (xs * ux + ys * uy) / n
        lo = cols[proj < np.quantile(proj, 0.08)].mean(axis=0)
        hi = cols[proj > np.quantile(proj, 0.92)].mean(axis=0)
        d = float(np.linalg.norm(hi - lo))
        if d > best[0]:
            best = (d, ux / n, uy / n, proj)

    separation, ux, uy, proj = best
    if separation < FLAT_COLOUR_TOLERANCE:
        mean = cols.mean(axis=0)
        return {'type': 'solid',
                'color': '#' + ''.join(f'{int(round(v)):02X}' for v in mean),
                'separation': round(separation, 1)}

    # Sample in LINEAR bins along the axis. Quantile bins compress the middle of
    # the ramp and produce a hard colour switch instead of a sweep.
    lo, hi = proj.min(), proj.max()
    stops = []
    N = 9
    for i in range(N):
        a, b = lo + (hi - lo) * i / N, lo + (hi - lo) * (i + 1) / N
        mask = (proj >= a) & (proj <= b)
        if mask.sum() < 200:
            continue
        c = cols[mask].mean(axis=0)
        stops.append({'offset': round((i + 0.5) / N, 3),
                      'color': '#' + ''.join(f'{int(round(v)):02X}' for v in c)})
    return {'type': 'gradient', 'separation': round(separation, 1),
            'x1': round(ux * lo, 1), 'y1': round(uy * lo, 1),
            'x2': round(ux * hi, 1), 'y2': round(uy * hi, 1), 'stops': stops}


# ── 4. emit ──────────────────────────────────────────────────────────────────
def read_master() -> tuple[str, int, int]:
    """Return the master artwork's inner markup and its viewBox size."""
    import re
    raw = (SRC / 'mark.svg').read_text()
    vb = re.search(r'viewBox="0 0 (\d+) (\d+)"', raw)
    inner = re.search(r'<g id="artwork">(.*?)</g>', raw, re.S).group(1).strip()
    # Strip comments: they are guidance for maintainers, not payload for every
    # generated file.
    inner = re.sub(r'<!--.*?-->', '', inner, flags=re.S)
    inner = '\n'.join(l for l in (ln.rstrip() for ln in inner.splitlines()) if l.strip())
    return inner, int(vb.group(1)), int(vb.group(2))


def write_svgs(inner: str, view_w: int, view_h: int) -> None:
    body = '\n'.join('    ' + l.strip() for l in inner.splitlines())

    def art(fill, transform=''):
        t = f' transform="{transform}"' if transform else ''
        return f'  <g{t} fill="{fill}" fill-rule="evenodd">\n{body}\n  </g>'

    def doc(view, art_block, title=True):
        t = '\n  <title>Tupo</title>' if title else ''
        role = ' role="img" aria-label="Tupo"' if title else ''
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}"{role}>{t}\n'
                f'{art_block}\n</svg>\n')

    view = f'0 0 {view_w} {view_h}'
    (SVG / 'tupo-mark.svg').write_text(doc(view, art(BRAND_COLOR)))
    (SVG / 'tupo-mark-mono.svg').write_text(doc(view, art('currentColor')))

    def square(name, pad_ratio, bg=None, radius=None):
        S = 1024
        inner_box = S * (1 - 2 * pad_ratio)
        scale = min(inner_box / view_w, inner_box / view_h)
        ox, oy = (S - view_w * scale) / 2, (S - view_h * scale) / 2
        rect = ''
        if bg:
            r = f' rx="{radius}"' if radius else ''
            rect = f'  <rect width="{S}" height="{S}"{r} fill="{bg}"/>\n'
        (SVG / name).write_text(doc(
            f'0 0 {S} {S}',
            rect + art(BRAND_COLOR, f'translate({ox:.1f},{oy:.1f}) scale({scale:.4f})')))

    square('tupo-icon.svg', 0.10)
    # At 16-32px even this mark benefits from a tighter crop in a browser tab.
    square('tupo-icon-tight.svg', 0.04)
    # Android maskable icons are cropped to a circle: everything meaningful must
    # sit inside the middle 80%, hence the deeper inset and a plate behind it.
    square('tupo-icon-maskable.svg', 0.22, bg=PLATE_DARK)
    square('tupo-icon-dark.svg', 0.16, bg=PLATE_DARK, radius=224)
    square('tupo-icon-light.svg', 0.16, bg=PLATE_LIGHT, radius=224)
    # iOS ignores alpha on home-screen icons and composites transparent areas
    # onto black, so the Apple icon must be full-bleed opaque. iOS applies its
    # own squircle mask, hence no radius of our own.
    square('tupo-icon-apple.svg', 0.18, bg=PLATE_DARK)

    (SVG / 'favicon.svg').write_text(
        (SVG / 'tupo-icon.svg').read_text()
        .replace('\n  <title>Tupo</title>', '')
        .replace(' role="img" aria-label="Tupo"', ''))

    # Horizontal lockup. Live text keeps the wordmark editable and matching the
    # UI font; PNG exports are authoritative where Inter is absent.
    lock_h = 256
    scale = (lock_h * 0.78) / view_h
    mw = view_w * scale
    oy = (lock_h - view_h * scale) / 2
    for name, colour, text_fill in (('tupo-logo.svg', BRAND_COLOR, '#0F172A'),
                                    ('tupo-logo-mono.svg', 'currentColor', 'currentColor')):
        (SVG / name).write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {int(mw + 380)} {lock_h}" '
            f'role="img" aria-label="Tupo">\n  <title>Tupo</title>\n'
            f'{art(colour, f"translate(0,{oy:.1f}) scale({scale:.4f})")}\n'
            f'  <text x="{mw + 36:.0f}" y="{lock_h * 0.68:.0f}" fill="{text_fill}"\n'
            f'    font-family="Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"\n'
            f'    font-size="152" font-weight="600" letter-spacing="-5">Tupo</text>\n</svg>\n')


def write_detailed(source: Path) -> None:
    """Trace the supplied raster artwork — the illustrative full-detail mark."""
    trimmed = normalise(source)
    trimmed.save(SRC / 'icon-trimmed.png')
    w, h = trimmed.size
    paths = trace(trimmed, w, h)
    paint = fit_paint(trimmed)
    (SRC / 'paint.json').write_text(json.dumps(paint, indent=2))
    fill = paint['color'] if paint['type'] == 'solid' else BRAND_COLOR
    body = '\n'.join(f'    <path d="{d}"/>' for d in paths)
    (SVG / 'tupo-mark-detailed.svg').write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'role="img" aria-label="Tupo">\n  <title>Tupo</title>\n'
        f'  <g fill="{fill}" fill-rule="evenodd">\n{body}\n  </g>\n</svg>\n')
    return len(paths), paint


def rasterise(chrome: str) -> None:
    jobs = [
        ('tupo-icon-tight.svg', 'icon-tight', [16, 32, 48]),
        ('tupo-icon.svg', 'icon', [16, 32, 48, 64, 96, 128, 180, 192, 256, 384, 512, 1024]),
        ('tupo-icon-apple.svg', 'icon-apple', [120, 152, 167, 180]),
        ('tupo-icon-maskable.svg', 'icon-maskable', [192, 512]),
        ('tupo-icon-dark.svg', 'icon-dark', [512]),
        ('tupo-icon-light.svg', 'icon-light', [512]),
        ('tupo-mark.svg', 'mark', [512]),
    ]
    html = SRC / '_render.html'
    for svg_name, stem, sizes in jobs:
        for size in sizes:
            html.write_text(f'<body style="margin:0"><img src="file://{SVG / svg_name}" '
                            f'width="{size}" height="{size}"></body>')
            subprocess.run([chrome, '--headless', '--disable-gpu', '--no-sandbox',
                            '--hide-scrollbars', '--default-background-color=00000000',
                            f'--window-size={size},{size}', '--virtual-time-budget=3000',
                            f'--screenshot={PNG / f"{stem}-{size}.png"}', f'file://{html}'],
                           check=True, capture_output=True)
    html.unlink(missing_ok=True)


def publish() -> None:
    # Build the ICO from distinct source PNGs. Pillow's multi-size ICO save
    # RESAMPLES whichever single image it is handed, so passing the 16px one
    # with a sizes list silently produced a 16-only file; ImageMagick keeps each
    # frame. Tight crop below 64px, standard padding above.
    frames = ([str(PNG / f'icon-tight-{s}.png') for s in (16, 32, 48)]
              + [str(PNG / f'icon-{s}.png') for s in (64, 128, 256)])
    subprocess.run(['magick', *frames, str(WEB_PUBLIC / 'favicon.ico')], check=True)

    for src_name, dest in (
            ('icon-192.png', 'icon-192.png'),
            ('icon-512.png', 'icon-512.png'),
            ('icon-maskable-192.png', 'icon-maskable-192.png'),
            ('icon-maskable-512.png', 'icon-maskable-512.png'),
            ('icon-apple-180.png', 'apple-touch-icon.png'),
            ('icon-apple-167.png', 'apple-touch-icon-167.png'),
            ('icon-apple-152.png', 'apple-touch-icon-152.png'),
            ('icon-apple-120.png', 'apple-touch-icon-120.png')):
        shutil.copy(PNG / src_name, WEB_PUBLIC / dest)
    shutil.copy(SVG / 'favicon.svg', WEB_PUBLIC / 'favicon.svg')
    shutil.copy(SVG / 'tupo-mark.svg', WEB_PUBLIC / 'logo.svg')


def write_logo_component(inner: str, view_w: int, view_h: int) -> None:
    """Regenerate apps/web/src/components/Logo.tsx from the master artwork."""
    comp = ROOT.parent / 'apps' / 'web' / 'src' / 'components' / 'Logo.tsx'
    # The master deliberately uses only attributes valid in both SVG and JSX,
    # so its markup can be embedded directly with no translation.
    jsx = '\n'.join('        ' + l.strip().replace('/>', ' />') for l in inner.splitlines())
    comp.write_text(f'''import React from 'react';

/**
 * The Tupo mark.
 *
 * GENERATED FILE — produced by `brand/build-assets.py` from `brand/src/mark.svg`.
 * Edit the master artwork or that script, not this file.
 *
 * Inlined rather than loaded from `/logo.svg` so the mark inherits
 * `currentColor` in mono mode, costs no extra request, and cannot flash in
 * before the stylesheet lands.
 */

const BRAND_COLOR = '{BRAND_COLOR}';

const VIEW_W = {view_w};
const VIEW_H = {view_h};

export interface LogoProps {{
  /** Rendered height in pixels. Width follows the artwork's aspect ratio. */
  size?: number;
  /** `brand` uses the brand blue; `mono` inherits currentColor. */
  variant?: 'brand' | 'mono';
  className?: string;
  /** Set when the logo is decorative and adjacent text already names the app. */
  decorative?: boolean;
}}

export const Logo: React.FC<LogoProps> = ({{
  size = 32, variant = 'brand', className, decorative = false,
}}) => (
  <svg
    viewBox={{`0 0 ${{VIEW_W}} ${{VIEW_H}}`}}
    height={{size}}
    width={{(size * VIEW_W) / VIEW_H}}
    className={{className}}
    role={{decorative ? undefined : 'img'}}
    aria-label={{decorative ? undefined : 'Tupo'}}
    aria-hidden={{decorative || undefined}}
    focusable="false"
  >
    <g fill={{variant === 'mono' ? 'currentColor' : BRAND_COLOR}} fillRule="evenodd">
{jsx}
    </g>
  </svg>
);
''')


def main() -> None:
    for d in (SVG, PNG):
        d.mkdir(parents=True, exist_ok=True)

    inner, view_w, view_h = read_master()
    print(f'  ✅ master mark read ({len(inner.splitlines())} shapes, {view_w}x{view_h})')

    write_svgs(inner, view_w, view_h)

    source = SRC / 'icon-source.png'
    if source.exists():
        n, paint = write_detailed(source)
        note = paint['color'] if paint['type'] == 'solid' else 'gradient'
        print(f'  ✅ detailed illustrative mark traced ({n} paths, {note})')

    print(f'  ✅ {len(list(SVG.glob("*.svg")))} SVGs written')

    rasterise(find_chrome())
    print(f'  ✅ {len(list(PNG.glob("*.png")))} PNGs rasterised')

    publish()
    print('  ✅ web assets published to apps/web/public/')

    write_logo_component(inner, view_w, view_h)
    print('  ✅ apps/web/src/components/Logo.tsx regenerated')


if __name__ == '__main__':
    main()
