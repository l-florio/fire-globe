import { createExplorer } from './explorer/explorer';
import { applyI18n } from './i18n';
import { mountAppBar } from './appBar';
import { openRegionOnGlobe } from './nav';
import { readShare } from './share';
import './tablePage.css';

// The data table as a page of its own: no globe, no Cesium. The period handed over by the globe (#t=YYYY-MM)
// presets the regions dataset.
const key = readShare().t ?? '';
mountAppBar({ current: 'table' });
applyI18n();

document.getElementById('table-main')!.append(
  createExplorer({
    baseUrl: `${import.meta.env.BASE_URL}data/`,
    month: /^\d{4}-\d{2}/.test(key) ? key.slice(0, 7) : undefined,
    onPick: openRegionOnGlobe,
  }),
);
