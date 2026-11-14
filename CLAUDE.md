# SARbit: team guide (read this first)

**SARbit** is a kids' web game for NASA Space Apps 2026, challenge *Dancing with the SARs*. An alien flies over
Earth with a radar. In every mission the player compares a BEFORE and an AFTER radar picture of a real 2026
event, makes the change **glow**, marks the squares that changed, and scores points.

- **Live:** https://sarbit-three.vercel.app (every push to `main` redeploys in about a minute)
- **Repo:** https://github.com/EranPer/SARbit
- **State on Sat 14 Nov, 11:15:** playable, 8 real NISAR missions, Easy mode with explanations and hints.

If you are a Claude session: read this whole file before you change anything, then `git pull`.

---

## 1 · Rules that can get us disqualified (or not)

- **All project work happens from Sat 14 Nov 09:00.** Tools that existed before are fine to *use*
  (e.g. Ben's Sentinel-2 app from August, GDAL, FME), but list them as pre-existing in the submission.
  Don't paste old code into this repo as if it were new.
- **List every AI tool** in the submission (Claude Code, image generators, …) and what it did.
- **No secrets in the repo**: no `.env`, Copernicus / Earthdata tokens, API keys. They stay on your machine.
- Project page and video in **English**. After editing the submission, press Submit again.

## 2 · How the site works

- Vercel serves **`public/` as the web root**. Everything web-facing goes in `public/`. (A root `index.html`
  is *not* served. We learnt that the hard way: the site 404'd.)
- No build step: `public/index.html` + `public/css/style.css` + `public/js/app.js`, plain JS, Leaflet from unpkg.
- Run locally: `python -m http.server 8765 --directory public` → http://localhost:8765
- `git pull` before you start, commit small, push often. Two people editing `app.js` at once will conflict:
  put new code in **new files** (see §6) and keep `app.js` changes small.
- Keep each mission folder ≤ ~10 MB and `public/` < ~100 MB in total.

## 3 · Repo map

| Path | What | Who |
|---|---|---|
| `public/index.html`, `css/`, `js/app.js` | the game (intro, world map, 4-step mission, end) | game owner (now: Yonatan + Claude) |
| `public/missions/<ID>/` | one folder per mission: images, answer grid, `mission.json` | whoever makes the data |
| `public/missions/index.json` | the list of missions on the world map | written by the scripts |
| `public/missions/README.md` | the data contract in short | |
| `pipeline/` | how the data is made: NISAR → GDAL clip → FME → `package.py`; plus `from_geotiff.py` for any other method | Yonatan (NISAR), Ben (Sentinel-2, InSAR) |

## 4 · The data contract: the only thing data and game must agree on

**The method doesn't matter (FME, Python, Sentinel Hub, ISCE, SNAP…). The outputs do.** A mission is a folder
`public/missions/<ID>/` with:

| File | What | Game step |
|---|---|---|
| `img0.png`, `img1.png` | BEFORE / AFTER picture (RGB or grey, RGBA PNG) | 1 · Look (swipe) |
| `img2.png` | change overlay: red, alpha = how much changed | 4 · Check |
| grey layers (names given in `mission.json.layers`) | one per date and channel, same stretch for both dates | 2 · Glow (the BEFORE / AFTER cards) |
| `grid.geojson` | 12 × 12 polygons in lat/lon: `row` (0 = top), `col`, `share` (0–1), `hit` (1 if share ≥ 0.2) | 3 · Mark / 4 · Check (the answer key) |
| `mission.json` | everything below | all |

```json
{
 "id": "W2", "topic": "floods", "title": "Limpopo floods", "place": "Chokwe, Mozambique",
 "story": "One kid-level sentence about what happened (optional; the game has a fallback).",
 "lat": -24.5, "lon": 33.0, "difficulty": 1,
 "bbox": [32.8022, -24.6805, 33.1977, -24.3192],
 "before": {"date": "2026-01-05", "image": "img0.png"}, "after": {"date": "2026-01-17", "image": "img1.png"},
 "change_overlay": "img2.png",
 "channels": {"CO": "HH", "CX": "HV"},
 "layers": {"before": {"CO": "img3.png", "CX": "img4.png"}, "after": {"CO": "img5.png", "CX": "img6.png"}},
 "change_rule": {"channel": 0, "sign": -1, "thresh_db": 3, "water_max_db": -18},
 "grid": {"rows": 12, "cols": 12, "geojson": "grid.geojson"},
 "sensor": "NISAR L-band (NASA-ISRO), ASF DAAC"
}
```

Hard rules:
- PNGs are **Web Mercator (EPSG:3857)** and `bbox` = their corners in lon/lat `[minLon, minLat, maxLon, maxLat]`.
  That's what makes `L.imageOverlay` sit exactly on the basemap.
- `topic` is one of `floods`, `forest`, `agriculture`, `land`, `marine` (colours, explanations and glasses tips use it).
- **Before and after must be the same geometry** (same orbit track / same grid). Mixed geometry = fake change.
- A good mission has **4–100 hit cells** of 144. 0 hits = the box missed the event; 130 = the whole box changed.
- `channels.CO` is shown as "💧 water" glasses, `CX` as "🌿 plants". If you only have one channel, set CX = CO
  and point both layer entries at the same files: the game then shows one pair of glasses.

## 5 · Add a mission with ANY method (no FME needed)

`pipeline/from_geotiff.py` needs only `rasterio numpy Pillow`. Give it georeferenced GeoTIFFs in any CRS:

```bash
python pipeline/from_geotiff.py --id S2_GANDIA --topic floods --title "Gandia from above" --place "Gandia, Spain" \
  --before s2_before_truecolour.tif --after s2_after_truecolour.tif --change changed_mask.tif \
  --before-date 2026-10-10 --after-date 2026-10-25 --sensor "Sentinel-2 L2A (ESA / Copernicus)" \
  --layer before:CO=s2_before_B08.tif --layer after:CO=s2_after_B08.tif --channels CO=NIR,CX=NIR
```

- `--change`: a 0/1 mask, a 0–1 fraction, or any score with `--threshold X` (e.g. coherence loss, Otsu score).
- `--layer date:KIND=file` (KIND = CO / CX / RATIO) gives the glow cards. Without layers it uses grey versions
  of the pictures. Add `--layer-db` for linear radar power.
- It writes the folder, adds the mission to `index.json` and prints the hit count. Then run the site locally, play
  the mission once, and push.
- Tested 14 Nov on the NISAR W2 clips: same bbox as the FME output to 0.0001°, plays end to end.

## 6 · Ben: where Sentinel-2 and InSAR fit

**Sentinel-2 change detection (your Streamlit tool).** Your change mask is exactly a `--change` input. Export from
your pipeline: the two true-colour GeoTIFFs, the changed-pixel mask GeoTIFF, and B08 (NIR) for both dates as
layers, then run `from_geotiff.py`. Your README's caveat applies here too: Otsu always finds a split, so check the
previews before shipping a mission.

Best use in the game (proposal): an **"👁 Optical vs 📡 Radar"** moment in step 1 of a NISAR mission. Show the
Sentinel-2 picture of the same day, often full of clouds, next to the radar that sees through them. Suggested
optional block in `mission.json` (the game ignores fields it doesn't know, so adding it breaks nothing):

```json
"optical": {"sensor": "Sentinel-2 L2A", "before": {"date": "2026-10-10", "image": "s2_before.png", "cloud_pct": 3},
            "after": {"date": "2026-10-20", "image": "s2_after.png", "cloud_pct": 78}}
```

Same rules: EPSG:3857 PNG, same `bbox` as the mission (warp to that bbox).

**InSAR (your interferometry).** Two uses:
1. **Coherence loss = change.** Coherence drops where the ground surface changed (flood, clearing, collapse).
   A `1 − coherence` raster (or a coherence-drop mask) is a perfect `--change` input for any topic.
2. **A new mini-game: "count the rainbow rings".** A wrapped interferogram shows coloured fringes; each full
   colour cycle = half a wavelength of ground motion toward the satellite (NISAR L-band ≈ 12 cm per fringe,
   Sentinel-1 C-band ≈ 2.8 cm). Good for volcano (Kamchatka L2), earthquake, or Dead Sea sinkhole missions.
   Suggested block:

```json
"insar": {"pair": ["2026-06-23", "2026-10-21"], "fringes": "insar_wrapped.png", "coherence": "insar_coh.png",
          "wavelength_cm": 24.0, "fringe_cm": 12.0, "max_displacement_cm": 35}
```

Missions that still need a better source (good targets for your methods): **L1** Thunder Bay fire (burn scar is
clearer in Sentinel-2 or InSAR coherence), **D2** Lábrea clearing, **M1 / M2** oil slicks, **L2** Kamchatka lava
(InSAR!), **W3** Crete.

## 7 · The game today and how to add a mini-game

Flow: intro → world map (pins from `index.json`) → mission in 4 steps → finish.
1. **👀 Look:** before ⇄ after swipe. 2. **✨ Glow:** drag BEFORE / AFTER cards into the red / blue-green buckets;
radar glasses switch CO/CX. 3. **✏️ Mark:** paint squares on a 6 × 6 board (made from the 12 × 12 answer key).
4. **✅ Check:** points = 1000 × (found − ½ × wrong) ÷ changed squares.

Easy mode (`MODE` in `app.js`): "?" explanations, hint button, story line. Hard mode (no hints, 12 × 12) is planned.

**New mini-games** (minesweeper, snake, flappy…): put each in its own file `public/js/games/<name>.js` exposing
`start(mission, map, done)` where `done(points)` returns the score. Add `"games": ["grid", "<name>"]` to the
missions it suits. Hooking it into `app.js` is a few lines; ask the game owner before rewriting `app.js`.

## 8 · To do (open: say in the chat which one you take)

From Eran (14 Nov 10:44):
1. Rename the app and the alien.
2. Opening animation: the alien arrives at Earth (back-story).
3. A round Earth (globe), the alien's spaceship watching it.
4. Menus on the left of the globe.
5. Per-mission side panel: background, the news event, etc. (needs `story` + sources in `mission.json`).
6. More games: minesweeper, snake, flappy bird styles (see §7).
7. At the end: leaderboard in the centre with a trophy.
8. The alien flies back to its planet.

Also open:
- Shared online leaderboard (Vercel function + Upstash). Today it's per-device `localStorage`.
- Mission texts (`story`, sources) for every mission. Art (Nano Banana or similar, list it as AI use).
- Hard mode. Phone / tablet test (painting squares on touch).
- Better data for L1, D2, M1, M2, L2, W3 (§6). Submission page + pitch + 30 s demo video.

## 9 · Things we learnt (save yourself the time)

- FME 2026.3 on Linux can't read NISAR HDF5 pixels (its HDF5 has no deflate) → GDAL clips first (`pipeline/clip.py`).
- NISAR GCOV coordinates are **pixel centres**; EPSG is in `…/frequencyA/projection`. Some files are VV/VH on
  frequency B (Cantarell) or HH only (one Weda Bay date).
- Don't lower change thresholds below ~2 dB to "find" change: you get speckle, not events.
- Swath edges and sea surface make fake change. Always look at the pictures before shipping a mission.
- CSS `display:` on an element overrides the `hidden` attribute; `public/css/style.css` has `[hidden]{display:none!important}`.
