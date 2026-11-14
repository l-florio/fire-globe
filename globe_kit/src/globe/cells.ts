/**
 * Areas made of grid cells: a place polygon (from a geocoder) or a predefined region becomes the list of
 * grid cells whose centre falls inside it. Cell id at resolution r (degrees):
 *   row = floor((lat + 90) / r), col = floor((lon + 180) / r), id = row * (360 / r) + col
 */
export interface CellArea {
  kind: 'cells';
  res: number;
  ids: number[];
  label: string;
  /** west, south, east, north in degrees: for pruning queries and framing the view. */
  bbox: [number, number, number, number];
  /** Outline to draw on the globe, when known (GeoJSON geometry). */
  geojson?: unknown;
}

export const cellId = (lat: number, lon: number, res: number) =>
  Math.floor((lat + 90) / res) * Math.round(360 / res) + Math.floor((lon + 180) / res);

/** SQL expression giving the cell id of a point, for the same resolution. */
export const cellIdSql = (lat: string, lon: string, res: number) =>
  `(CAST(floor((${lat} + 90) / ${res}) AS BIGINT) * ${Math.round(360 / res)} + CAST(floor((${lon} + 180) / ${res}) AS BIGINT))`;

type Ring = number[][];
type Poly = Ring[];

function polygons(geom: { type: string; coordinates: unknown }): Poly[] {
  if (geom.type === 'Polygon') return [geom.coordinates as Poly];
  if (geom.type === 'MultiPolygon') return geom.coordinates as Poly[];
  return [];
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPoly(x: number, y: number, poly: Poly): boolean {
  if (!inRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false; // holes
  return true;
}

/**
 * Cells of a GeoJSON (Multi)Polygon. Resolution 0.25 degrees for areas up to ~400 square degrees
 * (a large country), 1 degree above. Places smaller than a cell get the cells their bounding box touches.
 */
export function cellsFromGeoJson(geom: { type: string; coordinates: unknown }, label: string): CellArea | undefined {
  const polys = polygons(geom);
  if (!polys.length) return undefined;
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of polys) for (const [x, y] of p[0]) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  }
  const res = (e - w) * (n - s) <= 400 ? 0.25 : 1;
  // Bounding box of each polygon, so that most tests are skipped (countries have hundreds of islands).
  const boxes = polys.map((p) => {
    let a = 180, b = 90, c = -180, d = -90;
    for (const [x, y] of p[0]) { a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); d = Math.max(d, y); }
    return [a, b, c, d];
  });
  const ids: number[] = [];
  for (let y = Math.floor(s / res) * res + res / 2; y < n; y += res)
    for (let x = Math.floor(w / res) * res + res / 2; x < e; x += res)
      if (polys.some((p, k) => x >= boxes[k][0] && x <= boxes[k][2] && y >= boxes[k][1] && y <= boxes[k][3] && inPoly(x, y, p)))
        ids.push(cellId(y, x, res));
  // Small places (no cell centre inside): every cell the place's bounding box touches.
  if (!ids.length)
    for (let y = Math.floor(s / res) * res; y < n; y += res)
      for (let x = Math.floor(w / res) * res; x < e; x += res) ids.push(cellId(y + res / 2, x + res / 2, res));
  if (!ids.length) return undefined;
  return { kind: 'cells', res, ids, label, bbox: [w, s, e, n], geojson: geom };
}

/** The same area on coarser cells (any overlap counts), e.g. 0.25 to 1 degree for the harmonized series. */
export function coarsen(a: CellArea, res: number): CellArea {
  if (res <= a.res) return a;
  const ncol = Math.round(360 / a.res);
  const set = new Set<number>();
  for (const id of a.ids) {
    const lat = Math.floor(id / ncol) * a.res - 90 + a.res / 2;
    const lon = (id % ncol) * a.res - 180 + a.res / 2;
    set.add(cellId(lat, lon, res));
  }
  const ids = [...set].sort((x, y) => x - y);
  // The bounding box grows to the coarse cells, or a query prefiltered on it would miss their centres.
  const [w, s, e, n] = a.bbox;
  const bbox: [number, number, number, number] = [
    Math.max(-180, Math.floor(w / res) * res),
    Math.max(-90, Math.floor(s / res) * res),
    Math.min(180, Math.ceil(e / res) * res),
    Math.min(90, Math.ceil(n / res) * res),
  ];
  return { ...a, res, ids, bbox };
}

/**
 * Grid cells at resolution res overlapped by a box, a circle or a cell area (coarsened when finer).
 * Shapes are given as plain objects so that this module does not depend on the area picker.
 */
export function toCells(
  a: CellArea | { kind: 'bbox'; west: number; south: number; east: number; north: number } | { kind: 'circle'; lat: number; lon: number; km: number },
  res: number,
): CellArea {
  if (a.kind === 'cells') return a.res >= res ? a : coarsen(a, res);
  const box =
    a.kind === 'bbox'
      ? [a.west, a.south, a.east < a.west ? a.east + 360 : a.east, a.north]
      : [a.lon - a.km / (111.32 * Math.max(0.01, Math.cos((a.lat * Math.PI) / 180))), a.lat - a.km / 110.57,
         a.lon + a.km / (111.32 * Math.max(0.01, Math.cos((a.lat * Math.PI) / 180))), a.lat + a.km / 110.57];
  const ids: number[] = [];
  const s0 = Math.max(-90, Math.floor(box[1] / res) * res);
  const w0 = Math.floor(box[0] / res) * res;
  for (let y = s0; y < Math.min(90, box[3]); y += res)
    for (let x = w0; x < box[2]; x += res) {
      if (a.kind === 'circle') {
        // nearest point of the cell to the centre, within the radius
        const cy = Math.min(Math.max(a.lat, y), y + res);
        const cx = Math.min(Math.max(a.lon, x), x + res);
        const dy = (cy - a.lat) * 110.57;
        const dx = (cx - a.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
        if (dx * dx + dy * dy > a.km * a.km) continue;
      }
      const lon = ((((x + res / 2 + 180) % 360) + 360) % 360) - 180;
      ids.push(cellId(y + res / 2, lon, res));
    }
  const bbox: [number, number, number, number] = [w0 > -180 ? w0 : -180, s0, Math.min(180, Math.ceil(box[2] / res) * res), Math.min(90, Math.ceil(box[3] / res) * res)];
  // A box across the antimeridian: no bbox prefilter (the cell list alone selects).
  if (box[2] > 180 || box[0] < -180) bbox.splice(0, 4, -180, s0, 180, bbox[3]);
  return { kind: 'cells', res, ids: [...new Set(ids)], label: '', bbox };
}

/** Area of a GeoJSON (Multi)Polygon in km2 (outer rings minus holes, local equirectangular approximation). */
export function polygonKm2(geom: unknown): number {
  const ringKm2 = (r: number[][]) => {
    const lat0 = (r.reduce((s, p) => s + p[1], 0) / r.length) * (Math.PI / 180);
    const kx = 111.32 * Math.cos(lat0);
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * kx) * (r[i][1] * 110.57) - (r[i][0] * kx) * (r[j][1] * 110.57);
    return Math.abs(a) / 2;
  };
  return polygons(geom as { type: string; coordinates: unknown }).reduce(
    (sum, p) => sum + ringKm2(p[0]) - p.slice(1).reduce((h, r) => h + ringKm2(r), 0),
    0,
  );
}

/** Outer rings of a GeoJSON (Multi)Polygon, for drawing outlines. */
export function outerRings(geom: unknown): number[][][] {
  return polygons(geom as { type: string; coordinates: unknown }).map((p) => p[0]);
}

/** South-west corner of each cell, in degrees. */
export function cellCorners(a: CellArea): [number, number][] {
  const ncol = Math.round(360 / a.res);
  return a.ids.map((id) => [(id % ncol) * a.res - 180, Math.floor(id / ncol) * a.res - 90]);
}

/**
 * Frame of the cells for the camera: the latitude range, and the longitude range that leaves out the widest
 * empty gap (so a region across the antimeridian, e.g. Siberia with Chukotka, is framed as one piece).
 */
export function cellsFrame(a: CellArea): [number, number, number, number] {
  const c = cellCorners(a);
  const lons = [...new Set(c.map(([x]) => x))].sort((p, q) => p - q);
  let gap = 360 - (lons[lons.length - 1] + a.res - lons[0]);
  let west = lons[0];
  let east = lons[lons.length - 1] + a.res;
  for (let i = 1; i < lons.length; i++) {
    const g = lons[i] - (lons[i - 1] + a.res);
    if (g > gap) {
      gap = g;
      west = lons[i];
      east = lons[i - 1] + a.res;
    }
  }
  const lats = c.map(([, y]) => y);
  return [west, Math.min(...lats), east, Math.max(...lats) + a.res];
}

export function cellsKm2(a: CellArea): number {
  const ncol = Math.round(360 / a.res);
  const side = 111.32 * a.res;
  return a.ids.reduce((sum, id) => sum + side * side * Math.cos((((Math.floor(id / ncol) + 0.5) * a.res - 90) * Math.PI) / 180), 0);
}
