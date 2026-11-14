# Mission data (NISAR, made by `pipeline/`)

`index.json` lists the missions (id, topic, title, lat, lon, difficulty). Each `<id>/` folder has:

| File | What | Use in the game |
|---|---|---|
| `mission.json` | everything below + bbox, dates, channel names, change rule | read this first |
| `img0.png` / `img1.png` | before / after, ready-made colour (R = co-pol, G = cross-pol, B = co-pol) | slider, "answer" view |
| `img2.png` | change overlay, red with transparency | the reveal |
| `img3`–`img6.png` | grey layers: before co, before cross, after co, after cross | **drag-and-drop building blocks** |
| `img7` / `img8.png` | grey layers: co − cross ratio, before / after | building block (surface vs canopy) |
| `grid.geojson` | 12 × 12 cells: `hit` (1 = changed ≥ 20 %), `share` (0–1), `row`, `col` | answer key / scoring |

**Placing images on a Leaflet map:** `L.imageOverlay(url, [[bbox[1], bbox[0]], [bbox[3], bbox[2]]])`
(bbox = `[minLon, minLat, maxLon, maxLat]`, images are Web Mercator).

**Grey layers share one scale on every mission:** grey value `v` → dB = `v / 6.375 − 35` (co/cross),
ratio dB = `v / 12.75`. So a mix the player builds looks the same on every mission, and a contrast slider
can re-stretch in the browser.

**Channels:** `mission.json.channels` gives the real names: HH + HV on most missions, VV + VH on M2,
HH only on D3 (cross = co there).

Data: NASA-ISRO NISAR L2 GCOV (L-band), ASF DAAC.
