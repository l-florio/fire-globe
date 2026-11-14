"""Continents on 1 degree cells from Natural Earth 1:110m countries (public domain) -> globe_kit/public/continents.json.

A cell belongs to a continent when any of 4x4 sample points inside it falls in one of its countries, so coastal
cells are kept. Russia is split at 60 E (Urals, approximate): west Europe, east Asia. Antarctica is left out.
Output layout as regions_gfed.json: {res, source, regions: [{code, name, ids, bbox}]}, id = (lat1+90)*360 + (lon1+180).
"""
import json
import sys

import numpy as np

src, out = sys.argv[1], sys.argv[2]
fc = json.load(open(src, encoding="utf-8"))
CODES = {"Africa": "AF", "Asia": "AS", "Europe": "EU", "North America": "NA", "South America": "SA", "Oceania": "OC"}


def rings(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return [np.asarray(p[0], float) for p in polys]  # outer rings; holes are negligible at 1 degree


def inside(px, py, ring):
    x, y = ring[:, 0], ring[:, 1]
    x2, y2 = np.roll(x, -1), np.roll(y, -1)
    res = np.zeros(px.shape, bool)
    for i in range(len(x)):
        c = ((y[i] > py) != (y2[i] > py)) & (px < (x2[i] - x[i]) * (py - y[i]) / (y2[i] - y[i] + 1e-300) + x[i])
        res ^= c
    return res


sub = (np.arange(4) + 0.5) / 4
cells = {c: set() for c in CODES}
for f in fc["features"]:
    p = f["properties"]
    cont = p["CONTINENT"]
    if cont not in CODES and p["ADMIN"] != "Russia":
        continue
    for r in rings(f["geometry"]):
        w, s = np.floor(r[:, 0].min()), np.floor(r[:, 1].min())
        e, n = np.ceil(r[:, 0].max()), np.ceil(r[:, 1].max())
        lon1, lat1 = np.meshgrid(np.arange(w, e), np.arange(s, n))
        px = (lon1[..., None, None] + sub[None, None, :, None]).repeat(4, -1)
        py = (lat1[..., None, None] + sub[None, None, None, :]).repeat(4, -2)
        hit = inside(px.ravel(), py.ravel(), r).reshape(px.shape).any(axis=(-1, -2))
        for la, lo in zip(lat1[hit].astype(int), lon1[hit].astype(int)):
            c = cont if p["ADMIN"] != "Russia" else ("Europe" if lo < 60 else "Asia")
            if c in CODES:
                cells[c].add(int((la + 90) * 360 + (lo + 180)))

regions = []
for name, code in CODES.items():
    ids = sorted(cells[name])
    lat = [i // 360 - 90 for i in ids]
    lon = [i % 360 - 180 for i in ids]
    regions.append({"code": code, "name": name, "ids": ids, "bbox": [min(lon), min(lat), max(lon) + 1, max(lat) + 1]})
    print(code, name, len(ids))
json.dump({"res": 1, "source": "Natural Earth 1:110m Admin 0 countries v5.1.2 (public domain); Russia split at 60 E",
           "regions": regions}, open(out, "w", encoding="utf-8"), separators=(",", ":"))
