# The Arena — Fully Dynamic Flipbook

Every page is now **composed at runtime from JSON** — no baked page renders.
`index.html` + `js/app.js` are the generic engine; content lives in
`manifest.json` and one folder per page.

```
flipbook/
├─ index.html          viewer shell (CSS + StPageFlip, unchanged UI)
├─ js/app.js           engine: loads manifest, renders layers
├─ manifest.json       page order, title, page size, contact page, flipOnClick
├─ reference/          the PDF pages rendered to JPG — use ONLY as a visual
│                      guide while measuring layout coordinates; not loaded
│                      by the app, delete before deploying
└─ pages/
   ├─ page1/  page.json (+ any assets that page uses)
   ├─ page3/  page.json, map.jpg
   ├─ page21/ page.json, hero.jpg, powai.jpg, thane.jpg
   └─ …
```

Must be served over HTTP (`python3 -m http.server` / `npx serve`) — fetch() can't read `file://`.

---

## How each fix works

**1 · Sizing / bottom crop.** StPageFlip derives book height from container
width, so on wide windows the book grew taller than the stage and the bottom
cropped. `fitBook()` in app.js now caps the book's width so the page height
never exceeds the stage height (`width ≤ stageHeight × (517/731) × 2`), and
re-runs on resize and orientation change. The whole brochure always fits.

**2 · No backgrounds.** Pages have no `bg.jpg`. A page is
`backgroundColor` (any CSS color/gradient) + `layers[]` of text, images,
icons, video, carousel, links. (A full-bleed `background` image is still
*supported* for pages that genuinely are one photo — it's just an option,
not the mechanism.) Thumbnails in the tray are **live miniature renders** of
the same JSON — no thumb.jpg either.

**3 · Per-page layouts.** There is no fixed grid: each page.json is its own
layout — a list of layers positioned in % of the page. Different layouts are
just different layer sets, and behaviour is data:

```jsonc
// auto carousel, new image every 5 seconds (page21)
{ "type":"carousel", "x":6,"y":7,"w":88,"h":42, "interval":5000, "images":[…] }

// manual carousel with prev/next arrows, no autoplay (page20)
{ "type":"carousel", …, "autoplay":false, "arrows":true, "images":[…] }

// video as a play button → lightbox (page19), or inline in the page
{ "type":"video", "mode":"lightbox", "x":50,"y":35, "src":"…", "label":"Watch the film" }
{ "type":"video", "mode":"inline", "x":6,"y":10,"w":88,"h":50, "src":"film.mp4", "autoplay":true }
```

For layout blocks you reuse (a stat row, a header band), use `group`: children
are positioned in % **of the group box**, so the whole block moves/scales as
one unit — see the 45+/22,000+/100+ stats on page21. If a layout recurs on
many pages, promote it to a new renderer type (one function in `RENDERERS`)
and reference it by `"type"`.

**4 · Clicks never turn the page.** `"flipOnClick": false` in manifest.json
(wired to StPageFlip's `disableFlipByClick`). Pages turn only via corner
drag, swipe, side arrows, keyboard, or thumbnails — so taps are free for
carousels, videos and links. Interactive layers additionally stop pointer
propagation, so dragging a carousel can't start a page flip.

---

## Layer reference

All coordinates are % of the page (`x`,`y` top-left; `w`,`h` size). Pins and
play buttons use `x`,`y` as centre. Optional anywhere: `z`, `rotate`.

| type | fields |
|---|---|
| `text` | `text`, `style:{font:"serif"\|"sans", size (in % of page width), color, weight, align, letterSpacing, lineHeight, uppercase, italic, shadow}` |
| `image` | `src`, `fit:"cover"\|"contain"`, `radius`, `alt` |
| `rule` | decorative line: `color`, `thickness` |
| `group` | `children:[…]` positioned in % of the group |
| `video` | `src`, `mode:"inline"\|"lightbox"`, `poster`, `autoplay`, `loop`, `label` |
| `carousel` | `images:[…]`, `interval` ms, `autoplay`, `arrows`, `dots` |
| `map` | `q` (Maps query), `label`; pin at x,y or area with w,h |
| `link` | `href` (tel:/mailto:/https:), `label`; pin or area |
| `html` | trusted raw markup escape hatch |

Relative asset paths resolve inside the page's folder; `../page19/building.jpg`
reaches a sibling page's asset; absolute URLs pass through.

## Authoring workflow

1. Open `reference/page-NN.jpg` next to your editor.
2. Measure positions as percentages (Illustrator: x% = X_pt / 248 × 100,
   y% = Y_pt / 350.8 × 100 — the page is 248 × 350.8 pt).
3. Export the page's photos/icons into `pages/pageN/` and describe the page
   in `page.json`. Refresh — text scales with the page automatically
   (container-query units), including in the tray miniatures.

Already-composed examples to copy from: **page1** (cover), **page3**
(headline + map image + pins), **page19** (photo + lightbox film),
**page20** (arrow carousel), **page21** (5-second auto carousel + stats
group), **page22** (contact with tap-to-call / mailto / maps).
