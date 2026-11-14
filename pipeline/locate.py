"""SARbit helper: find WHERE in the whole NISAR frame a mission's change actually is.

Reads both dates of the full frame at a coarse pixel (average of linear power, which also kills speckle),
applies the mission's change rule, slides the mission box over the frame and lists the windows with the
most change (both dates valid). Use it to move a box onto the event, then check against the news location.

  python3 locate.py L1                 # rule from run_all.py (RULES + TUNED)
  python3 locate.py L3 --sign 1        # override the direction
  python3 locate.py W1 --px 100        # finer search pixel (m)

Writes /data/nisar/locate/<mission>.png: frame change map (red), event point (yellow), top windows (cyan).
"""
import argparse, json, math, os, sys
import numpy as np
from osgeo import gdal, osr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clip import GRIDS, grid_of, layout  # noqa: E402
import run_all  # noqa: E402  (RULES / TUNED only; its main loop is guarded below)

gdal.UseExceptions()
ROOT = "/data/nisar"


def frame(h5, px):
    """(co_db, cx_db, x0, y0, epsg) of the whole frame at px metres."""
    freq, co, cx = layout(h5)
    epsg, x0, y0, dx, dy, nx, ny = grid_of(h5, freq)
    f = max(1, round(px / dx))
    bx, by = nx // f, ny // f
    out = []
    for ds in (co, cx or co):
        src = gdal.Open(f'HDF5:"{h5}":{GRIDS}{freq}/{ds}')      # keep the dataset alive while reading its band
        a = src.GetRasterBand(1).ReadAsArray(
            0, 0, bx * f, by * f, buf_xsize=bx, buf_ysize=by, resample_alg=gdal.GRIORA_Average).astype("float32")
        with np.errstate(divide="ignore", invalid="ignore"):
            out.append(np.where(a > 0, 10 * np.log10(a), np.nan))
    return out[0], out[1], x0, y0, dx * f, epsg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mission"); ap.add_argument("--px", type=float, default=200)
    ap.add_argument("--sign", type=int); ap.add_argument("--channel", type=int)
    ap.add_argument("--thresh", type=float); ap.add_argument("--water", type=float)
    ap.add_argument("--top", type=int, default=3)
    a = ap.parse_args()
    m = a.mission
    ch, sign, th, wm = run_all.RULES[m]
    t = run_all.TUNED.get(m, {})
    ch, sign = int(t.get("CHANNEL", ch)), int(t.get("SIGN", sign))
    th, wm = float(t.get("THRESH_DB", th)), float(t.get("WATER_MAX", wm))
    ch = a.channel if a.channel is not None else ch
    sign = a.sign if a.sign is not None else sign
    th = a.thresh if a.thresh is not None else th
    wm = a.water if a.water is not None else wm
    spec = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "missions.json")))[m]
    items = {i["role"]: i for i in json.load(open(f"{ROOT}/manifest.json")) if i["mission"] == m}
    h5 = lambda r: f"{ROOT}/{m}/{items[r]['url'].rsplit('/', 1)[1]}"
    b_co, b_cx, bx0, by0, bpx, epsg = frame(h5("before"), a.px)
    a_co, a_cx, ax0, ay0, apx, _ = frame(h5("after"), a.px)
    # put both dates on the after grid (same track/frame: offsets are whole pixels or close)
    ox, oy = round((ax0 - bx0) / apx), round((by0 - ay0) / apx)
    H, W = a_co.shape
    def shift(arr):
        out = np.full((H, W), np.nan, "float32")
        ys, xs = slice(max(0, -oy), min(H, arr.shape[0] - oy)), slice(max(0, -ox), min(W, arr.shape[1] - ox))
        out[ys, xs] = arr[ys.start + oy:ys.stop + oy, xs.start + ox:xs.stop + ox]
        return out
    b_co, b_cx = shift(b_co), shift(b_cx)
    bef, aft = (b_co, a_co) if ch == 0 else (b_cx, a_cx)
    valid = np.isfinite(bef) & np.isfinite(aft)
    with np.errstate(invalid="ignore"):
        chg = valid & (sign * (aft - bef) > th) & (aft < wm)
    w = max(3, round(spec["box_km"] * 1000 / apx))
    ii = lambda z: np.pad(z.astype("float64").cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    C, V = ii(chg), ii(valid)
    win = lambda S: S[w:, w:] - S[:-w, w:] - S[w:, :-w] + S[:-w, :-w]
    frac, vfrac = win(C) / (w * w), win(V) / (w * w)
    score = np.where(vfrac > 0.95, frac, -1)
    # event point in frame pixels
    src, dst = osr.SpatialReference(), osr.SpatialReference()
    src.ImportFromEPSG(4326); dst.ImportFromEPSG(epsg)
    for s in (src, dst): s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    fwd, inv = osr.CoordinateTransformation(src, dst), osr.CoordinateTransformation(dst, src)
    ex, ey, _ = fwd.TransformPoint(spec["lon"], spec["lat"])
    ec, er = (ex - ax0) / apx, (ay0 - ey) / apx
    print(f"{m}: frame {W}x{H} @ {apx:g} m, rule ch{ch} sign{sign:+d} {th} dB water<{wm}; "
          f"whole-frame changed {chg.sum() / max(valid.sum(), 1):.1%}")
    picks, s = [], score.copy()
    for _ in range(a.top):
        r, c = np.unravel_index(np.argmax(s), s.shape)
        if s[r, c] <= 0: break
        cx_m, cy_m = ax0 + (c + w / 2) * apx, ay0 - (r + w / 2) * apx
        lon, lat, _ = inv.TransformPoint(cx_m, cy_m)
        dist = math.hypot(c + w / 2 - ec, r + w / 2 - er) * apx / 1000
        picks.append((r, c)); print(f"  window {len(picks)}: centre {lat:.4f}, {lon:.4f}  changed {s[r, c]:.1%}  "
                                   f"{dist:.0f} km from the event point")
        s[max(0, r - w):r + w, max(0, c - w):c + w] = -1
    # current box, for comparison
    r0, c0 = int(round(er - w / 2)), int(round(ec - w / 2))
    if 0 <= r0 < score.shape[0] and 0 <= c0 < score.shape[1]:
        print(f"  current box: changed {frac[r0, c0]:.1%}, valid {vfrac[r0, c0]:.0%}")
    else:
        print("  current box: partly outside the frame")
    # quicklook
    g = np.nan_to_num(np.clip((aft + 25) / 25, 0, 1) * 200).astype("uint8")
    rgb = np.stack([g, g, g]); rgb[0][chg], rgb[1][chg], rgb[2][chg] = 255, 30, 30
    def box(r, c, col):
        for k, v in enumerate(col):
            rgb[k, r:r + w, c:c + 2] = rgb[k, r:r + w, c + w - 2:c + w] = v
            rgb[k, r:r + 2, c:c + w] = rgb[k, r + w - 2:r + w, c:c + w] = v
    for r, c in picks: box(r, c, (0, 230, 255))
    er_i, ec_i = int(er), int(ec)
    if 0 <= er_i < H and 0 <= ec_i < W:
        rgb[0, max(0, er_i - 4):er_i + 5, max(0, ec_i - 4):ec_i + 5] = 255
        rgb[1, max(0, er_i - 4):er_i + 5, max(0, ec_i - 4):ec_i + 5] = 230
        rgb[2, max(0, er_i - 4):er_i + 5, max(0, ec_i - 4):ec_i + 5] = 0
    os.makedirs(f"{ROOT}/locate", exist_ok=True)
    o = gdal.GetDriverByName("MEM").Create("", W, H, 3, gdal.GDT_Byte)
    for k in range(3): o.GetRasterBand(k + 1).WriteArray(rgb[k])
    gdal.Translate(f"{ROOT}/locate/{m}.png", o, format="PNG", width=min(W, 900), height=0)


if __name__ == "__main__":
    main()
