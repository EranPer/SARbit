"""Run sarbit_mission.fmw for every mission: dates from stack.json, channel names from clips/summary.csv,
change rule per topic from RULES. Prints the hit count per mission (a game-able mission has 4-100 hits).

  python3 run_all.py            # all missions with a stack
  python3 run_all.py A1 D1      # just these
  python3 run_all.py A1:THRESH_DB=7 W1:WATER_MAX=99   # with overrides (also saved into TUNED below)
"""
import csv, json, os, subprocess, sys, time

CLIPS, OUT = "/data/nisar/clips", "/data/nisar/out"
WS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sarbit_mission.fmw")
FME = "/opt/fme-form-2026.3/fme"
# CHANNEL (0 co, 1 cross), SIGN (-1 darker, 1 brighter), THRESH_DB, WATER_MAX (-18 floods, 99 off)
FLOOD, FOREST, CROPS, DARKER_CO, OIL = (0, -1, 3, -18), (1, -1, 3, 99), (1, 1, 3, 99), (0, -1, 3, 99), (0, -1, 6, 99)
RULES = {"W1": FLOOD, "W2": FLOOD, "W3": FLOOD, "M3": FLOOD,
         "D1": FOREST, "D2": FOREST, "D3": FOREST, "L1": FOREST,
         "A1": CROPS, "A2": CROPS, "A3": CROPS,
         "L2": DARKER_CO, "L3": DARKER_CO,
         "M1": OIL, "M2": OIL, "M_UAE25": OIL}
# per-mission settings that beat the topic default (from tuning runs, 14 Nov)
TUNED = {
    "A1": {"THRESH_DB": 6},                       # the whole box changes with the rice season; 6 dB keeps the strongest
    "M3": {"WATER_MAX": 99}, "W1": {"WATER_MAX": 99}, "W3": {"WATER_MAX": 99},   # flooded land isn't mirror-dark
    "A3": {"SIGN": -1},                           # Jezreel summer crops are harvested by October: darker, not brighter
    "D3": {"THRESH_DB": 2}, "M_UAE25": {"THRESH_DB": 3}, "M1": {"THRESH_DB": 3}, "M2": {"THRESH_DB": 3},
    "D2": {"THRESH_DB": 2}, "L1": {"THRESH_DB": 2},
}
iso = lambda d: f"{d[:4]}-{d[4:6]}-{d[6:]}"

def main():
    pols = {}
    for r in csv.DictReader(open(f"{CLIPS}/summary.csv")):
        if r["role"] == "after":
            pols[r["mission"]] = (r["co_pol"][:2], (r["cx_pol"] or r["co_pol"])[:2])

    ids, over = [], {}
    for a in sys.argv[1:]:
        m, _, kv = a.partition(":")
        ids.append(m)
        for pair in filter(None, kv.split(",")):
            k, v = pair.split("="); over.setdefault(m, {})[k] = v
    ids = ids or sorted(m for m in os.listdir(CLIPS) if os.path.exists(f"{CLIPS}/{m}/stack.json"))
    for m in ids:
        s = json.load(open(f"{CLIPS}/{m}/stack.json"))
        ch, sign, th, wm = RULES[m]
        co, cx = pols.get(m, ("HH", "HV"))
        if s["grey"]: cx, ch = co, 0          # no cross-pol on one date: use co-pol for everything
        args = {"MISSION": m, "BEFORE": iso(s["before"]), "AFTER": iso(s["after"]), "CHANNEL": ch, "SIGN": sign,
                "THRESH_DB": th, "WATER_MAX": wm, "CO_NAME": co, "CX_NAME": cx}
        args.update(TUNED.get(m, {})); args.update(over.get(m, {}))
        ch, sign, th, wm = int(args["CHANNEL"]), int(args["SIGN"]), args["THRESH_DB"], args["WATER_MAX"]
        os.makedirs(f"{OUT}/{m}", exist_ok=True)
        t0 = time.time()
        cmd = ["distrobox", "enter", "fme", "--", FME, WS] + [x for k, v in args.items() for x in (f"--{k}", str(v))]
        r = subprocess.run(cmd, capture_output=True, text=True)
        ok = r.returncode == 0
        try:
            cells = json.load(open(f"{OUT}/{m}/grid.geojson"))["features"]
            hits = sum(1 for c in cells if c["properties"].get("hit") == 1)
        except Exception:
            hits = None
        verdict = "" if not ok else ("ok" if hits is not None and 4 <= hits <= 100 else "tune THRESH_DB or box")
        print(f"{m:8} {'OK ' if ok else 'FAIL'} {time.time() - t0:5.0f} s  {co}/{cx} ch{ch} {sign:+d} {th} dB wm{wm}  "
              f"hits {hits if hits is not None else '-':>3}/144  {verdict}", flush=True)
        if not ok:
            print("   ", (r.stdout + r.stderr).strip().splitlines()[-3:])


if __name__ == "__main__":
    main()
