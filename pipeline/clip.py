"""SARbit step 1: cut each mission box out of the NISAR GCOV files -> georeferenced GeoTIFFs for FME.

FME 2026.3 on Linux can't decompress NISAR HDF5 (its HDF5 lacks deflate), so GDAL does the cut.
GDAL doesn't georeference the HDF5 subdataset either, so the grid comes from the file itself:
EPSG from .../frequencyA/projection, pixel centres from xCoordinates / yCoordinates.

  python3 clip.py              # every mission in /data/nisar/manifest.json
  python3 clip.py W1 D3        # just these

Modes differ per file: DHDH = HH+HV on frequency A; NADV = VV+VH on frequency B only; SHSH = HH only.
So outputs are named by role, not polarisation: CO = co-pol (HH or VV), CX = cross-pol (HV or VH, if any).

Out: /data/nisar/clips/<mission>/<role>_<YYYYMMDD>_{CO,CX}.tif (linear power, Float32, 0 = no data, flagged as NoData)
     /data/nisar/clips/<mission>/preview_<role>_<YYYYMMDD>.png (dB RGB = CO,CX,CO, or grey CO; QA only)
     /data/nisar/clips/summary.csv
"""
import csv, json, math, os, sys
import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
ROOT = "/data/nisar"
HERE = os.path.dirname(os.path.abspath(__file__))
GRIDS = "//science/LSAR/GCOV/grids/"
STRETCH = {"CO": (-25.0, 0.0), "CX": (-32.0, -8.0)}
CO, CX = ("HHHH", "VVVV"), ("HVHV", "VHVH")

def layout(h5):
    """The frequency group holding a co-pol image, and which co/cross channels it has."""
    names = [v for k, v in gdal.Open(h5).GetMetadata("SUBDATASETS").items() if k.endswith("_NAME")]
    for freq in ("frequencyA", "frequencyB"):
        have = {n.rsplit("/", 1)[1] for n in names if f"/grids/{freq}/" in n}
        co = next((p for p in CO if p in have), None)
        if co:
            return freq, co, next((p for p in CX if p in have), None)
    raise ValueError("no co-pol image in the file")

def grid_of(h5, freq):
    sub = lambda n: gdal.Open(f'HDF5:"{h5}":{GRIDS}{freq}/{n}')
    x = sub("xCoordinates").ReadAsArray().ravel()
    y = sub("yCoordinates").ReadAsArray().ravel()
    epsg = int(gdal.Open(h5).GetMetadataItem(f"science_LSAR_GCOV_grids_{freq}_projection_epsg_code"))
    dx, dy = float(x[1] - x[0]), float(y[0] - y[1])           # y runs north -> south
    return epsg, x[0] - dx / 2, y[0] + dy / 2, dx, dy, len(x), len(y)   # centres -> outer edges

def to_utm(epsg, lat, lon):
    src, dst = osr.SpatialReference(), osr.SpatialReference()
    src.ImportFromEPSG(4326); dst.ImportFromEPSG(epsg)
    for s in (src, dst): s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    x, y, _ = osr.CoordinateTransformation(src, dst).TransformPoint(lon, lat)
    return x, y

def db(a):
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(a > 0, 10 * np.log10(a), np.nan)

def to8(d, lo, hi):
    return np.nan_to_num(np.clip((d - lo) / (hi - lo), 0, 1) * 255).astype("uint8")

def write(path, bands, gt, epsg, dtype, nodata=None):
    srs = osr.SpatialReference(); srs.ImportFromEPSG(epsg)
    o = gdal.GetDriverByName("GTiff").Create(path, bands[0].shape[1], bands[0].shape[0], len(bands), dtype,
                                             ["COMPRESS=DEFLATE", "TILED=YES"])
    o.SetGeoTransform(gt); o.SetProjection(srs.ExportToWkt())
    for i, b in enumerate(bands, 1):
        band = o.GetRasterBand(i); band.WriteArray(b)
        if nodata is not None: band.SetNoDataValue(nodata)
    o.FlushCache()

def main(only):
    missions = json.load(open(os.path.join(HERE, "missions.json")))
    items = [m for m in json.load(open(f"{ROOT}/manifest.json")) if not only or m["mission"] in only]
    rows = []
    for m in items:
        mid, role, date = m["mission"], m["role"], m["time"][:8]
        h5 = f"{ROOT}/{mid}/{m['url'].rsplit('/', 1)[1]}"
        spec = missions[mid]
        try:
            freq, co, cx = layout(h5)
        except Exception as e:
            print(f"{mid} {role} {date}: {e} SKIPPED"); rows.append([mid, role, date, "", "", "", "", "", "", str(e)]); continue
        epsg, x0, y0, dx, dy, nx, ny = grid_of(h5, freq)
        ux, uy = to_utm(epsg, spec["lat"], spec["lon"])
        half = spec["box_km"] * 500.0
        col = math.floor((ux - half - x0) / dx); row = math.floor((y0 - (uy + half)) / dy)
        n_c = round(2 * half / dx); n_r = round(2 * half / dy)
        if col < 0 or row < 0 or col + n_c > nx or row + n_r > ny:
            print(f"{mid} {role} {date}: box leaves the frame (col {col}, row {row}, {n_c}x{n_r} of {nx}x{ny}) SKIPPED")
            rows.append([mid, role, date, freq, co, cx or "", epsg, "", "", "box outside frame"]); continue
        gt = (x0 + col * dx, dx, 0.0, y0 - row * dy, 0.0, -dy)
        out = f"{ROOT}/clips/{mid}"; os.makedirs(out, exist_ok=True)
        dbs, valid = {}, []
        for tag, ds in (("CO", co), ("CX", cx)):
            if not ds: continue
            a = gdal.Open(f'HDF5:"{h5}":{GRIDS}{freq}/{ds}').ReadAsArray(col, row, n_c, n_r).astype("float32")
            write(f"{out}/{role}_{date}_{tag}.tif", [np.where(a > 0, a, 0).astype("float32")], gt, epsg, gdal.GDT_Float32, 0.0)
            dbs[tag] = db(a); valid.append(float(np.isfinite(dbs[tag]).mean()))
        c8 = to8(dbs["CO"], *STRETCH["CO"])
        rgb = (c8, to8(dbs["CX"], *STRETCH["CX"]), c8) if "CX" in dbs else (c8, c8, c8)
        prev = f"{out}/preview_{role}_{date}.png"
        mem = gdal.GetDriverByName("MEM").Create("", n_c, n_r, 3, gdal.GDT_Byte)
        for i, b in enumerate(rgb, 1): mem.GetRasterBand(i).WriteArray(b)
        gdal.Translate(prev, mem, format="PNG", width=min(n_c, 1024), height=0)
        med = lambda d: float(np.nanmedian(d)) if np.isfinite(d).any() else float("nan")
        cxm = med(dbs["CX"]) if "CX" in dbs else float("nan")
        print(f"{mid:8} {role:6} {date}  {freq[-1]} {co[:2]}/{(cx or '--')[:2]}  EPSG {epsg}  {n_c}x{n_r} @ {dx:g} m  "
              f"valid {min(valid):.0%}  CO {med(dbs['CO']):.1f} dB  CX {cxm:.1f} dB")
        rows.append([mid, role, date, freq, co, cx or "", epsg, f"{dx:g}", f"{min(valid):.3f}",
                     f"{med(dbs['CO']):.1f}", f"{cxm:.1f}"])
    os.makedirs(f"{ROOT}/clips", exist_ok=True)
    done = {r[0] for r in rows}                     # keep other missions' rows when clipping only some
    old = []
    if os.path.exists(f"{ROOT}/clips/summary.csv"):
        old = [r for r in list(csv.reader(open(f"{ROOT}/clips/summary.csv")))[1:] if r and r[0] not in done]
    rows = old + rows
    with open(f"{ROOT}/clips/summary.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["mission", "role", "date", "freq", "co_pol", "cx_pol", "epsg", "pixel_m", "valid_frac", "co_db_median", "cx_db_median"]); w.writerows(rows)

if __name__ == "__main__":
    main(set(sys.argv[1:]))
