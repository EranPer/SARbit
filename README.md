This solution was developed as part of NASA Space Apps Tel Aviv 2026. The event was led by the Space Engineering Center (SEC) and SpaceTAU at Tel Aviv University, in partnership with the Rakia Mission and Space Campus IL.

# SARbit · Radar Cleanup

**A kids' web game for the NASA Space Apps Challenge 2026, challenge _Dancing with the SARs_.**
An alien with a radar flies over Earth. In every mission the player compares a BEFORE and an AFTER radar picture of a
real 2026 event, makes the change **glow**, finds it, and learns why radar sees what cameras can't.

- ▶ **Play:** https://sarbit-radar-cleanup.vercel.app (any browser, phones too, no sign-up)
- 🎞 **Project demo (7 slides):** https://sarbit-radar-cleanup.vercel.app/pitch/ · [PDF](docs/SARbit-demo.pdf)
- 👥 **Team:** SARbit, a [MENASIM](https://www.menasim.org/home-en) team: Eran, Yonatan, Ben · mentor Yakov Geltser

## What it does

Radar pictures are grey, grainy and look "backwards" (water is black, forests glow), so almost nobody outside the field
can read them. SARbit turns real NISAR radar into a game a 10-year-old can play in five minutes:

| Step | What the player does | The SAR idea behind it |
|---|---|---|
| 👀 **Look** | slides between the BEFORE and AFTER radar pictures | radar sends its own microwaves: it sees at night and through clouds |
| ✨ **Glow** | drags BEFORE into red and AFTER into blue-green | a colour composite: unchanged ground turns grey, every change glows |
| 🎯 **Find** | taps the glowing spots, lassoes cut forest, hunts oil platforms, checks fields, orders the seasons | change detection in decibels, polarisation (HH / HV) |
| ⭐ **Score** | stars, points, and a change map we made from the NISAR data to compare with | |

- **🎓 Radar school** (Jezreel Valley, Israel) is a step-by-step training mission that opens first for every new player.
- **7 real 2026 events:** floods in Valencia (Spain) and Limpopo (Mozambique), forest clearing along the BR-163 (Amazon),
  the Punjab rice season (India), the Jezreel Valley harvest (Israel), the shrinking Great Salt Lake (USA), and the oil
  platforms of the Mississippi Delta (USA).
- **🧪 Radar Lab:** four extra games on real SAR techniques: paint with polarisations (HH/HV → RGB), tune a flood
  threshold in dB, clean speckle (multi-looking), and sort echoes by backscatter.
- Several players per device, and a world leaderboard.

**The glow never lies.** The game works out the answers in the browser from the same radar layers the player sees
(blocks whose backscatter moved ≥ 3 dB, joined into spots). Nothing is hand-drawn, and claims that depend on the data
(for example which polarisation shows the change best) are measured on that mission's pictures.

## NASA data and resources

- **NISAR L-band GCOV** (NASA-ISRO), from the **ASF DAAC**: HH and HV backscatter, two dates per event on the same orbit track.
- **NASA GIBS:** VIIRS true colour, and HLS (Landsat + Sentinel-2) for the "could a normal camera see the ground?" question.
- Space Agency Partner data: ISRO co-built NISAR; ESA Sentinel-2 comes in through NASA's HLS.

## How it's built

- `public/`: the game. Plain HTML, CSS and JavaScript with [Leaflet](https://leafletjs.com); no build step. Hosted on Vercel.
- `public/missions/<ID>/`: one folder per mission (pictures in Web Mercator, an answer grid, `mission.json`);
  `public/missions/content.json` holds the stories, news links and game settings.
- `pipeline/`: how the missions are made: NISAR HDF5 → GDAL clip → FME → web pictures and answer grid
  (`run_all.py`), plus `from_geotiff.py`, which turns any georeferenced GeoTIFF method into a new mission.
- `api/scores.js`: the world leaderboard (a Vercel function with Redis).

Run it locally: `python -m http.server 8765 --directory public`, then open http://localhost:8765.
`CLAUDE.md` is the team's full working guide (data contract, how to add a mission or a mini-game).

## Use of AI (disclosed)

- **Images:** the alien, icons and mission cards were generated with **Grok Imagine** and are marked "AI art" in the game
  and on the slides.
- **Code and text:** written with help from **Claude Code**; the data checks and science choices are the team's.

## Credits

NISAR (NASA-ISRO) via ASF DAAC · NASA GIBS (VIIRS, HLS) · © OpenStreetMap contributors · Esri World Imagery ·
Leaflet · GDAL · FME · MENASIM. News links in the game belong to their publishers.
