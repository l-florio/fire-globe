import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { BASEMAPS, OVERLAYS, type BasemapId, type OverlayId } from './basemaps';
import { flightSeconds } from './a11y';

export interface GlobeOptions {
  container: HTMLElement | string;
  basemap?: BasemapId;
  overlays?: OverlayId[];
  /** Only needed for ion assets (world terrain, Google 3D tiles). Everything else is keyless. */
  ionToken?: string;
  /** Initial camera: lon, lat in degrees, height in metres. */
  view?: { lon: number; lat: number; height: number };
  /** Farthest camera distance from the Earth centre, in Earth radii. */
  maxDistanceRadii?: number;
}

export interface Globe {
  viewer: Cesium.Viewer;
  setBasemap(id: BasemapId, opts?: { date?: string }): void;
  setOverlay(id: OverlayId, on: boolean): void;
  flyTo(lon: number, lat: number, height: number, seconds?: number): void;
  /** Call after adding data layers, to keep borders and labels on top. */
  raiseOverlays(): void;
  destroy(): void;
}

/**
 * A Cesium globe with no ion dependency: no default Bing imagery, no geocoder,
 * no ion terrain. Viewer option choices (baseLayer: false, widgets off) follow
 * the approach of gods-eye-view (MIT, Bilawal Sidhu).
 */
export function createGlobe(opts: GlobeOptions): Globe {
  if (opts.ionToken) Cesium.Ion.defaultAccessToken = opts.ionToken;
  const viewer = new Cesium.Viewer(opts.container, {
    baseLayer: false,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    msaaSamples: 4,
    // Keep the last frame readable, so that the map can be exported as an image or video (small GPU cost).
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
    requestRenderMode: true, // render only on change: the data is static between frames
    maximumRenderTimeChange: Infinity,
  });
  const { scene } = viewer;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1220');
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = false;
  const ctrl = scene.screenSpaceCameraController;
  ctrl.minimumZoomDistance = 30; // street scale, as in web maps
  ctrl.maximumZoomDistance = (opts.maxDistanceRadii ?? 4) * Cesium.Ellipsoid.WGS84.maximumRadius;

  const zoomTo = (target: number) => {
    const h = viewer.camera.positionCartographic.height;
    const t = Math.min(ctrl.maximumZoomDistance, Math.max(ctrl.minimumZoomDistance, target));
    if (t < h) viewer.camera.zoomIn(h - t);
    else viewer.camera.zoomOut(t - h);
    scene.requestRender();
  };
  // Touchpad pinch arrives as wheel + ctrlKey: Cesium ignores it and the browser would zoom the page.
  // Ctrl held on the keyboard + wheel is the browser's page zoom (WCAG 1.4.4): left alone. A pinch sets ctrlKey
  // without any Control key press, which tells the two apart.
  // Capture on the container so this runs before Cesium's own canvas listener.
  let ctrlHeld = false;
  window.addEventListener('keydown', (e) => e.key === 'Control' && (ctrlHeld = true));
  window.addEventListener('keyup', (e) => e.key === 'Control' && (ctrlHeld = false));
  window.addEventListener('blur', () => (ctrlHeld = false));
  viewer.container.addEventListener(
    'wheel',
    (e) => {
      if (!(e as WheelEvent).ctrlKey) return;
      if (ctrlHeld) {
        e.stopPropagation(); // page zoom of the browser: the globe does not zoom as well
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const dy = Math.max(-50, Math.min(50, (e as WheelEvent).deltaY));
      zoomTo(viewer.camera.positionCartographic.height * Math.exp(dy * 0.02));
    },
    { passive: false, capture: true },
  );
  // Double click: move closer to the clicked point (replaces the default entity tracking).
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  viewer.screenSpaceEventHandler.setInputAction((m: { position: Cesium.Cartesian2 }) => {
    const p = viewer.camera.pickEllipsoid(m.position, scene.globe.ellipsoid);
    if (!p) return;
    const c = Cesium.Cartographic.fromCartesian(p);
    const h = Math.max(ctrl.minimumZoomDistance, viewer.camera.positionCartographic.height / 3);
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h), duration: flightSeconds(0.8) });
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  // Basemap is always layer 0; overlays sit above data layers added later (raised on toggle).
  let base: Cesium.ImageryLayer | undefined;
  let detail: Cesium.ImageryLayer | undefined;
  const overlays = new Map<OverlayId, Cesium.ImageryLayer>();

  function setBasemap(id: BasemapId, o?: { date?: string }) {
    const def = BASEMAPS[id];
    const layer = new Cesium.ImageryLayer(def.create(o));
    const det = def.detail
      ? new Cesium.ImageryLayer(def.detail.create(), { minimumTerrainLevel: def.detail.fromLevel })
      : undefined;
    viewer.imageryLayers.add(layer, 0);
    if (det) viewer.imageryLayers.add(det, 1);
    if (base) viewer.imageryLayers.remove(base, true);
    if (detail) viewer.imageryLayers.remove(detail, true);
    base = layer;
    detail = det;
    scene.requestRender();
  }

  function setOverlay(id: OverlayId, on: boolean) {
    const cur = overlays.get(id);
    if (on && !cur) {
      const layer = viewer.imageryLayers.addImageryProvider(OVERLAYS[id].create());
      overlays.set(id, layer);
    } else if (!on && cur) {
      viewer.imageryLayers.remove(cur, true);
      overlays.delete(id);
    }
    raiseOverlays();
  }

  function raiseOverlays() {
    for (const l of overlays.values()) viewer.imageryLayers.raiseToTop(l);
    scene.requestRender();
  }

  function flyTo(lon: number, lat: number, height: number, seconds = 1.5) {
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, height), duration: flightSeconds(seconds) });
  }

  setBasemap(opts.basemap ?? 'gibs-bluemarble');
  for (const o of opts.overlays ?? []) setOverlay(o, true);
  const v = opts.view ?? { lon: 12, lat: 30, height: 18_000_000 };
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height) });

  return { viewer, setBasemap, setOverlay, flyTo, raiseOverlays, destroy: () => viewer.destroy() };
}
