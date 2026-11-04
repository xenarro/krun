# krun brand assets

The single source of truth for krun artwork, used by the repository README and
by the documentation site (`site/`). All of it is original; no third-party
logos are used anywhere.

| File | Use |
|---|---|
| `logo-light.svg` | Mark and wordmark for light backgrounds (ink wordmark). |
| `logo-dark.svg` | Mark and wordmark for dark backgrounds (paper wordmark). |
| `mark.svg` | The mark alone: a notched ticket carrying a monoline `k` whose arm ends in a station dot. |
| `favicon.svg` | The mark simplified for 16 to 32 pixels. The site copies it to `site/public/` at build time. |
| `apple-touch-icon.png` | 180 × 180 home-screen icon: `favicon.svg` on ink. The site copies it to `site/public/`. |
| `og-image.png` | 1200 × 630 social preview. The site copies it to `site/public/` and links it from every page. |
| `og-image.html` | Source of `og-image.png`; it uses the site's self-hosted fonts. |

## The idea

Every run is a one-way ticket. It is issued over HTTP, rides one line of
stations (QUEUED, SCHEDULED, RUNNING) and stops at a terminal (SUCCEEDED,
FAILED or CANCELLED). The ticket notch and the route line with station dots are
the two shapes the site repeats; the wordmark is drawn with the same rounded
line.

| Token | Hex | Role |
|---|---|---|
| Signal | `#FF5A1F` | Brand fill, the run line. Pair with ink text. |
| Volt | `#D4F53C` | Success and highlights. Pair with ink text. |
| Ink | `#17151E` | Text on paper; the dark theme background is `#121016`. |
| Paper | `#F7F3EA` | Light background; text on ink. |

Signal and Volt are fills, not text colours on paper: their contrast there is
below WCAG AA. Text-safe accents live in `site/src/styles/tokens.css`.

## Using the logo in Markdown

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo-light.svg" alt="krun" width="196" height="64">
</picture>
```

## Regenerating the social preview

From the repository root, with any headless Chromium:

```sh
chrome-headless-shell --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=3000 \
  --screenshot="$PWD/docs/assets/og-image.png" "file://$PWD/docs/assets/og-image.html"
```
