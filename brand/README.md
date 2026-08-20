# Tupo brand assets

Every file in `svg/` and `png/` is **generated**. Do not hand-edit them — change
the source artwork or the build script and regenerate:

```bash
python3 brand/build-assets.py
```

Requires `potrace`, Pillow, numpy and a Chrome binary (used to rasterise the
PNGs from the SVGs, so each size is genuinely sharp rather than a resampled
bitmap).

## The redesign

The supplied artwork is a five-shape outlined drawing whose strokes measure
**5.7% of the box**. At a 20px header icon that is a **1.1px line** — sub-pixel,
so it greys out; at 16px the enclosed counters fill in. Rendered at true rail
size and magnified, the tail was a 2px nub that read as dirt.

| | supplied artwork | current mark |
|---|---|---|
| Distinct shapes | 5 (limit at 16–24px is 2–3) | **1** |
| Stroke / mass at 20px | 1.1px line | solid circle |
| Aspect | 1.14:1 (wider ⇒ smaller when height-constrained) | 1:1 |
| Legible at 16px | no | yes |

**The mark**: a round speech bubble with two message lines knocked out of it.

- **One shape.** Everything the mark needs is in a single path.
- **Round, not a rounded-square container.** A filled container reads as an app
  icon pasted into the page — it was the first thing that felt wrong in the
  rail, sitting above a column of thin-stroke outline icons. The circle carries
  roughly 60% of that visual mass and sits *with* the interface.
- **The lines are knocked out, not painted white.** They take the colour of
  whatever the mark sits on, so one file works on light and dark and
  `currentColor` works for mono use.
- **Two lines, not three dots.** It reads as a message rather than a loading
  state, and the wider-over-narrower pairing survives to 16px.

Discarded along the way, each for a measured reason: outlined variants (elegant,
but at rail size they blend into the nav icons and the mark loses brand
presence); a two-bubble version (the second bubble becomes a pale smudge below
24px); a rounded-square container (too heavy).

The original artwork remains available as `svg/tupo-mark-detailed.svg` for large
and print use, where its finer line work still reads.

## Source of truth

**`src/mark.svg`** — the master, a hand-authored vector. Its `#artwork`
children are copied verbatim into every output, so geometry is never re-derived
and never degrades. To change the logo, edit this file and re-run the build.

It deliberately uses only attributes valid in **both SVG and JSX** (`x`, `y`,
`width`, `height`, `rx`, `d`, `opacity`, `transform`) so the same markup can be
embedded straight into `Logo.tsx` with no translation.

`src/icon-source.png` — the supplied raster artwork, kept byte-for-byte. It is
traced into the detailed variant. Earlier versions live in `src/archive/`.

The tracer normalises two kinds of raster source automatically:

- **Artwork already carrying alpha, wrapped in a glow halo** (the current one).
  Its alpha is bimodal — 79% fully clear, 19% near-opaque — so remapping about
  the midpoint discards the wide faint halo while keeping the genuine
  anti-aliased edge, which crosses that midpoint within about a pixel.
- **Artwork on an opaque black field** (the earlier one). The black is keyed
  out by treating the **max colour channel as coverage** and un-premultiplying,
  so edges keep their true hue instead of staying darkened by the black they
  were blended against. A weighted luminance would have eaten the saturated
  blues at the edges; the max channel does not.

The result is then traced with potrace into real vector paths, and potrace's own
transforms are **baked into the coordinates**. That baking matters: with the
transforms left in place, a `userSpaceOnUse` gradient resolves inside them and
lands nowhere near the artwork.

## Palette

The paint is **measured from the source pixels**, not eyeballed. The build tests
every axis for colour variation; below a tolerance of 12 (on the 0–441 RGB
distance scale) it emits a flat fill, otherwise it fits a linear gradient
sampled in linear bins along the axis of greatest variation.

The supplied artwork measured a variation of **0.7** — flat — which is where
`#005EF9` comes from.

| | |
|---|---|
| **Brand blue** | `#005EF9` |
| Plate (dark) | `#0B1220` |
| Plate (light) | `#FFFFFF` |
| UI primary | `blue-600` `#2563EB` — matches NGA Central MIS |

The previous gradient mark (lime → cyan → blue) is archived at
`src/archive/icon-source-v1-gradient.png`. Dropping it back in as
`src/icon-source.png` and re-running the build restores the gradient
automatically — the pipeline detects which it is.

## Files

### `svg/`

| File | Use |
|---|---|
| `tupo-mark.svg` | **The mark** — 128×128, brand blue. Use this everywhere. |
| `tupo-mark-detailed.svg` | The original full-detail drawing, for large/print use only |
| `tupo-mark-mono.svg` | Single colour via `currentColor` — print, engraving, watermarks |
| `tupo-icon.svg` | Square 1024×1024, 8% padding — the general-purpose app icon |
| `tupo-icon-tight.svg` | Square, 2% padding — feeds the small ICO sizes only |
| `tupo-icon-maskable.svg` | Square on a dark plate, 22% inset for Android's circular crop |
| `tupo-icon-dark.svg` | Rounded dark plate — dark-surface contexts, macOS-style tiles |
| `tupo-icon-light.svg` | Rounded white plate — light-surface contexts |
| `tupo-icon-apple.svg` | Full-bleed opaque dark plate for iOS (no radius — iOS masks it) |
| `favicon.svg` | `tupo-icon.svg` minus the `<title>` (tab tooltips are noise) |
| `tupo-logo.svg` | Horizontal lockup, mark + wordmark |
| `tupo-logo-mono.svg` | Lockup in a single colour |

**The `currentColor` variants must be inlined.** An SVG referenced through
`<img src="...">` is an isolated document and cannot inherit colour from the
host page, so `tupo-mark-mono.svg` renders black there. Inline it (or use the
`Logo` component's `variant="mono"`) for the colour to take.

The two lockups set the wordmark as **live text** in Inter, so it stays editable
and matches the UI. Where Inter is unavailable it falls back through the system
stack — use a PNG export if you need the wordmark pixel-identical everywhere.

### `png/`

`icon-{16,32,48,64,96,128,180,192,256,384,512,1024}.png`, plus
`icon-tight-{16,32,48}`, `icon-apple-{120,152,167,180}`,
`icon-maskable-{192,512}`, `icon-dark-512`, `icon-light-512` and `mark-512`.
Transparent except the plate variants, which are deliberately opaque.

### Published to `apps/web/public/`

`favicon.ico` · `favicon.svg` · `apple-touch-icon.png` ·
`apple-touch-icon-{120,152,167}.png` · `icon-192.png` · `icon-512.png` ·
`icon-maskable-{192,512}.png` · `logo.svg` · `manifest.webmanifest`

## Platform coverage

| Platform | Asset |
|---|---|
| Modern browsers | `favicon.svg` (scales to any size) |
| Legacy browsers, Windows | `favicon.ico` — 16/32/48 use the **tight** crop, 64/128/256 the standard one |
| iOS / iPadOS home screen | `apple-touch-icon*.png` (180/167/152/120) — **opaque**: iOS ignores alpha and composites transparent areas onto black |
| Android / Chrome install | `icon-192.png`, `icon-512.png` |
| Android adaptive icons | `icon-maskable-*.png` — artwork inside the middle 80% so the circular crop never clips it |
| PWA install, splash | `manifest.webmanifest` |
| Social / link previews | `icon-512.png` via `og:image` |
| In-app | `apps/web/src/components/Logo.tsx` |

**Why two crops.** At 16–32px the standard 8% padding costs pixels this detailed
line-art cannot spare and the mark turns to mush in a browser tab, so the small
ICO entries use a tighter crop. Above 64px the consistent margin wins.

**Why ImageMagick builds the ICO.** Pillow's multi-size ICO save *resamples*
whichever single image it is handed, so passing the 16px frame with a `sizes`
list silently produced a 16-only file. ImageMagick keeps each source frame.

## Using the logo in the app

```tsx
import { Logo } from '../components/Logo';

<Logo size={32} />                    // brand colour
<Logo size={20} variant="mono" />     // inherits currentColor
<Logo size={40} decorative />         // adjacent text already says "Tupo"
```

`Logo.tsx` is **generated** by `build-assets.py` — it is rewritten whenever the
artwork changes, including switching between a flat and a gradient paint. It
inlines the path data so the mark inherits `currentColor` in mono mode, costs no
extra request, and cannot flash in before the stylesheet.
