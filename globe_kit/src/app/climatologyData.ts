import { getDb } from './duckdb';

/**
 * Data of the Climatology page: two small Parquet files read with DuckDB-WASM (shared engine, src/app/duckdb.ts).
 *   band.parquet    region_type, region_id, doy 1..366 (leap reference year: Feb 29 = 60), q05, q50, q95
 *                   = trailing 7-day total of S-NPP vegetation detections, quantiles over years 2012-2025 (+-15 days)
 *   current.parquet region_type, region_id, date, n (daily NOAA-20 count), prov (1 = near-real-time)
 * Paths come from static.json (key `climatology`), relative to the data folder.
 */
export type RegionType = 'continent' | 'gfed' | 'country';
export interface Region {
  type: RegionType;
  id: string;
}
export interface BandPoint {
  q05: number;
  q50: number;
  q95: number;
}
export interface DayCount {
  n: number;
  prov: boolean;
}
export interface Climatology {
  regions: Region[];
  /** band[doy - 1] for doy 1..366; undefined when the region has no band */
  band(r: Region): (BandPoint | undefined)[] | undefined;
  /** daily counts by date (YYYY-MM-DD) */
  current(r: Region): Map<string, DayCount>;
  /** last date (YYYY-MM-DD) of the current-year file, over all regions */
  last?: string;
  generated?: string;
}

export const regionKey = (r: Region) => `${r.type}|${r.id}`;

interface Manifest {
  climatology?: { band?: string; current?: string; generated?: string };
}

const sql = (s: string) => s.replace(/'/g, "''");

export async function loadClimatology(dataBase: string): Promise<Climatology> {
  let man: Manifest = {};
  try {
    const r = await fetch(`${dataBase}static.json`);
    if (r.ok) man = (await r.json()) as Manifest;
  } catch {
    /* no manifest: default paths */
  }
  const c = man.climatology ?? {};
  const url = (p: string) => new URL(`${dataBase}${p}`, document.baseURI).href;
  const { conn } = await getDb();

  const bandRes = await conn.query(
    `SELECT region_type::VARCHAR AS t, region_id::VARCHAR AS id, doy::INTEGER AS doy, q05::DOUBLE AS a, q50::DOUBLE AS b, q95::DOUBLE AS c
     FROM read_parquet('${sql(url(c.band ?? 'climatology/band.parquet'))}')`,
  );
  const bands = new Map<string, (BandPoint | undefined)[]>();
  const regions: Region[] = [];
  const [bt, bi, bd, ba, bb, bc] = ['t', 'id', 'doy', 'a', 'b', 'c'].map((k) => bandRes.getChild(k)!);
  for (let i = 0; i < bandRes.numRows; i++) {
    const r: Region = { type: bt.get(i) as RegionType, id: String(bi.get(i)) };
    const k = regionKey(r);
    let arr = bands.get(k);
    if (!arr) {
      arr = new Array(366).fill(undefined);
      bands.set(k, arr);
      regions.push(r);
    }
    const doy = Number(bd.get(i));
    if (doy >= 1 && doy <= 366) arr[doy - 1] = { q05: Number(ba.get(i)), q50: Number(bb.get(i)), q95: Number(bc.get(i)) };
  }

  const cur = new Map<string, Map<string, DayCount>>();
  let last = '';
  if (c.current) {
    try {
      const res = await conn.query(
        `SELECT region_type::VARCHAR AS t, region_id::VARCHAR AS id, strftime(CAST(date AS DATE), '%Y-%m-%d') AS d, n::DOUBLE AS n, prov::INTEGER AS p
         FROM read_parquet('${sql(url(c.current))}')`,
      );
      const [ct, ci, cd, cn, cp] = ['t', 'id', 'd', 'n', 'p'].map((k) => res.getChild(k)!);
      for (let i = 0; i < res.numRows; i++) {
        const k = regionKey({ type: ct.get(i) as RegionType, id: String(ci.get(i)) });
        let m = cur.get(k);
        if (!m) cur.set(k, (m = new Map()));
        if (String(cd.get(i)) > last) last = String(cd.get(i));
        m.set(String(cd.get(i)), { n: Number(cn.get(i)), prov: Number(cp.get(i)) === 1 });
      }
    } catch {
      /* current-year file missing: the band alone is still useful */
    }
  }
  const none = new Map<string, DayCount>();
  return {
    regions,
    band: (r) => bands.get(regionKey(r)),
    current: (r) => cur.get(regionKey(r)) ?? none,
    last: last || undefined,
    generated: c.generated,
  };
}

// ---- country names: the band uses FIRMS country names; Nominatim / users may write other English variants
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/^the /, '')
    .replace(/[^a-z0-9]+/g, '');

const ALIASES: Record<string, string> = {
  unitedstatesofamerica: 'United States',
  usa: 'United States',
  us: 'United States',
  uk: 'United Kingdom',
  czechia: 'Czech Republic',
  russia: 'Russian Federation',
  northkorea: 'Dem Rep Korea',
  democraticpeoplesrepublicofkorea: 'Dem Rep Korea',
  southkorea: 'Republic of Korea',
  korea: 'Republic of Korea',
  laos: 'Lao PDR',
  laopeoplesdemocraticrepublic: 'Lao PDR',
  northmacedonia: 'Macedonia Former Yugoslav Republic of',
  macedonia: 'Macedonia Former Yugoslav Republic of',
  ivorycoast: "Cote d Ivoire",
  democraticrepublicofcongo: 'Democratic Republic of the Congo',
  drcongo: 'Democratic Republic of the Congo',
  drc: 'Democratic Republic of the Congo',
  congokinshasa: 'Democratic Republic of the Congo',
  congo: 'Republic of Congo',
  republicofthecongo: 'Republic of Congo',
  congobrazzaville: 'Republic of Congo',
  eswatini: 'Swaziland',
  caboverde: 'Cape Verde',
  myanmarburma: 'Myanmar',
  burma: 'Myanmar',
  turkiye: 'Turkey',
  stateofpalestine: 'Palestine',
  palestinianterritories: 'Palestine',
  easttimor: 'Timor-Leste',
  timorleste: 'Timor-Leste',
  stkittsandnevis: 'Saint Kitts and Nevis',
  syrianarabrepublic: 'Syria',
  islamicrepublicofiran: 'Iran',
  republicofmoldova: 'Moldova',
  unitedrepublicoftanzania: 'Tanzania',
  bolivarianrepublicofvenezuela: 'Venezuela',
  vietnam: 'Vietnam',
  vietnamsocialistrepublic: 'Vietnam',
};

/** The band's country id for a name written in English by a user, a link or Nominatim; undefined when not in the band. */
export function matchCountry(name: string, regions: Region[]): Region | undefined {
  const countries = regions.filter((r) => r.type === 'country');
  const n = norm(name);
  const direct = countries.find((r) => norm(r.id) === n);
  if (direct) return direct;
  const alias = ALIASES[n];
  return alias ? countries.find((r) => r.id === alias) : undefined;
}
