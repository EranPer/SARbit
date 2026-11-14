"""Any method -> a SARbit mission folder. No FME, no GDAL bindings: rasterio + numpy + Pillow only.

Give it georeferenced GeoTIFFs (any CRS): a BEFORE picture, an AFTER picture and a CHANGE raster (a 0/1 mask, a
fraction, or a score + --threshold). Works for Sentinel-2 (true colour or single bands), NISAR amplitude,
InSAR coherence loss / displacement, anything. It writes exactly what the game reads (see public/missions/README.md):

  img0.png before (RGB)   img1.png after   img2.png change overlay   img3..img8.png grey layers
  grid.geojson (12 x 12 answer key)   mission.json   + the mission added to public/missions/index.json

Example (Sentinel-2, true colour + Ben's change mask):
  python pipeline/from_geotiff.py --id S2_VALENCIA --topic floods --title "Valencia from above" \
      --place "Gandia, Spain" --before s2_before.tif --after s2_after.tif --change changed_mask.tif \
      --before-date 2026-10-10 --after-date 2026-10-25 --sensor "Sentinel-2 L2A (ESA / Copernicus)" \
      --layer before:CO=s2_before_B08.tif --layer after:CO=s2_after_B08.tif --channels CO=NIR,CX=NIR

Without --layer the game's "glow" cards use grey versions of the before/after pictures.
"""
import argparse, json, os
import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform as warp_xy

WEB = "EPSG:3857"   # the PNGs must be Web Mercator so Leaflet places them exactly by their lat/lon corners
GRID = 12


def target_grid(path, max_px):
    with rasterio.open(path) as s:
        tr, w, h = calculate_default_transform(s.crs, WEB, s.width, s.height, *s.bounds)
    f = max(w, h) / max_px if max(w, h) > max_px else 1.0
    w2, h2 = int(round(w / f)), int(round(h / f))
    tr2 = rasterio.Affine(tr.a * w / w2, tr.b, tr.c, tr.d, tr.e * h / h2, tr.f)
    return tr2, w2, h2


def warp(path, tr, w, h, how):
    """All bands of `path` on the target grid, float32, NaN where there is no data."""
    with rasterio.open(path) as s:
        out = np.full((s.count, h, w), np.nan, "float32")
        for b in range(s.count):
            src = s.read(b + 1).astype("float32")
            if s.nodata is not None:
                src[src == s.nodata] = np.nan
            reproject(src, out[b], src_transform=s.transform, src_crs=s.crs, dst_transform=tr, dst_crs=WEB,
                      src_nodata=np.nan, dst_nodata=np.nan, resampling=how)
    return out


def stretch(arrays, lo_p=2, hi_p=98, db=False):
    """One shared stretch for every date, so colour differences are real change."""
    if db:
        arrays = [10 * np.log10(np.where(a > 0, a, np.nan)) for a in arrays]
    vals = np.concatenate([a[np.isfinite(a)].ravel() for a in arrays])
    lo, hi = np.percentile(vals, [lo_p, hi_p]) if vals.size else (0, 1)
    return [np.nan_to_num(np.clip((a - lo) / max(hi - lo, 1e-9), 0, 1) * 255).astype("uint8") for a in arrays], (lo, hi)


def picture(stack):
    """3+ bands -> RGB from bands 1-3; 1 band -> grey. Returns HxWx3 floats (NaN = no data)."""
    return np.moveaxis(stack[:3], 0, -1) if stack.shape[0] >= 3 else np.repeat(stack[0][..., None], 3, axis=2)


def save_rgba(rgb8, valid, path):
    Image.fromarray(np.dstack([rgb8, np.where(valid, 255, 0).astype("uint8")]), "RGBA").save(path, optimize=True)


def save_grey(g8, valid, path):
    Image.fromarray(np.dstack([g8, np.where(valid, 255, 0).astype("uint8")]), "LA").save(path, optimize=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id", required=True); ap.add_argument("--topic", required=True,
                    choices=["floods", "forest", "agriculture", "land", "marine"])
    ap.add_argument("--title", required=True); ap.add_argument("--place", default="")
    ap.add_argument("--story", default=""); ap.add_argument("--difficulty", type=int, default=2)
    ap.add_argument("--before", required=True); ap.add_argument("--after", required=True)
    ap.add_argument("--change", required=True, help="0/1 mask, 0-1 fraction, or a score with --threshold")
    ap.add_argument("--threshold", type=float, help="change = value > threshold (for score rasters)")
    ap.add_argument("--before-date", default=""); ap.add_argument("--after-date", default="")
    ap.add_argument("--layer", action="append", default=[], help="date:KIND=file.tif, KIND = CO | CX | RATIO")
    ap.add_argument("--channels", default="CO=HH,CX=HV", help="names shown in the game, e.g. CO=NIR,CX=SWIR")
    ap.add_argument("--layer-db", action="store_true", help="layers are linear radar power: show them in dB")
    ap.add_argument("--sensor", default="")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "missions"))
    ap.add_argument("--max-px", type=int, default=1024)
    a = ap.parse_args()

    out = os.path.join(a.out, a.id); os.makedirs(out, exist_ok=True)
    tr, w, h = target_grid(a.change, a.max_px)

    # 1 · before / after pictures, one shared stretch
    b, f = picture(warp(a.before, tr, w, h, Resampling.bilinear)), picture(warp(a.after, tr, w, h, Resampling.bilinear))
    (b8, f8), _ = stretch([b, f])
    save_rgba(b8, np.isfinite(b).all(axis=2), os.path.join(out, "img0.png"))
    save_rgba(f8, np.isfinite(f).all(axis=2), os.path.join(out, "img1.png"))

    # 2 · change -> fraction per output pixel -> red overlay
    c = warp(a.change, tr, w, h, Resampling.average)[0] if a.threshold is None else None
    if c is None:   # threshold first at full resolution, then average
        with rasterio.open(a.change) as s:
            m = (s.read(1).astype("float32") > a.threshold).astype("float32")
            c = np.full((h, w), np.nan, "float32")
            reproject(m, c, src_transform=s.transform, src_crs=s.crs, dst_transform=tr, dst_crs=WEB,
                      src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.average)
    frac = np.clip(np.nan_to_num(c), 0, 1)
    red = np.zeros((h, w, 4), "uint8"); red[..., 0], red[..., 1], red[..., 2] = 255, 40, 40
    red[..., 3] = (frac * 170).astype("uint8")
    Image.fromarray(red, "RGBA").save(os.path.join(out, "img2.png"), optimize=True)

    # 3 · grey building-block layers for the game's glow cards
    names = dict(kv.split("=") for kv in a.channels.split(","))
    files = {"before": {}, "after": {}}
    given = {}
    for spec in a.layer:
        date, rest = spec.split(":"); kind, path = rest.split("=")
        given[(date, kind)] = warp(path, tr, w, h, Resampling.bilinear)[0]
    if not given:   # fall back to grey versions of the two pictures
        given = {("before", "CO"): np.nanmean(b, axis=2), ("after", "CO"): np.nanmean(f, axis=2)}
    n = 3
    for kind in ("CO", "CX", "RATIO"):
        pair = [given.get(("before", kind)), given.get(("after", kind))]
        if any(p is None for p in pair):
            continue
        g8s, _ = stretch(pair, db=a.layer_db and kind != "RATIO")
        for date, p, g8 in zip(("before", "after"), pair, g8s):
            name = f"img{n}.png"; n += 1
            save_grey(g8, np.isfinite(p), os.path.join(out, name)); files[date][kind] = name
    if "CX" not in files["before"]:          # the game shows one pair of glasses when CO == CX
        names["CX"] = names.get("CO", "CO")
        for d in files: files[d]["CX"] = files[d]["CO"]

    # 4 · 12 x 12 answer key (row 0 = top), polygons in lat/lon
    feats = []
    for r in range(GRID):
        for col in range(GRID):
            y0, y1, x0, x1 = r * h // GRID, (r + 1) * h // GRID, col * w // GRID, (col + 1) * w // GRID
            share = float(frac[y0:y1, x0:x1].mean())
            xs, ys = [tr.c + tr.a * x for x in (x0, x1, x1, x0, x0)], [tr.f + tr.e * y for y in (y0, y0, y1, y1, y0)]
            lon, lat = warp_xy(WEB, "EPSG:4326", xs, ys)
            feats.append({"type": "Feature", "properties": {"hit": int(share >= 0.2), "share": share, "row": r, "col": col},
                          "geometry": {"type": "Polygon", "coordinates": [[[x, y] for x, y in zip(lon, lat)]]}})
    json.dump({"type": "FeatureCollection", "features": feats}, open(os.path.join(out, "grid.geojson"), "w"))

    # 5 · mission.json (same schema as the FME pipeline) + index.json
    lon, lat = warp_xy(WEB, "EPSG:4326", [tr.c, tr.c + tr.a * w], [tr.f + tr.e * h, tr.f])
    clon, clat = (lon[0] + lon[1]) / 2, (lat[0] + lat[1]) / 2
    mission = {"id": a.id, "topic": a.topic, "title": a.title, "place": a.place, "story": a.story,
               "lat": round(clat, 4), "lon": round(clon, 4), "difficulty": a.difficulty,
               "bbox": [lon[0], lat[0], lon[1], lat[1]],
               "before": {"date": a.before_date, "image": "img0.png"}, "after": {"date": a.after_date, "image": "img1.png"},
               "change_overlay": "img2.png", "channels": {"CO": names.get("CO", "CO"), "CX": names.get("CX", names.get("CO", "CO"))},
               "layers": files, "change_rule": {"channel": 0, "sign": -1, "thresh_db": 0, "water_max_db": 99},
               "grid": {"rows": GRID, "cols": GRID, "geojson": "grid.geojson"}, "sensor": a.sensor}
    json.dump(mission, open(os.path.join(out, "mission.json"), "w"), indent=1)
    idx_path = os.path.join(a.out, "index.json")
    idx = {m["id"]: m for m in (json.load(open(idx_path)) if os.path.exists(idx_path) else [])}
    idx[a.id] = {k: mission[k] for k in ("id", "topic", "title", "lat", "lon", "difficulty")}
    json.dump(sorted(idx.values(), key=lambda m: m["id"]), open(idx_path, "w"), indent=1)
    hits = sum(f["properties"]["hit"] for f in feats)
    print(f"{a.id}: {w}x{h} px, {hits}/144 changed cells -> {out}" + ("   (aim for 4-100 hits)" if not 4 <= hits <= 100 else ""))


if __name__ == "__main__":
    main()
