import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// CesiumJS needs its Workers, Assets, Widgets and ThirdParty folders served as static files.
const cesiumSource = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesiumStatic';

export default defineConfig({
  base: './',
  define: { CESIUM_BASE_URL: JSON.stringify(`./${cesiumBaseUrl}`) },
  plugins: [
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((d) => ({
        src: `${cesiumSource}/${d}`,
        dest: cesiumBaseUrl,
        // v4 keeps the source path: strip node_modules/cesium/Build/Cesium
        rename: { stripBase: 4 },
      })),
    }),
  ],
  // Two pages: the globe and the data table (the table page never loads Cesium).
  build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), table: resolve(__dirname, 'table.html') } } },
  server: {
    port: 5199,
    // Local data service for zoomed-in detections: python server/fire_api.py
    proxy: { '/api': 'http://127.0.0.1:5198' },
  },
  // Preview = the static online version: no data service, data from public/data via DuckDB-WASM.
  preview: { port: 5197, proxy: {} },
});
