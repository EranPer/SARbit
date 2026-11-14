"""Builds sarbit_mission.fmw from skeleton.fmw (saved by Workbench: FeatureReader + 2 FeatureWriters).

Adds the transformer chain, an annotation on every transformer, the published parameters and the links,
then `fme RESAVE_WORKSPACE` regenerates the engine part. Run on the host:  python3 build_fmw.py
"""
import base64, json, os, re, subprocess
from html import escape

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON, DRAFT, OUT = (os.path.join(HERE, n) for n in ("skeleton.fmw", "_draft.fmw", "sarbit_mission.fmw"))
FME = "/opt/fme-form-2026.3/fme"


def enc(s):
    """FME 'stringEncoded' form for values inside tables (spaces separate cells)."""
    parts = re.split(r"(\$\([A-Z_]+\))", s)          # published parameters stay as $(NAME)
    for i in range(0, len(parts), 2):
        for a, b in ((" ", "<space>"), ('"', "<quote>"), (",", "<comma>"), ("(", "<openparen>"), (")", "<closeparen>")):
            parts[i] = parts[i].replace(a, b)
    return "".join(parts)


# ---- the expressions -------------------------------------------------------------------------
# bands after ToDecibels: A[0] before co-pol dB · A[1] before cross-pol · A[2] after co-pol · A[3] after cross-pol
DIFF = "@if($(CHANNEL)==0,A[2]-A[0],A[3]-A[1])"
AFTER = "@if($(CHANNEL)==0,A[2],A[3])"
VALID = "(A[0]>-90)&&(A[2]>-90)"
CHANGE = f"@if({VALID}&&($(SIGN)*{DIFF}>$(THRESH_DB))&&({AFTER}<$(WATER_MAX)),1,0)"
CLAMP = lambda v: f"@if({v}<0,0,@if({v}>255,255,{v}))"   # @min/@max don't exist in raster expressions
SCO = lambda x: CLAMP(f"({x}+25)*10.2")                  # co-pol  -25..0 dB  -> 0..255
SCX = lambda x: CLAMP(f"({x}+32)*10.625")                # cross   -32..-8 dB -> 0..255
# raster expressions can't read attributes, so ONE paint makes all 12 bands and each copy later keeps its 4
PAINT = [  # bands 0-3 before RGBA · 4-7 after RGBA · 8-11 change overlay RGBA (red, see-through where unchanged)
    ("RED8", SCO("A[0]")), ("GREEN8", SCX("A[1]")), ("BLUE8", SCO("A[0]")), ("ALPHA8", "@if(A[0]>-90,255,0)"),
    ("RED8", SCO("A[2]")), ("GREEN8", SCX("A[3]")), ("BLUE8", SCO("A[2]")), ("ALPHA8", "@if(A[2]>-90,255,0)"),
    ("RED8", "255"), ("GREEN8", "40"), ("BLUE8", "40"), ("ALPHA8", "A[4]*170"),
]
# the game's building blocks: one grey layer per channel and date, ONE fixed scale for every mission
GREY = lambda x: CLAMP(f"({x}+35)*6.375")                # -35..+5 dB -> 0..255 (dB = v/6.375 - 35)
RATIO = lambda a, b: CLAMP(f"({a}-{b})*12.75")          # co - cross, 0..20 dB -> 0..255 (dB = v/12.75)
LAYERS = [  # (file label, grey value, valid when)
    ("before_CO", GREY("A[0]"), "A[0]>-90"), ("before_CX", GREY("A[1]"), "A[1]>-90"),
    ("after_CO", GREY("A[2]"), "A[2]>-90"), ("after_CX", GREY("A[3]"), "A[3]>-90"),
    ("before_RATIO", RATIO("A[0]", "A[1]"), "(A[0]>-90)&&(A[1]>-90)"),
    ("after_RATIO", RATIO("A[2]", "A[3]"), "(A[2]>-90)&&(A[3]>-90)"),
]
for _, v, ok in LAYERS:   # every picture is 4 bands (RGBA), so one band-picking rule serves all copies
    PAINT += [("RED8", v), ("GREEN8", v), ("BLUE8", v), ("ALPHA8", f"@if({ok},255,0)")]
N_IMAGES = len(PAINT) // 4   # 3 pictures + 6 layers = 9
BANDS_OF_COPY = ";".join(f"@Evaluate(@Value(_copynum)*4+{i}):ALL" for i in range(4))   # rows ';', columns ':'
JSON_TEXT = ('{"id":"$(MISSION)","bbox":[@Value(_xmin),@Value(_ymin),@Value(_xmax),@Value(_ymax)],'
             '"before":{"date":"$(BEFORE)","image":"img0.png"},"after":{"date":"$(AFTER)","image":"img1.png"},'
             '"change_overlay":"img2.png",'
             '"channels":{"CO":"$(CO_NAME)","CX":"$(CX_NAME)"},'
             '"layers":{"before":{"CO":"img3.png","CX":"img4.png","RATIO":"img7.png"},'
             '"after":{"CO":"img5.png","CX":"img6.png","RATIO":"img8.png"}},'
             '"layer_scale":{"CO_CX":{"db_at_0":-35,"db_at_255":5},"RATIO":{"db_at_0":0,"db_at_255":20}},'
             '"change_rule":{"channel":$(CHANNEL),"sign":$(SIGN),"thresh_db":$(THRESH_DB),"water_max_db":$(WATER_MAX)},'
             '"grid":{"rows":12,"cols":12,"geojson":"grid.geojson"},'
             '"sensor":"NISAR L-band (NASA-ISRO), ASF DAAC"}')

# ---- the chain: (id, type, version, name, x, y, params, note) --------------------------------
MAIN_Y, IMG_Y, GRID_Y, JSON_Y = -700, -1150, -250, 200
T = [
 (10, "RasterExpressionEvaluator", 3, "ToDecibels", 900, MAIN_Y,
  {"MODE": "One Raster", "EXPRESSION_LIST": " ".join(["REAL32 @if(A[%d]>0,10*@log10(A[%d]),-99)" % (i, i) for i in range(4)])},
  "1 · TO DECIBELS. Radar brightness arrives as linear power (0.001 to 30). 10·log10 turns it into dB "
  "(about −30 to +5), the scale every radar rule and colour stretch below is written in. 4 bands in, 4 out. "
  "No signal (0) becomes −99 dB, so no NoData flag is needed anywhere."),
 (11, "RasterConvolver", 2, "Despeckle5x5Median", 1250, MAIN_Y,
  {"CONVOLUTION_FILTER": "UserDefined", "KERNEL_WEIGHTS": " ".join(["1"] * 25), "KERNEL_OPERATION": "Median",
   "KERNEL_DIVISOR_LOOKUP": "1", "EDGE_HANDLING": "ExtendBorderValues"},
  "2 · DESPECKLE. Radar images are grainy ('speckle'). A 5×5 median replaces each pixel by the middle value "
  "of its 25 neighbours: grain goes, edges (shorelines, field borders) stay sharp."),
 (12, "RasterResampler", 3, "Resize1024", 1600, MAIN_Y,
  {"ROWCOL_OR_CELLSIZE": "RowsColumns", "COLUMNS": "1024", "ROWS": "1024", "INTERPOLATION_TYPE": "Bilinear"},
  "3 · RESIZE to 1024 × 1024. The box is square in UTM, so it stays square. Plenty for the screen, small "
  "files for the web, same size for every mission."),
 (13, "RasterExpressionEvaluator", 3, "ChangeMap", 1950, MAIN_Y,
  {"MODE": "One Raster", "EXPRESSION_LIST": "REAL32 A[0] REAL32 A[1] REAL32 A[2] REAL32 A[3] UINT8 " + CHANGE},
  "4 · CHANGE MAP (adds band 5). Per pixel: difference after − before on the chosen channel "
  "(CHANNEL 0 = co-pol HH/VV, 1 = cross-pol HV/VH). Changed = 1 when SIGN × difference > THRESH_DB "
  "(SIGN −1 = got darker, +1 = got brighter) and the after value is below WATER_MAX (−18 for floods, 99 = off). "
  "Pixels without signal on either date never count."),
 (14, "Reprojector", 6, "ToWebMercator", 2300, MAIN_Y,
  {"SOURCE": "", "DEST": "EPSG:3857", "INTERPOLATION_TYPE": "Bilinear", "RASTER_CELL_SIZE": "SquareCells"},
  "5 · TO WEB MERCATOR (EPSG:3857), the projection of web maps. This is what makes the PNGs sit exactly on "
  "the Leaflet basemap. Everything after this point is output."),
 # images branch
 (15, "RasterExpressionEvaluator", 3, "PaintAll", 2650, IMG_Y,
  {"MODE": "One Raster", "EXPRESSION_LIST": " ".join(f"{k} {v}" for k, v in PAINT)},
  "6 · PAINT every picture into one 36-band raster (9 pictures × RGBA). Ready-made: before, after (R = co-pol, "
  "G = cross-pol, B = co-pol, one fixed stretch for both dates) and the red change overlay. Building blocks for "
  "the game: grey layers co-pol, cross-pol and co−cross ratio for each date, all on ONE fixed scale "
  "(−35…+5 dB, ratio 0…20 dB), so the player can mix them into R/G/B and the colours stay comparable."),
 (16, "Cloner", 0, "NineImages", 3000, IMG_Y, {"COPIES": str(N_IMAGES), "COPYATT": "_copynum"},
  "7 · NINE COPIES, one per picture: 0 before · 1 after · 2 change · 3 before co · 4 before cross · "
  "5 after co · 6 after cross · 7 before ratio · 8 after ratio."),
 (27, "AttributeCreator", 11, "BandsForThisCopy", 3350, IMG_Y,
  {"ATTR_TABLE": " ".join(['""', "_bands", "SET_TO", enc(BANDS_OF_COPY), "buffer"])},
  "8 · WHICH BANDS. Copy n keeps bands 4n … 4n+3. Written as a band list for the next step."),
 (28, "RasterSelector", 1, "KeepFourBands", 3700, IMG_Y,
  {"SELECTION_MODE_LOOKUP": "ATTRIBUTE", "ATTRIBUTE": "_bands"},
  "9 · MARK the 4 bands of this copy (RasterSelector only marks, it doesn't remove)."),
 (29, "RasterBandKeeper", 1, "DropOtherBands", 4050, IMG_Y, {},
  "10 · KEEP only the marked bands = one RGBA picture per copy, ready for PNG."),
 # grid branch
 (17, "RasterTiler", 2, "Grid12x12", 2650, GRID_Y,
  {"TILESIZE_OR_NUMTILES": "Number of Tiles", "NUM_HORIZONTAL_TILES": "12", "NUM_VERTICAL_TILES": "12"},
  "11 · CUT INTO 12 × 12 TILES: the game board. Each tile keeps its _tile_row / _tile_column."),
 (18, "RasterStatisticsCalculator", 2, "ChangedShare", 3000, GRID_Y,
  {"RASTER_LEVEL": "BAND_ONLY", "RASTER_STATS": '4 "" "" MEAN "" "" "" "" "" ""'},
  "12 · SHARE CHANGED. Mean of band 5 (0/1) over the tile = the fraction of its pixels that changed (band4.mean)."),
 (19, "BoundingBoxReplacer", 6, "TileToCell", 3350, GRID_Y, {"BBTYPE": "BB"},
  "13 · TILE → CELL. Swap each raster tile for its outline polygon: the clickable square in the game."),
 (20, "AttributeCreator", 11, "HitOrNot", 3700, GRID_Y,
  {"ATTR_TABLE": ' '.join([
      '""', "hit", "SET_TO", enc("@Evaluate(@Value(band4.mean)>=0.2)"), "uint8",
      '""', "share", "SET_TO", enc("@Value(band4.mean)"), "real64",
      '""', "row", "SET_TO", enc("@Value(_tile_row)"), "uint16",
      '""', "col", "SET_TO", enc("@Value(_tile_column)"), "uint16"])},
  "14 · HIT OR NOT. hit = 1 when at least 20 % of the cell changed: the answer key the player's guess is "
  "scored against. row / col say where the cell sits."),
 (21, "Reprojector", 6, "CellsToLatLon", 4050, GRID_Y, {"SOURCE": "", "DEST": "EPSG:4326"},
  "15 · TO LAT/LON (EPSG:4326), what GeoJSON and Leaflet expect for vector shapes."),
 # mission.json branch
 (22, "BoundingBoxReplacer", 6, "ImageFootprint", 2650, JSON_Y, {"BBTYPE": "BB"},
  "16 · FOOTPRINT. The outline of the finished image (still Web Mercator)."),
 (23, "Reprojector", 6, "FootprintToLatLon", 3000, JSON_Y, {"SOURCE": "", "DEST": "EPSG:4326"},
  "17 · TO LAT/LON. Leaflet places an image by its corner latitudes/longitudes."),
 (24, "BoundsExtractor", 3, "Corners", 3350, JSON_Y, {},
  "18 · CORNERS → _xmin _ymin _xmax _ymax: the bbox for mission.json."),
 (25, "AttributeCreator", 11, "MissionJson", 3700, JSON_Y,
  {"ATTR_TABLE": ' '.join(['""', "_json", "SET_TO", enc(JSON_TEXT), "buffer"])},
  "19 · MISSION.JSON text: id, bbox, dates, the 9 picture files, channel names (HH/HV or VV/VH), the layer "
  "scales, the change rule used, grid file. Story/explain texts come from the game team (Missions tab)."),
 (26, "AttributeFileWriter", 5, "WriteMissionJson", 4050, JSON_Y,
  {"SOURCE_ATTR": "_json", "FILE_NAME": "/data/nisar/out/$(MISSION)/mission.json",
   "OVERWRITE_FILE_LOOKUP": "DestWriteSrcRead", "CHAR_ENCODING": "UTF-8"},
  "20 · WRITE mission.json next to the images and the grid."),
]
LINKS = [  # (from id, from port index, to id, to port index)
    (2, 1, 10, 0), (10, 0, 11, 0), (11, 0, 12, 0), (12, 0, 13, 0), (13, 0, 14, 0),
    (14, 0, 15, 0), (15, 0, 16, 0), (16, 0, 27, 0), (27, 0, 28, 0), (28, 0, 29, 0), (29, 0, 3, 0),
    (14, 0, 17, 0), (17, 0, 18, 0), (18, 0, 19, 0), (19, 0, 20, 0), (20, 0, 21, 0), (21, 0, 4, 0),
    (14, 0, 22, 0), (22, 0, 23, 0), (23, 0, 24, 0), (24, 0, 25, 0), (25, 0, 26, 0),
]
NOTES_FIXED = {
    2: "0 · READ the mission's stack: one GeoTIFF, 4 bands = before co-pol, before cross-pol, after co-pol, "
       "after cross-pol, on one grid (made by clip.py + stack.py, because FME on Linux can't open NISAR HDF5).",
    3: "21 · PNG WRITER. img0…img8.png (name = img + _copynum) into /data/nisar/out/MISSION/. "
       "mission.json says which file is which.",
    4: "22 · GEOJSON WRITER. grid.geojson: 144 cells with hit / row / col, the game's answer key.",
}
PARAMS = [  # name, prompt, default
    ("MISSION", "Mission id (folder in /data/nisar/clips)", "W2"),
    ("BEFORE", "Before date (for mission.json)", "2026-01-05"),
    ("AFTER", "After date (for mission.json)", "2026-01-17"),
    ("CHANNEL", "Change channel: 0 = co-pol (HH/VV), 1 = cross-pol (HV/VH)", "0"),
    ("SIGN", "Direction: -1 = got darker, 1 = got brighter", "-1"),
    ("THRESH_DB", "Minimum change in dB", "3"),
    ("WATER_MAX", "After value must be below this dB (floods: -18; else 99 = off)", "-18"),
    ("CO_NAME", "Co-pol channel name (HH, or VV)", "HH"),
    ("CX_NAME", "Cross-pol channel name (HV, or VH; same as CO_NAME if missing)", "HV"),
]


STEP, IMG_ROW, MAIN_ROW, JSON_ROW = 800, 1500, 0, -1500
LAYOUT = {  # id: (column, row)
    2: (0, MAIN_ROW), 10: (1, MAIN_ROW), 11: (2, MAIN_ROW), 12: (3, MAIN_ROW), 13: (4, MAIN_ROW), 14: (5, MAIN_ROW),
    17: (6, MAIN_ROW), 18: (7, MAIN_ROW), 19: (8, MAIN_ROW), 20: (9, MAIN_ROW), 21: (10, MAIN_ROW), 4: (11, MAIN_ROW),
    15: (6, IMG_ROW), 16: (7, IMG_ROW), 27: (8, IMG_ROW), 28: (9, IMG_ROW), 29: (10, IMG_ROW), 3: (11, IMG_ROW),
    22: (6, JSON_ROW), 23: (7, JSON_ROW), 24: (8, JSON_ROW), 25: (9, JSON_ROW), 26: (10, JSON_ROW),
}
XY = lambda tid: (LAYOUT[tid][0] * STEP, LAYOUT[tid][1])
NOTE_W, NOTE_H, NOTE_GAP = 700, 560, 180   # note sits above its transformer


def xml_transformer(tid, ttype, ver, name, x, y, params):
    x, y = XY(tid)
    outs = {"RasterExpressionEvaluator": ["RESULT", "<REJECTED>"], "RasterConvolver": ["OUTPUT", "<REJECTED>"],
            "RasterResampler": ["RESAMPLED", "<REJECTED>"], "Reprojector": ["REPROJECTED", "<REJECTED>"],
            "Cloner": ["COPY", "<REJECTED>"], "RasterTiler": ["TILES", "<REJECTED>"],
            "RasterStatisticsCalculator": ["OUTPUT", "<REJECTED>"], "BoundingBoxReplacer": ["BOX"],
            "AttributeCreator": ["OUTPUT"], "BoundsExtractor": ["OUTPUT"],
            "AttributeFileWriter": ["OUTPUT", "<REJECTED>"], "RasterSelector": ["OUTPUT", "<REJECTED>"],
            "RasterBandKeeper": ["OUTPUT", "<REJECTED>"]}[ttype]
    lines = ["#! <TRANSFORMER", f'#!   IDENTIFIER="{tid}"', f'#!   TYPE="{ttype}"', f'#!   VERSION="{ver}"',
             f'#!   POSITION="{x} {y}"', f'#!   ORDER="5000000000000{tid}"', '#!   PARMS_EDITED="true"',
             '#!   ENABLED="true"', "#! >"]
    for o in outs:
        lines += [f'#!     <OUTPUT_FEAT NAME="{escape(o)}"/>', '#!     <FEAT_COLLAPSED COLLAPSED="1"/>']
    for k, v in {**params, "XFORMER_NAME": name}.items():
        lines.append(f'#!     <XFORM_PARM PARM_NAME="{k}" PARM_VALUE="{escape(v, quote=True)}"/>')
    lines.append("#! </TRANSFORMER>")
    return "\n".join(lines) + "\n"


def xml_comment(cid, anchor, x, y, text):
    x, y = XY(anchor)
    top, bottom = y + NOTE_GAP + NOTE_H, y + NOTE_GAP
    return "\n".join([
        "#! <COMMENT", f'#!   IDENTIFIER="{cid}"', f'#!   COMMENT_VALUE="{escape(text, quote=True)}"',
        f'#!   POSITION="{x} {top}"', f'#!   TOP_LEFT="{x} {top}"', f'#!   BOTTOM_RIGHT="{x + NOTE_W} {bottom}"',
        f'#!   BOUNDING_RECT="{x} {top} {NOTE_W} {NOTE_H}"', f'#!   ORDER="6000000000000{cid}"', '#!   FOLLOW_ANCHOR="true"',
        '#!   INFO_NODE="false"', '#!   CUSTOM_USER_COLOR="false"', '#!   COLOUR="1,1,0.784314,1"',
        '#!   SIZE_POLICY="10"', f'#!   ANCHORED_NODE="{anchor}"', "#! />"]) + "\n"


def main():
    t = open(SKELETON, encoding="utf-8").read()
    # reader / writers: dataset paths follow the MISSION parameter; PNG file name comes from _copynum
    t = t.replace("&lt;solidus&gt;data&lt;solidus&gt;nisar&lt;solidus&gt;clips&lt;solidus&gt;W2&lt;solidus&gt;stack.tif",
                  "&lt;solidus&gt;data&lt;solidus&gt;nisar&lt;solidus&gt;clips&lt;solidus&gt;$(MISSION)&lt;solidus&gt;stack.tif")
    t = t.replace("&lt;solidus&gt;data&lt;solidus&gt;nisar&lt;solidus&gt;out&lt;solidus&gt;W2&lt;solidus&gt;grid.json",
                  "&lt;solidus&gt;data&lt;solidus&gt;nisar&lt;solidus&gt;out&lt;solidus&gt;$(MISSION)&lt;solidus&gt;grid.geojson")
    t = t.replace("&lt;solidus&gt;data&lt;solidus&gt;nisar&lt;solidus&gt;out&lt;solidus&gt;W2\"",
                  "&lt;solidus&gt;data&lt;solidus&gt;nisar&lt;solidus&gt;out&lt;solidus&gt;$(MISSION)\"")
    t = t.replace("before:Raster1,ftp_feature_type_name,before,",
                  "img&lt;at&gt;Value&lt;openparen&gt;_copynum&lt;closeparen&gt;:Raster1,ftp_feature_type_name,"
                  "img&lt;at&gt;Value&lt;openparen&gt;_copynum&lt;closeparen&gt;,")
    for tid in (2, 3, 4):
        x, y = XY(tid)
        m = re.search(rf'#! <TRANSFORMER\n#!   IDENTIFIER="{tid}"\n.*?#! >', t, re.S)
        blk = re.sub(r'POSITION="[^"]*"', f'POSITION="{x} {y}"', m.group(0))
        blk = re.sub(r'BOUNDING_RECT="[^"]*"', f'BOUNDING_RECT="{x} {y} 440 65"', blk)
        t = t[:m.start()] + blk + t[m.end():]
    # transformers
    block = "".join(xml_transformer(*x[:7]) for x in T)
    t = t.replace("#! </TRANSFORMERS>", block + "#! </TRANSFORMERS>", 1)
    # links
    links = "".join("\n".join(["#! <FEAT_LINK", f'#!   IDENTIFIER="{100 + i}"', f'#!   SOURCE_NODE="{a}"',
                               f'#!   TARGET_NODE="{b}"', f'#!   SOURCE_PORT_DESC="fo {pa}"',
                               f'#!   TARGET_PORT_DESC="fi {pb}"', '#!   ENABLED="true"', '#!   EXECUTION_IDX="0"',
                               '#!   HIDDEN="false"', '#!   COLOUR="0,0,0,1"', '#!   PEN_WIDTH="1"',
                               '#!   PEN_STYLE="1"', '#!   EXTRA_POINTS=""', "#! />"]) + "\n"
                    for i, (a, pa, b, pb) in enumerate(LINKS))
    t = t.replace("#! <FEAT_LINKS>\n", "#! <FEAT_LINKS>\n" + links, 1)
    # annotations
    notes = [(x[0], 0, 0, x[7]) for x in T] + [(k, 0, 0, v) for k, v in NOTES_FIXED.items()]
    t = t.replace("#! <COMMENTS>\n", "#! <COMMENTS>\n" + "".join(
        xml_comment(200 + i, nid, x, y, txt) for i, (nid, x, y, txt) in enumerate(notes)), 1)
    # published parameters
    form = {"parameters": [{"name": n, "prompt": p, "type": "text", "valueType": "string", "defaultValue": d,
                            "required": True} for n, p, d in PARAMS]}
    t = re.sub(r'FORM="[^"]*"', 'FORM="%s"' % base64.b64encode(json.dumps(form).encode()).decode(), t, count=1)
    info = "".join(f'#!     <INFO NAME="{n}" DEFAULT_VALUE="{d}" SCOPE_ATTRIBUTE="" SCOPE_FEATURE_TYPE="" />\n'
                   for n, p, d in PARAMS)
    t = t.replace("#! <PARAMETER_INFO>\n", "#! <PARAMETER_INFO>\n" + info, 1)
    open(DRAFT, "w", encoding="utf-8").write(t)
    r = subprocess.run(["distrobox", "enter", "fme", "--", FME, "RESAVE_WORKSPACE", "--input", DRAFT, "--output", OUT],
                       capture_output=True, text=True)
    print((r.stdout + r.stderr).strip().splitlines()[-1])


if __name__ == "__main__":
    main()
