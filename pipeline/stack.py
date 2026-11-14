"""SARbit step 1b: one aligned 4-band stack per mission, so the FME workspace reads ONE raster and stays linear.

  bands: 1 before CO · 2 before CX · 3 after CO · 4 after CX   (linear power, Float32, 0 = no signal, no NoData flag)

Both dates go onto one grid: the after-date box, at the coarser of the two pixel sizes, so every
pixel of band 1 sits exactly under the same pixel of band 3 (the change map depends on it).
A missing CX (D3 before is HH-only) is filled with CO, and the mission is marked grey in stack.json.

  python3 stack.py            # every mission in /data/nisar/clips
  python3 stack.py W2 A1
"""
import glob, json, os, sys
from osgeo import gdal

gdal.UseExceptions()
CLIPS = "/data/nisar/clips"

def one(mid):
    d = f"{CLIPS}/{mid}"
    pick = lambda role, tag: (sorted(glob.glob(f"{d}/{role}_*_{tag}.tif")) or [None])[0]
    b_co, b_cx, a_co, a_cx = pick("before", "CO"), pick("before", "CX"), pick("after", "CO"), pick("after", "CX")
    if not (b_co and a_co):
        print(f"{mid}: missing a CO file, skipped"); return
    grey = not (b_cx and a_cx)
    if grey: b_cx, a_cx = b_co, a_co
    ref = gdal.Open(a_co); gt = ref.GetGeoTransform()
    px = max(abs(gt[1]), abs(gdal.Open(b_co).GetGeoTransform()[1]))
    bounds = (gt[0], gt[3] + gt[5] * ref.RasterYSize, gt[0] + gt[1] * ref.RasterXSize, gt[3])
    bands = []
    for f in (b_co, b_cx, a_co, a_cx):
        bands.append(gdal.Warp("", f, format="MEM", outputBounds=bounds, xRes=px, yRes=px,
                               resampleAlg="average", srcNodata=0, dstNodata=0))
    vrt = gdal.BuildVRT("", bands, separate=True)
    out = f"{d}/stack.tif"
    gdal.Translate(out, vrt, creationOptions=["COMPRESS=DEFLATE", "TILED=YES"], noData="none")   # FME: no NoData flag, 0 = no signal
    dates = {r: os.path.basename(f).split("_")[1] for r, f in (("before", b_co), ("after", a_co))}
    meta = {"mission": mid, "bands": ["before_CO", "before_CX", "after_CO", "after_CX"], "grey": grey,
            "pixel_m": px, "size": [ref.RasterXSize, ref.RasterYSize] if px == abs(gt[1]) else None, **dates}
    json.dump(meta, open(f"{d}/stack.json", "w"), indent=1)
    s = gdal.Open(out)
    print(f"{mid:8} {s.RasterXSize}x{s.RasterYSize} @ {px:g} m  bands {s.RasterCount}  {dates['before']} -> {dates['after']}"
          + ("  GREY (no cross-pol on one date)" if grey else ""))

if __name__ == "__main__":
    ids = sys.argv[1:] or sorted(os.listdir(CLIPS))
    for m in ids:
        if os.path.isdir(f"{CLIPS}/{m}"): one(m)
