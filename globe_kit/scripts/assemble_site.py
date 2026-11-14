"""Merge the historical data (built once, locally) and the recent data (rebuilt nightly) into public/.

Each input folder has the layout written by make_fire_frames.py (frames/) and make_static_data.py (data/):
  <part>/frames/manifest.json, <part>/frames/<metric>/<sensor>/<YYYY-MM>.png
  <part>/data/static.json, <part>/data/grid/..., <part>/data/points/...

Usage: python assemble_site.py --part ../site_data [--part ../build/recent] [--out ../globe_kit/public]
                        [--external-points DIR --points-base URL]
Later parts win on identical file paths (a recent month replaces an older copy of the same month; the same holds for
data/climatology/current.parquet, and the static.json key `climatology` is carried over).
Single detections: for each sensor and year the file covering the largest region wins (worldwide beats a
region); on equal coverage the later source wins. Order: external points, then the parts in order.
--external-points: a folder written by make_static_data.py --skip-grid (its static.json and points/),
hosted elsewhere (e.g. a Hugging Face dataset) at --points-base; its files are referenced, not copied.
"""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


def merge_frames(manifests: list[dict]) -> dict:
    out = dict(manifests[0])
    out["sensors"] = {}
    for m in manifests:
        for s, v in m["sensors"].items():
            cur = out["sensors"].setdefault(s, {"label": v["label"], "months": [], "partial_last_month": False})
            cur["months"] = sorted(set(cur["months"]) | set(v["months"]))
            for k in ("metrics", "max", "harmonized"):
                if k in v:
                    cur[k] = v[k]
            if v["months"] and v["months"][-1] == cur["months"][-1]:
                cur["partial_last_month"] = v.get("partial_last_month", False)
    return out


def _area(r: list[float]) -> float:
    w, s, e, n = r
    return ((e - w) % 360 or 360) * (n - s)


def merge_static(manifests: list[dict]) -> dict:
    out = {k: v for k, v in manifests[-1].items() if k not in ("grid", "points", "region", "regions")}
    out["grid"], out["points"] = {}, {}
    for m in manifests:
        for s, files in m.get("grid", {}).items():
            have = {f["path"] for f in out["grid"].setdefault(s, [])}
            out["grid"][s] += [f for f in files if f["path"] not in have]
        for s, files in m.get("points", {}).items():
            best = {f["year"]: f for f in out["points"].get(s, [])}
            for f in files:
                f.setdefault("region", m.get("region", [-180, -90, 180, 90]))
                cur = best.get(f["year"])
                if cur is None or _area(f["region"]) >= _area(cur["region"]):
                    best[f["year"]] = f
            out["points"][s] = sorted(best.values(), key=lambda f: f["year"])
        if m.get("intervals"):
            out["intervals"] = m["intervals"]
        if m.get("regions"):
            have = {f["path"] for f in out.get("regions", [])}
            out["regions"] = out.get("regions", []) + [f for f in m["regions"] if f["path"] not in have]
        if m.get("climatology"):
            out["climatology"] = {**out.get("climatology", {}), **m["climatology"]}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--part", action="append", required=True, help="folder with frames/ and data/; repeatable")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "public"))
    ap.add_argument("--external-points", help="folder with static.json + points/ hosted at --points-base")
    ap.add_argument("--points-base", help="URL prefix of the external points, ending with /")
    a = ap.parse_args()
    parts = [Path(p) for p in a.part if (Path(p) / "frames" / "manifest.json").exists()]
    if not parts:
        raise SystemExit("no part with frames/manifest.json")
    out = Path(a.out)
    for sub in ("frames", "data"):
        if (out / sub).exists():
            shutil.rmtree(out / sub)
    for p in parts:
        for sub in ("frames", "data"):
            if (p / sub).exists():
                shutil.copytree(p / sub, out / sub, dirs_exist_ok=True)
    frames = merge_frames([json.loads((p / "frames" / "manifest.json").read_text(encoding="utf-8")) for p in parts])
    (out / "frames" / "manifest.json").write_text(json.dumps(frames, indent=1), encoding="utf-8")
    statics = [json.loads((p / "data" / "static.json").read_text(encoding="utf-8")) for p in parts if (p / "data" / "static.json").exists()]
    if a.external_points and a.points_base:
        ext = json.loads((Path(a.external_points) / "static.json").read_text(encoding="utf-8"))
        base = a.points_base.rstrip("/") + "/"
        ext = {"region": ext["region"], "grid": {},
               "points": {s: [{**f, "path": base + f["path"]} for f in files] for s, files in ext["points"].items()}}
        statics = [ext] + statics
    if statics:
        merged = merge_static(statics)
        # Climatology page: the band is historical (site_data); the current-year file is rebuilt nightly in the recent part
        # (<part>/data/climatology/current.parquet, no manifest key needed) and replaces the committed snapshot.
        clim = merged.get("climatology")
        for p in parts:
            cur = p / "data" / "climatology" / "current.parquet"
            if clim and cur.exists():
                clim["current"] = "climatology/current.parquet"
                if p is parts[-1] and len(parts) > 1:
                    clim["generated"] = datetime.fromtimestamp(cur.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
        (out / "data" / "static.json").write_text(json.dumps(merged, indent=1), encoding="utf-8")
        # Drop copied point files that a wider external file replaced.
        used = {f["path"] for files in merged["points"].values() for f in files}
        for f in (out / "data" / "points").rglob("*.parquet") if (out / "data" / "points").exists() else []:
            if f.relative_to(out / "data").as_posix() not in used:
                f.unlink()
        for s, files in merged["points"].items():
            ext_n = sum(1 for f in files if f["path"].startswith("http"))
            print(f"points {s}: {len(files)} years ({ext_n} external)")
    for s, v in frames["sensors"].items():
        print(f"{s}: {len(v['months'])} months, {v['months'][0]} .. {v['months'][-1]}")
    print(f"site data in {out}")


if __name__ == "__main__":
    main()
