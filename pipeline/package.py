"""SARbit step 4: copy finished missions from /data/nisar/out into the game repo.

- img0-img2 (colour pictures, change overlay) are copied as they are (RGBA).
- img3-img8 (grey building-block layers) are rewritten as grey + alpha PNGs: same pixels, about a third the size.
- public/missions/index.json lists every packaged mission for the world map.

  python3 package.py ~/sarbit/SARbit W2 D1 A3 A1 M3 D3
"""
import json, os, shutil, sys
from osgeo import gdal

gdal.UseExceptions()
OUT = "/data/nisar/out"
MISSIONS = {  # id: (topic, title, place, lat, lon, difficulty 1 easy - 3 hard)
    "W1": ("floods", "Valencia flash floods", "Gandia, Valencia, Spain", 38.97, -0.18, 1),
    "W2": ("floods", "Limpopo floods", "Chokwe, Mozambique", -24.5, 33.0, 1),
    "W3": ("floods", "Lasithi plateau deluge", "Crete, Greece", 35.18, 25.47, 2),
    "D1": ("forest", "Clearing along BR-163", "Novo Progresso, Para, Brazil", -7.1, -55.4, 2),
    "D2": ("forest", "BR-319 frontier clearing", "Labrea, Amazonas, Brazil", -8.5, -65.5, 3),
    "D3": ("forest", "Nickel mine eats the rainforest", "Weda Bay, Halmahera, Indonesia", 0.45, 127.95, 1),
    "A1": ("agriculture", "Rice season", "Punjab, India", 30.5, 75.5, 1),
    "A2": ("agriculture", "Corn and soy season", "Iowa, USA", 42.0, -93.5, 2),
    "A3": ("agriculture", "Summer harvest (home mission)", "Jezreel Valley, Israel", 32.62, 35.30, 2),
    "L1": ("land", "Thunder Bay 36 wildfire", "Ontario, Canada", 49.9, -89.0, 1),
    "L2": ("land", "Krasheninnikov lava fields", "Kamchatka, Russia", 54.59, 159.75, 2),
    "L3": ("land", "Shrinking Great Salt Lake", "Utah, USA", 41.1, -112.5, 2),
    "M1": ("marine", "Oil slicks off the Hallaniyat Islands", "Gulf of Oman", 17.3, 56.3, 3),
    "M2": ("marine", "Cantarell oil seepage", "Bay of Campeche, Mexico", 19.6, -92.2, 2),
    "M3": ("marine", "Mississippi Delta wetland loss", "Louisiana, USA", 29.4, -89.9, 3),
    "M_UAE25": ("marine", "Oil reaches the mangroves", "Umm Al Quwain, UAE", 25.564, 55.555, 2),
}


def grey_alpha(src, dst):
    ds = gdal.Open(src)
    mem = gdal.GetDriverByName("MEM").Create("", ds.RasterXSize, ds.RasterYSize, 2, gdal.GDT_Byte)
    mem.GetRasterBand(1).WriteArray(ds.GetRasterBand(1).ReadAsArray())   # R = G = B, keep one
    mem.GetRasterBand(2).WriteArray(ds.GetRasterBand(4).ReadAsArray())   # alpha
    mem.GetRasterBand(2).SetColorInterpretation(gdal.GCI_AlphaBand)
    gdal.GetDriverByName("PNG").CreateCopy(dst, mem, options=["ZLEVEL=9"])
    aux = dst + ".aux.xml"
    if os.path.exists(aux): os.remove(aux)


def main(repo, ids):
    base = os.path.join(repo, "public", "missions")
    os.makedirs(base, exist_ok=True)
    index_path = os.path.join(base, "index.json")
    index = {m["id"]: m for m in (json.load(open(index_path)) if os.path.exists(index_path) else [])}
    for m in ids:
        src, dst = os.path.join(OUT, m), os.path.join(base, m)
        os.makedirs(dst, exist_ok=True)
        for f in ("img0.png", "img1.png", "img2.png", "grid.geojson", "mission.json"):
            shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
        for i in range(3, 9):
            grey_alpha(os.path.join(src, f"img{i}.png"), os.path.join(dst, f"img{i}.png"))
        topic, title, place, lat, lon, diff = MISSIONS[m]
        j = json.load(open(os.path.join(dst, "mission.json")))
        j.update({"topic": topic, "title": title, "place": place, "lat": lat, "lon": lon, "difficulty": diff})
        json.dump(j, open(os.path.join(dst, "mission.json"), "w"), indent=1)
        index[m] = {"id": m, "topic": topic, "title": title, "lat": lat, "lon": lon, "difficulty": diff}
        size = sum(os.path.getsize(os.path.join(dst, f)) for f in os.listdir(dst))
        print(f"{m:8} {size / 1e6:5.1f} MB")
    json.dump(sorted(index.values(), key=lambda x: x["id"]), open(index_path, "w"), indent=1)
    print(f"index.json: {len(index)} missions")


if __name__ == "__main__":
    main(os.path.expanduser(sys.argv[1]), sys.argv[2:])
