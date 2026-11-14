# SARbit FME workspace: `sarbit_mission.fmw`

One workspace for every mission. Tested on W2 (Mozambique floods), 14 Nov 09:43: before / after / change PNGs,
a 12×12 grid with 36 hits, mission.json with the right bbox and dates.

## Pipeline

```
NISAR .h5 ──clip.py──> clips/<M>/{before,after}_<date>_{CO,CX}.tif ──stack.py──> clips/<M>/stack.tif (4 bands, one grid)
                                                                                        │
                                                                    sarbit_mission.fmw  ▼
  0 READ stack ─ 1 dB ─ 2 median 5×5 ─ 3 resize 1024 ─ 4 change map (band 5) ─ 5 to Web Mercator ─┬─ images
                                                                                                 ├─ grid
                                                                                                 └─ mission.json
  images : 6 paint 36 bands ─ 7 nine copies ─ 8 band list per copy ─ 9 mark ─ 10 keep ─ PNG img0…img8
  grid   : 11 12×12 tiles ─ 12 share changed ─ 13 tile → cell ─ 14 hit (≥ 20 %) ─ 15 to lat/lon ─ GeoJSON
  json   : 16 footprint ─ 17 to lat/lon ─ 18 corners ─ 19 text ─ 20 write mission.json
```

Every transformer has an annotation in Workbench saying what it does and why.

Out: `/data/nisar/out/<MISSION>/`

| File | What | For the game |
|---|---|---|
| `img0.png` / `img1.png` | before / after, ready-made colour (R co, G cross, B co) | the "answer" view |
| `img2.png` | change overlay, red RGBA | the reveal |
| `img3`…`img6.png` | grey layers: before co, before cross, after co, after cross | **building blocks**: the player puts them into R/G/B |
| `img7` / `img8.png` | grey layers: co − cross ratio, before / after | building block: surface vs canopy scattering |
| `grid.geojson` | 144 cells: `hit`, `share`, `row`, `col` | answer key |
| `mission.json` | bbox, dates, which file is which, channel names, layer scales, change rule | everything the game reads |

Layer scales are the same for every mission (grey 0…255 = −35…+5 dB; ratio 0…255 = 0…20 dB), so a player's
mix looks the same on every mission and a slider can re-stretch them in the browser.
Channels are dual-pol: HH+HV on most missions, VV+VH on M2, HH only on D3 (CX = CO there). No mission has
HH and VV together.

## Parameters

| Name | Meaning | W2 |
|---|---|---|
| MISSION | folder in `/data/nisar/clips` | `W2` |
| BEFORE / AFTER | dates written into mission.json | `2026-01-05` / `2026-01-17` |
| CHANNEL | 0 = co-pol (HH/VV) · 1 = cross-pol (HV/VH) | `0` |
| SIGN | −1 = got darker · 1 = got brighter | `-1` |
| THRESH_DB | minimum change in dB | `3` |
| WATER_MAX | after value must be below this (floods −18; otherwise 99 = off) | `-18` |
| CO_NAME / CX_NAME | channel names written into mission.json | `HH` / `HV` |

Per topic: floods `0 / -1 / 3 / -18` · forest, fire `1 / -1 / 3 / 99` · crops `1 / 1 / 3 / 99` ·
lava, lake `0 / -1 / 3 / 99` · oil `0 / -1 / 6 / 99`. Aim for 4–100 hits; move THRESH_DB if outside.

## Run all

`python3 run_all.py` (dates from stack.json, channel names from clips/summary.csv, rule per topic in RULES).

## Run one

```bash
distrobox enter fme -- /opt/fme-form-2026.3/fme ~/sarbit/pipeline/sarbit_mission.fmw \
  --MISSION W2 --BEFORE 2026-01-05 --AFTER 2026-01-17 --CHANNEL 0 --SIGN -1 --THRESH_DB 3 --WATER_MAX -18
```
Or in Workbench: Run → the parameter prompt asks for each value.

## Things learnt building it (FME 2026.3 on Linux)

- FME's bundled HDF5 has no deflate filter → it can't read NISAR pixels. GDAL clips first (`clip.py`).
- Raster expressions can't read attributes, and `@min/@max` don't exist there (clamp with `@if`).
- RasterSelector only marks bands; RasterBandKeeper does the removing.
- A NoData value of 0 swallows real zeros (0 dB, "no change"). The stack has no NoData flag; no signal = −99 dB.
- `build_fmw.py` regenerates the workspace from `skeleton.fmw` (`fme RESAVE_WORKSPACE`). Edits made in Workbench
  live only in `sarbit_mission.fmw`: once you start editing there, stop using `build_fmw.py`.
