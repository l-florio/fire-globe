"""Smoke check of the assembled site data (public/frames and public/data) before publishing.

Fails (exit 1) when a manifest is missing, a referenced file does not exist, or an expected series is absent.
With --expect-recent it also requires data for the previous month at least (the nightly update ran).

Usage: python check_site.py [--public ../public] [--expect-recent]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--public", default=str(HERE.parent / "public"))
    ap.add_argument("--expect-recent", action="store_true")
    a = ap.parse_args()
    pub = Path(a.public)
    errors: list[str] = []
    frames = json.loads((pub / "frames" / "manifest.json").read_text(encoding="utf-8"))
    static = json.loads((pub / "data" / "static.json").read_text(encoding="utf-8"))

    for s in ("MODIS", "VIIRS_SNPP", "HARM_LONG", "HARM_DETAIL"):
        if s not in frames["sensors"]:
            errors.append(f"frames: series {s} missing")
    for s, v in frames["sensors"].items():
        metrics = v.get("metrics", list(frames["metrics"]))
        for m in metrics:
            for key in (v["months"][0], v["months"][-1]):
                if not (pub / "frames" / m / s / f"{key}.png").exists():
                    errors.append(f"frames: {m}/{s}/{key}.png missing")
        print(f"frames {s}: {len(v['months'])} months, {v['months'][0]} .. {v['months'][-1]}")

    for kind in ("grid", "points"):
        for s, files in static.get(kind, {}).items():
            local = [f for f in files if not f["path"].startswith("http")]
            missing = [f["path"] for f in local if not (pub / "data" / f["path"]).exists()]
            errors += [f"{kind}: {p} missing" for p in missing[:5]]
            print(f"{kind} {s}: {len(files)} files ({len(files) - len(local)} external)")
    for f in static.get("regions", []):
        if not (pub / "data" / f["path"]).exists():
            errors.append(f"regions: {f['path']} missing")
    if not static.get("regions"):
        errors.append("regions (Table view) missing")
    if static.get("intervals") and not (pub / "data" / static["intervals"]).exists():
        errors.append("interval table missing")

    clim = static.get("climatology")
    if clim:
        if not (pub / "data" / clim.get("band", "climatology/band.parquet")).exists():
            errors.append("climatology: band file missing")
        elif clim.get("current") and not (pub / "data" / clim["current"]).exists():
            errors.append("climatology: current-year file missing")
        else:
            print(f"climatology: band + current ({clim.get('generated', '?')})")

    if a.expect_recent:
        today = dt.date.today()
        prev = (today.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")
        for s in ("MODIS", "HARM_LONG"):
            last = frames["sensors"].get(s, {}).get("months", ["0000-00"])[-1]
            if last < prev:
                errors.append(f"{s}: last month {last}, expected at least {prev}")

    size = sum(p.stat().st_size for p in pub.rglob("*") if p.is_file())
    print(f"public/ size: {size / 1e6:.0f} MB")
    if size > 900e6:
        errors.append(f"public/ is {size / 1e6:.0f} MB: too close to the 1 GB GitHub Pages limit")
    for e in errors:
        print("ERROR", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
