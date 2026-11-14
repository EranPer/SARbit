"""OpenStreetMap layers for each mission: towns, big roads, rivers, oil platforms -> public/missions/<ID>/osm.geojson.

    python pipeline/osm_layers.py            # every mission in public/missions/index.json
    python pipeline/osm_layers.py W1 W2      # just these

Uses the public Overpass API once, at build time (the game never calls it). Data © OpenStreetMap contributors (ODbL).
Each feature gets properties.kind = town | road | river | platform, plus name and the OSM tag the game styles by.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "public" / "missions"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
TOL = 0.0002   # simplify lines to ~20 m


def query(s, w, n, e):
    b = f"{s},{w},{n},{e}"
    return f"""[out:json][timeout:90];
(
  node["place"~"^(city|town|village|suburb|hamlet|island|islet)$"]["name"]({b});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]({b});
  way["waterway"~"^(river|canal)$"]({b});
  node["man_made"~"^(offshore_platform|petroleum_well)$"]({b});
  way["man_made"="offshore_platform"]({b});
);
out geom;"""


def simplify(pts, tol=TOL):   # Douglas-Peucker on [lon, lat]
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
    far, at = 0, 0
    for i, (x, y) in enumerate(pts[1:-1], 1):
        d = abs(dy * x - dx * y + x1 * y0 - y1 * x0) / norm
        if d > far:
            far, at = d, i
    if far <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[: at + 1], tol)[:-1] + simplify(pts[at:], tol)


def name_of(t):
    return t.get("name:en") or t.get("name") or t.get("ref") or ""


def features(elements):
    out = []
    for el in elements:
        t = el.get("tags", {})
        if el["type"] == "node":
            kind = "town" if "place" in t else "platform"
            out.append({"type": "Feature", "properties": {"kind": kind, "name": name_of(t), "place": t.get("place", ""),
                                                          "population": t.get("population", "")},
                        "geometry": {"type": "Point", "coordinates": [round(el["lon"], 5), round(el["lat"], 5)]}})
            continue
        pts = [[round(p["lon"], 5), round(p["lat"], 5)] for p in el.get("geometry", [])]
        if len(pts) < 2:
            continue
        if "man_made" in t:   # a platform drawn as an outline -> one point in its middle
            x = sum(p[0] for p in pts) / len(pts); y = sum(p[1] for p in pts) / len(pts)
            out.append({"type": "Feature", "properties": {"kind": "platform", "name": name_of(t)},
                        "geometry": {"type": "Point", "coordinates": [round(x, 5), round(y, 5)]}})
            continue
        kind = "road" if "highway" in t else "river"
        out.append({"type": "Feature", "properties": {"kind": kind, "name": name_of(t),
                                                      "highway": t.get("highway", ""), "waterway": t.get("waterway", "")},
                    "geometry": {"type": "LineString", "coordinates": simplify(pts)}})
    return out


def fetch(data):   # try each public server in turn; they are often busy
    for attempt in range(6):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "SARbit-NASA-SpaceApps/1.0"})
            return json.load(urllib.request.urlopen(req, timeout=120))["elements"]
        except Exception as err:   # noqa: BLE001 - report and try the next server
            print(f"  {url.split('/')[2]}: {err}; trying again")
            time.sleep(5)
    raise SystemExit("Overpass is not answering; try again later")


def main(ids):
    for mid in ids:
        info = json.loads((ROOT / mid / "mission.json").read_text())
        w, s, e, n = info["bbox"]
        data = urllib.parse.urlencode({"data": query(s, w, n, e)}).encode()
        els = fetch(data)
        fs = features(els)
        if sum(f["properties"].get("place") in ("hamlet", "islet") for f in fs) > 25:   # crowded: only bigger places
            fs = [f for f in fs if f["properties"].get("place") not in ("hamlet", "islet")]
        if sum(f["properties"].get("highway") == "tertiary" for f in fs) > 150:   # busy places: big roads only
            fs = [f for f in fs if f["properties"].get("highway") != "tertiary"]
        if sum(f["properties"].get("waterway") == "canal" for f in fs) > 60:      # irrigation canals: rivers only
            fs = [f for f in fs if f["properties"].get("waterway") != "canal"]
        fc = {"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors (ODbL)", "features": fs}
        path = ROOT / mid / "osm.geojson"
        path.write_text(json.dumps(fc, separators=(",", ":")))
        kinds = {}
        for f in fc["features"]:
            kinds[f["properties"]["kind"]] = kinds.get(f["properties"]["kind"], 0) + 1
        print(mid, kinds, f"{path.stat().st_size // 1024} KB")
        time.sleep(2)   # be gentle with the public server


if __name__ == "__main__":
    ids = sys.argv[1:] or [m["id"] for m in json.loads((ROOT / "index.json").read_text())]
    main(ids)
