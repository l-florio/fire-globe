import * as Cesium from 'cesium';

/** Keyless imagery sources. NASA GIBS first: no account, no token, NASA data. */
export type BasemapId = 'gibs-bluemarble' | 'gibs-blackmarble' | 'gibs-truecolor' | 'esri-imagery' | 'osm';
export type OverlayId = 'gibs-coastlines' | 'gibs-reference' | 'gibs-labels' | 'esri-labels';

export interface BasemapDef {
  id: BasemapId | OverlayId;
  label: string;
  create(opts?: { date?: string }): Cesium.ImageryProvider;
  /**
   * Sharper imagery shown when zoomed in, above the base layer. The NASA layers stop at about
   * 250-500 m per pixel, so close views switch to Esri World Imagery (sub-metre in many areas).
   */
  detail?: { create(): Cesium.ImageryProvider; fromLevel: number };
}

const esriImagery = () =>
  new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19,
    credit: new Cesium.Credit('Imagery: Esri, Maxar, Earthstar Geographics', true),
  });

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const gibsCredit = new Cesium.Credit('Imagery: NASA GIBS', true);

/**
 * GIBS in Web Mercator (GoogleMapsCompatible, 256 px tiles). The EPSG:4326 endpoints use a
 * level-0 tile of 288 degrees, which does not match Cesium's GeographicTilingScheme.
 */
function gibs(layer: string, maxLevel: number, format = 'jpg', date?: string) {
  return new Cesium.UrlTemplateImageryProvider({
    url: `${GIBS}/${layer}/default/${date ?? 'default'}/GoogleMapsCompatible_Level${maxLevel}/{z}/{y}/{x}.${format}`,
    maximumLevel: maxLevel,
    credit: gibsCredit,
  });
}

export const BASEMAPS: Record<BasemapId, BasemapDef> = {
  'gibs-bluemarble': {
    id: 'gibs-bluemarble',
    label: 'Blue Marble (NASA GIBS), Esri when zoomed in',
    create: () => gibs('BlueMarble_ShadedRelief_Bathymetry', 8),
    detail: { create: esriImagery, fromLevel: 8 },
  },
  'gibs-blackmarble': {
    id: 'gibs-blackmarble',
    label: 'Black Marble night lights (NASA GIBS)',
    create: () => gibs('VIIRS_Black_Marble', 8, 'png'),
  },
  'gibs-truecolor': {
    id: 'gibs-truecolor',
    label: 'VIIRS NOAA-20 true color, daily (NASA GIBS)',
    // Daily imagery: pass a YYYY-MM-DD date, default is the latest available.
    create: (o) => gibs('VIIRS_NOAA20_CorrectedReflectance_TrueColor', 9, 'jpg', o?.date),
    detail: { create: esriImagery, fromLevel: 10 },
  },
  'esri-imagery': {
    id: 'esri-imagery',
    label: 'Esri World Imagery',
    create: esriImagery,
  },
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    create: () =>
      new Cesium.UrlTemplateImageryProvider({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        maximumLevel: 19,
        credit: new Cesium.Credit('Map data: OpenStreetMap contributors', true),
      }),
  },
};

export const OVERLAYS: Record<OverlayId, BasemapDef> = {
  'gibs-coastlines': {
    id: 'gibs-coastlines',
    label: 'Coastlines',
    create: () => gibs('Coastlines_15m', 13, 'png'),
  },
  'gibs-reference': {
    id: 'gibs-reference',
    label: 'Borders and roads (visible when zoomed in)',
    create: () => gibs('Reference_Features_15m', 13, 'png'),
  },
  'esri-labels': {
    id: 'esri-labels',
    label: 'Place names and borders (Esri)',
    create: () =>
      new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 19,
        credit: new Cesium.Credit('Labels: Esri', true),
      }),
  },
  'gibs-labels': {
    id: 'gibs-labels',
    label: 'Place labels',
    create: () => gibs('Reference_Labels_15m', 13, 'png'),
  },
};
