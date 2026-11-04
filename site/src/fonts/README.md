# Site fonts

The site self-hosts two variable fonts, both under the SIL Open Font License 1.1
(license texts beside the files). Neither declares a Reserved Font Name.

| File | Source | Axes kept |
|---|---|---|
| `bricolage-grotesque-latin.woff2` | `ofl/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf` in [google/fonts](https://github.com/google/fonts) at `6ce172f7` | `opsz` 12–96, `wght` 400–800 (`wdth` pinned to 100) |
| `jetbrains-mono-latin.woff2` | `ofl/jetbrainsmono/JetBrainsMono[wght].ttf` in google/fonts at `6e4b84c9` | `wght` 100–800 |

Both files are subset to Latin, Latin-1, general punctuation, arrows and a few
math symbols, then compressed to WOFF2 with fontTools:

```sh
uvx --from 'fonttools[woff]' fonttools varLib.instancer \
  'BricolageGrotesque[opsz,wdth,wght].ttf' wght=400:800 wdth=100 -o bricolage.ttf
uvx --from 'fonttools[woff]' pyftsubset bricolage.ttf --flavor=woff2 \
  --layout-features=kern,liga,calt,mark,mkmk,case --name-IDs='*' \
  --unicodes='U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2013-2014,U+2018-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+2713,U+2715,U+25CF,U+25CB' \
  --output-file=bricolage-grotesque-latin.woff2
uvx --from 'fonttools[woff]' pyftsubset 'JetBrainsMono[wght].ttf' --flavor=woff2 \
  --layout-features=kern,mark,mkmk --name-IDs='*' --unicodes='<same ranges>' \
  --output-file=jetbrains-mono-latin.woff2
```

`src/styles/fonts.css` declares the faces with `font-display: swap`, and the
`Head` override preloads the Bricolage Grotesque file.
