"""GFED4.1s basis regions (0.25 deg, ancill/basis_regions) -> 1-deg cells (lat1, lon1 = floor of the SW corner).
Each 1-deg cell takes the most frequent non-zero region of its 16 sub-cells (0 = ocean when all are 0).
Input: GFED4.1s_<year>.hdf5 path as argv[1]. Output: gfed_regions_1deg.parquet."""
import sys, os, h5py, numpy as np, duckdb
HERE = os.path.dirname(os.path.abspath(__file__)).replace(os.sep, "/")
NAMES = ["Ocean", "BONA", "TENA", "CEAM", "NHSA", "SHSA", "EURO", "MIDE", "NHAF", "SHAF", "BOAS", "CEAS", "SEAS", "EQAS", "AUST"]
with h5py.File(sys.argv[1], "r") as f:
    reg = f["ancill/basis_regions"][:].astype(int); lat = f["lat"][:]; lon = f["lon"][:]
print(reg.shape, "lat", lat[0, 0], lat[-1, 0], "lon", lon[0, 0], lon[0, -1])
if lat[0, 0] < lat[-1, 0]: reg = reg[::-1]  # make row 0 = north
rows = []
for i in range(180):
    for j in range(360):
        b = reg[i*4:(i+1)*4, j*4:(j+1)*4].ravel(); b = b[b > 0]
        rows.append((89 - i, j - 180, int(np.bincount(b).argmax()) if b.size else 0))
c = duckdb.connect(); c.execute("CREATE TABLE g (lat1 INT, lon1 INT, reg INT)"); c.executemany("INSERT INTO g VALUES (?,?,?)", rows)
c.execute(f"COPY (SELECT g.*, n.name FROM g JOIN (SELECT unnest(range(15)) reg, unnest({NAMES}) name) n USING (reg)) TO '{HERE}/gfed_regions_1deg.parquet' (FORMAT PARQUET)")
print(c.execute("SELECT reg, count(*) FROM g GROUP BY 1 ORDER BY 1").fetchall())
print("Italia (lat1 42, lon1 12):", c.execute("SELECT reg FROM g WHERE lat1=42 AND lon1=12").fetchone(), "Australia (-25,135):", c.execute("SELECT reg FROM g WHERE lat1=-25 AND lon1=135").fetchone())
