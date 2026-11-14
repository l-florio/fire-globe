/**
 * Tiny i18n for the app (no library). English is the source of truth: every key lives in `en`;
 * `it` may omit keys and then falls back to English.
 * Language: ?lang=it|en in the URL, else the saved choice (localStorage), else English.
 * Changing the language saves it and reloads the page (modules build their strings at load).
 * The generic globe library (src/globe) never imports this: the app passes translated labels to it.
 */
export type Lang = 'en' | 'it';

const STORE = 'fireglobe.lang';
const isLang = (v: unknown): v is Lang => v === 'en' || v === 'it';

function detectLang(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (isLang(q)) return q;
  } catch {
    /* ignore */
  }
  try {
    const s = localStorage.getItem(STORE);
    if (isLang(s)) return s;
  } catch {
    /* storage blocked */
  }
  return 'en';
}

export const lang: Lang = detectLang();
/** BCP 47 locale of the active language, for numbers and dates. */
export const locale = lang === 'it' ? 'it-IT' : 'en';

/** Save the choice and reload. The ?lang= parameter is dropped so that it cannot override the new choice. */
export function setLang(next: Lang) {
  let saved = false;
  try {
    localStorage.setItem(STORE, next);
    saved = true;
  } catch {
    /* storage blocked: fall back to the URL parameter */
  }
  const url = new URL(location.href);
  if (saved) url.searchParams.delete('lang');
  else url.searchParams.set('lang', next);
  location.href = url.toString();
}

// ------------------------------------------------------------------ dictionaries

const en = {
  // ---- page and main panel
  'app.title': 'Fire Globe',
  'panel.title': 'Active fires from space, 2000-2026',
  'panel.hide': 'Hide',
  'panel.controls': 'Controls',
  'lang.label': 'Language',
  'sub.raw': 'NASA FIRMS, monthly, 0.25° grid.',
  'sub.harm': 'NASA FIRMS, monthly, 1° cells.',
  'badge.raw': 'Raw per-sensor data, not harmonized',
  'badge.harm': 'MODIS and VIIRS harmonized: one consistent series',
  'ctl.variable': 'Variable',
  'ctl.show': 'Show',
  'ctl.sensorsShown': 'Sensors shown',
  'ctl.both': 'Both',
  'ctl.harmonized': 'Harmonized',
  'ctl.harmonized.title': 'MODIS and VIIRS harmonized into one consistent series',
  'ctl.timeStep': 'Time step',
  'ctl.month': 'Month',
  'ctl.day': 'Day',
  'ctl.harmSeries': 'Harmonized series',
  'ctl.viirsSat': 'VIIRS satellite',
  'ctl.left': 'Left:',
  'ctl.right': 'Right:',
  'ctl.swap': 'Swap sides',
  'ctl.swap.title': 'Swap left and right',
  'ctl.overpass': 'Overpass',
  'ctl.passAll': 'All',
  'ctl.passDay': 'Daytime',
  'ctl.passNight': 'Night',
  'ctl.modisSat': 'MODIS satellite',
  'ctl.sat.all': 'Terra + Aqua',
  'ctl.sat.terra': 'Terra only (about 10:30 and 22:30 local)',
  'ctl.sat.aqua': 'Aqua only (about 13:30 and 01:30 local)',
  'ctl.gain': 'Color range (upper limit)',
  'ctl.basemap': 'Basemap',
  'ctl.borders': 'Coastlines, borders and place names',
  'ctl.allDays': 'All days',
  'ctl.dayOfMonth': '{m} {d}',
  'ctl.dayLabel': 'Day',
  'ctl.stepDay.harm': 'The harmonized series is monthly',
  'ctl.stepDay.ok': 'One day at a time, individual detections',
  'ctl.stepDay.noData': 'Needs the data service or the static data files',
  'ctl.list': 'List',
  'ctl.list.title': 'List the detections in view, strongest first',
  'view.globe': 'Globe',
  'view.table': 'Table',
  'view.table.title': 'Harmonized data by country or region, as a table',

  // ---- names that come from the data manifest
  'metric.n': 'Active fire detections',
  'metric.n.unit': 'detections / cell / month',
  'metric.frp': 'Fire radiative power',
  'metric.frp.unit': 'MW / cell / month (sum)',
  'sensor.HARM_LONG': 'Harmonized, long-term (Aqua-equivalent, 2003+)',
  'sensor.HARM_DETAIL': 'Harmonized, detail (VIIRS 375 m, 2013+)',
  'basemap.gibs-bluemarble': 'Blue Marble (NASA GIBS), Esri when zoomed in',
  'basemap.gibs-blackmarble': 'Black Marble night lights (NASA GIBS)',
  'basemap.gibs-truecolor': 'VIIRS NOAA-20 true color, daily (NASA GIBS)',
  'basemap.esri-imagery': 'Esri World Imagery',
  'basemap.osm': 'OpenStreetMap',

  // ---- legend and notes
  'legend.detection': 'Single detection: fire radiative power (MW, log scale)',
  'legend.harm': 'Harmonized: {unit} / 1 degree cell / month, log scale',
  'legend.harm.long': 'Aqua-equivalent detections',
  'legend.harm.detail': 'VIIRS detections (S-NPP level)',
  'legend.metric': '{label} ({unit}, log scale)',
  'note.noData': ' - no data',
  'note.partial': '{month} is a partial month (data up to today).',
  'note.missing': 'No {sensors} data for {date}.',
  'note.zoom': 'Zoom in below 2,500 km to see individual detections.',
  'note.harmDetections': 'Single detections are shown in the MODIS and VIIRS views.',

  // ---- single detections (detail.ts) and their list
  'det.filtered': 'Shown after filters: {counts}.',
  'det.needService': 'Detections need the local data service or the static data files.',
  'det.loading': 'Loading detections...',
  'det.strongest': '{name}: strongest {n} of {total}',
  'det.total': '{name}: {total}',
  'det.where.region': 'in the covered region',
  'det.where.world': 'worldwide',
  'det.where.view': 'in view',
  'det.month': 'month {period}',
  'det.outside': '{outside} Zoom or move there to see single detections.',
  'det.status': 'Detections {where} ({period}) - {parts}.',
  'det.error': 'Could not load detections: {msg}',
  'det.title': 'Detections in view',
  'det.close': 'Close',
  'det.csv': 'CSV',
  'det.empty': 'No detections loaded: zoom in below 2,500 km, or switch to the Day step.',
  'det.strongestOf': 'Strongest {n} of {total} loaded detections.',
  'det.count.one': '{n} detection.',
  'det.count.other': '{n} detections.',
  'det.hint': 'Hover a row to mark the detection on the globe; click to fly there.',
  'det.col.date': 'Date',
  'det.col.utc': 'UTC',
  'det.col.sat': 'Satellite',
  'det.col.frp': 'FRP (MW)',
  'det.col.conf': 'Conf.',
  'det.col.pass': 'Pass',
  'det.col.pos': 'Lat, Lon',
  'det.day': 'Day',
  'det.night': 'Night',
  'det.conf.low': 'low',
  'det.conf.nominal': 'nominal',
  'det.conf.high': 'high',

  // ---- data source
  'data.note.api': 'Local data service: full FIRMS archive.',
  'data.loadingEngine': 'Loading the data engine...',
  'data.noSource': 'no data source available',

  // ---- area fire calendar
  'cal.title': 'Area fire calendar',
  'cal.button': 'Area fire calendar',
  'cal.button.title': 'Calendar of fire activity for an area, with CSV export. {note}',
  'cal.close': 'Close',
  'cal.draw': 'Draw a box',
  'cal.view': 'Use current view',
  'cal.clear': 'Clear area',
  'cal.clear.title': 'Remove the area from the globe and reset the calendar',
  'cal.search.placeholder': 'Town, region, country or address',
  'cal.search.aria': 'Search a place',
  'cal.search.btn': 'Search',
  'cal.region.aria': 'Continent or GFED region',
  'cal.region.placeholder': 'Or a continent / GFED region...',
  'cal.region.continents': 'Continents',
  'cal.region.gfed': 'GFED fire regions',
  'cal.lat': 'Lat',
  'cal.lat.aria': 'Latitude',
  'cal.lon': 'Lon',
  'cal.lon.aria': 'Longitude',
  'cal.km.aria': 'Radius in km',
  'cal.km.title': 'Radius (km)',
  'cal.pt.btn': 'Point + km',
  'cal.noArea': 'No area yet: search a place, pick a region, draw a box, use the view, or enter a point and a radius.',
  'cal.sensor': 'Sensor',
  'cal.variable': 'Variable',
  'cal.var.n': 'Detections',
  'cal.var.n.lower': 'detections',
  'cal.var.frp': 'FRP (MW)',
  'cal.colour': 'Colour',
  'cal.colour.value': 'Value',
  'cal.colour.anomaly': 'vs median',
  'cal.excl': 'Exclude volcanoes and industrial sources',
  'cal.csvCal': 'Calendar CSV',
  'cal.pngCal': 'Calendar PNG',
  'cal.pngCal.title': 'Image of the calendar with its legend',
  'cal.range.from': 'Hotspots from',
  'cal.range.to': 'to',
  'cal.csvPts': 'Hotspots CSV',
  'cal.csvPts.harm': 'Single detections: choose MODIS or a VIIRS satellite',
  'cal.preparing': 'Preparing...',
  'cal.exportFailed': 'Export failed: {msg}',
  'cal.raw': 'Raw counts of one sensor. MODIS and VIIRS are not comparable until harmonized.',
  'cal.credits':
    'Place search: {nominatim}, data &copy; {osm} (outlines may differ slightly from the basemap borders, drawn by Esri). Continents: Natural Earth. Fire regions: GFED basis regions (Giglio et al. 2013).',
  'cal.loading': 'Loading...',
  'cal.loadError': 'Could not load the calendar: {msg}',
  'cal.src.harmLong':
    'Harmonized long-term series, Aqua-equivalent detections on 1 degree cells overlapping the area. 2003-2021 measured by Aqua; from 2022 (and Aug 2020) converted from VIIRS, with a 90% interval.',
  'cal.src.harmDetail':
    'Harmonized detail series, VIIRS 375 m detections at S-NPP level (2013+), 1 degree cells. The band is the spread between satellite pairs, not a confidence interval.',
  'cal.src.grid':
    'Counted on the 0.25 degree grid cells overlapping the area (for small areas this counts the whole cells: use the Hotspots CSV for exact points).',
  'cal.src.detections': 'Counted from single detections.',
  'cal.areaCopy': '{area} - {sensor}, {var}',
  'cal.legend.anomaly': ' Colour: ratio to the median of the same month in the other years, blue 1/4x, white 1x, red 4x.',
  'cal.legend.value': ' Colour: viridis, log scale.',
  'cal.sum.month': '<b>{name}</b>: {value} {unit}',
  'cal.sum.median':
    ', <b>{ratio}x</b> the median of the same month ({median}, {years}), higher than {pct}% of them.',
  'cal.sum.years.one': '{n} other year',
  'cal.sum.years.other': '{n} other years',
  'cal.sum.interval': '90% interval',
  'cal.sum.spread': 'spread between satellite pairs',
  'cal.sum.intervalLine': '{what}: {lo}-{hi}. ',
  'cal.sum.sig': 'The median of the other years is outside the 90% interval of this month (the uncertainty of the median itself is not included).',
  'cal.sum.notSig': 'The median is inside the 90% interval: the difference is within the uncertainty.',
  'cal.sum.partial': ' (partial month, data still arriving: not compared with full months).',
  'cal.sum.aqua': 'Measured by Aqua MODIS (no conversion).',
  'cal.sum.noData': 'No {sensor} data for {key}.',
  'cal.sum.peak': 'Peak month over the record: <b>{month}</b>. Most active years: {years}.',
  'cal.drawHint': 'Click two opposite corners on the globe (Esc cancels).',
  'cal.usePoint': '{label}: {area}. Change the radius below and press "{btn}" to widen it.',
  'cal.outline.loading': 'Loading the outline...',
  'cal.outline.error': 'Could not load the outline: {msg}',
  'cal.searching': 'Searching...',
  'cal.noPlace': 'No place found.',
  'cal.searchFailed': 'Search failed: {msg}',
  'cal.regionLabel.continent': '{name} (continent, Natural Earth)',
  'cal.regionLabel.gfed': '{name} (GFED {code})',
  'cal.continent.AF': 'Africa',
  'cal.continent.AS': 'Asia',
  'cal.continent.EU': 'Europe',
  'cal.continent.NA': 'North America',
  'cal.continent.SA': 'South America',
  'cal.continent.OC': 'Oceania',
  'cal.gfed.BONA': 'Boreal North America',
  'cal.gfed.TENA': 'Temperate North America',
  'cal.gfed.CEAM': 'Central America',
  'cal.gfed.NHSA': 'Northern Hemisphere South America',
  'cal.gfed.SHSA': 'Southern Hemisphere South America',
  'cal.gfed.EURO': 'Europe',
  'cal.gfed.MIDE': 'Middle East',
  'cal.gfed.NHAF': 'Northern Hemisphere Africa',
  'cal.gfed.SHAF': 'Southern Hemisphere Africa',
  'cal.gfed.BOAS': 'Boreal Asia',
  'cal.gfed.CEAS': 'Central Asia',
  'cal.gfed.SEAS': 'Southeast Asia',
  'cal.gfed.EQAS': 'Equatorial Asia',
  'cal.gfed.AUST': 'Australia and New Zealand',
  // OpenStreetMap feature types in the place list
  'place.street': 'street',
  'place.address': 'address',
  'place.place': 'place',
  'place.area': 'area',
  'place.city': 'city',
  'place.town': 'town',
  'place.village': 'village',
  'place.hamlet': 'hamlet',
  'place.suburb': 'suburb',
  'place.state': 'state',
  'place.region': 'region',
  'place.county': 'county',
  'place.country': 'country',
  'place.continent': 'continent',
  'place.municipality': 'municipality',
  'place.island': 'island',
  'place.road': 'road',
  'place.neighbourhood': 'neighbourhood',
  'place.administrative': 'administrative',

  // ---- area labels (globe library, areaLabel)
  'area.cells': '{n} cells of {res} deg, about {km2} km2',
  'area.cellsPlace': '{label} (place about {place} km2; counted on {cells})',
  'area.cellsPlain': '{label} ({cells})',
  'area.box': 'Box {s}..{n} N, {w}..{e} E (about {km2} km2)',
  'area.circle': '{km} km around {lat} N, {lon} E',

  // ---- globe library controls
  'slider.play': 'Play',
  'slider.pause': 'Pause',
  'slider.time': 'Time',
  'slider.date': 'Date',
  'slider.speed': 'Speed',
  'slider.year': 'Year',
  'slider.month': 'Month',
  'slider.day': 'Day',
  'zoom.in': 'Zoom in',
  'zoom.in.title': 'Zoom in (+)',
  'zoom.out': 'Zoom out',
  'zoom.out.title': 'Zoom out (-)',
  'zoom.home': 'Reset view',
  'zoom.home.title': 'Reset view (0)',
  'split.drag': 'Drag to compare',

  // ---- calendar heatmap (globe library)
  'heat.months': 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec',
  'heat.empty': 'No data for this area.',
  'heat.year': 'Year',
  'heat.median': 'Med.',
  'heat.noData': '{month} {year}: no data',
  'heat.partial': '{tip} (partial month, data still arriving)',
  'heat.tip': '{month} {year}: {value}',
  'heat.tip.interval': ' (90%: {lo}-{hi})',
  'heat.tip.median': '; {ratio}x the {month} median ({median}, {years}); higher than {pct}% of them',
  'heat.tip.years.one': '{n} other year',
  'heat.tip.years.other': '{n} other years',
  'heat.medianTip': 'Median {month}: {value}',

  // ---- export (exporter.ts)
  'exp.button': 'Export',
  'exp.buttonTitle': 'Export image or video',
  'exp.mapPng': 'Map image (PNG)',
  'exp.videoSection': 'Video (time animation)',
  'exp.videoStart': 'Start recording',
  'exp.cancel': 'Cancel',
  'exp.from': 'From',
  'exp.to': 'To',
  'exp.fps': 'Frames/s',
  'exp.resolution': 'Resolution',
  'exp.resCurrent': 'Current view ({w}x{h})',
  'exp.frames.one': '{n} frame, about {sec} s of video',
  'exp.frames.other': '{n} frames, about {sec} s of video',
  'exp.rangeInvalid': 'End must not precede start.',
  'exp.noVideo': 'Video recording is not supported by this browser.',
  'exp.keepVisible': 'Keep this tab visible while recording.',
  'exp.progress': 'Frame {i} of {n}: {label}',
  'exp.progressAria': 'Progress',
  'exp.finishing': 'Encoding file...',
  'exp.saved': 'Saved {name}',
  'exp.cancelled': 'Cancelled.',
  'exp.failed': 'Export failed: {msg}',
  'exp.working': 'Working...',
  'exp.dataCredit': 'Data: NASA FIRMS (MODIS / VIIRS active fire)',
  'exp.imageryFallback': 'Imagery: NASA GIBS / Esri',
  'exp.popLabel': 'Export options',
  'exp.err.canvas': 'Empty canvas',
  'exp.err.blob': 'Image rendering failed',
} as const;

export type Key = keyof typeof en;
/** Keys that have a `.one` and `.other` form, for tn(). */
type BaseOf<K> = K extends `${infer B}.one` ? B : never;
type PluralKey = BaseOf<Key>;

const it: Partial<Record<Key, string>> = {
  'app.title': 'Fire Globe',
  'panel.title': 'Incendi attivi dallo spazio, 2000-2026',
  'panel.hide': 'Nascondi',
  'panel.controls': 'Controlli',
  'lang.label': 'Lingua',
  'sub.raw': 'NASA FIRMS, mensile, griglia a 0,25°.',
  'sub.harm': 'NASA FIRMS, mensile, celle da 1°.',
  'badge.raw': 'Dati grezzi per sensore, non armonizzati',
  'badge.harm': "MODIS e VIIRS armonizzati: un'unica serie coerente",
  'ctl.variable': 'Variabile',
  'ctl.show': 'Mostra',
  'ctl.sensorsShown': 'Sensori mostrati',
  'ctl.both': 'Entrambi',
  'ctl.harmonized': 'Armoniz.',
  'ctl.harmonized.title': "MODIS e VIIRS armonizzati in un'unica serie coerente",
  'ctl.timeStep': 'Passo temporale',
  'ctl.month': 'Mese',
  'ctl.day': 'Giorno',
  'ctl.harmSeries': 'Serie armonizzata',
  'ctl.viirsSat': 'Satellite VIIRS',
  'ctl.left': 'Sinistra:',
  'ctl.right': 'Destra:',
  'ctl.swap': 'Scambia lati',
  'ctl.swap.title': 'Scambia sinistra e destra',
  'ctl.overpass': 'Passaggio',
  'ctl.passAll': 'Tutti',
  'ctl.passDay': 'Diurno',
  'ctl.passNight': 'Notturno',
  'ctl.modisSat': 'Satellite MODIS',
  'ctl.sat.terra': 'Solo Terra (circa 10:30 e 22:30 ora locale)',
  'ctl.sat.aqua': 'Solo Aqua (circa 13:30 e 01:30 ora locale)',
  'ctl.gain': 'Intervallo colori (limite superiore)',
  'ctl.basemap': 'Mappa di base',
  'ctl.borders': 'Coste, confini e toponimi',
  'ctl.allDays': 'Tutti i giorni',
  'ctl.dayOfMonth': '{d} {m}',
  'ctl.dayLabel': 'Giorno',
  'ctl.stepDay.harm': 'La serie armonizzata è mensile',
  'ctl.stepDay.ok': 'Un giorno alla volta, rilevamenti singoli',
  'ctl.stepDay.noData': 'Richiede il servizio dati o i file dati statici',
  'ctl.list': 'Elenco',
  'ctl.list.title': 'Elenca i rilevamenti in vista, dai più intensi',
  'view.globe': 'Globo',
  'view.table': 'Tabella',
  'view.table.title': 'Dati armonizzati per paese o regione, in tabella',

  'metric.n': 'Rilevamenti di fuoco attivo',
  'metric.n.unit': 'rilevamenti / cella / mese',
  'metric.frp': 'Potenza radiativa del fuoco (FRP)',
  'metric.frp.unit': 'MW / cella / mese (somma)',
  'sensor.HARM_LONG': 'Armonizzata, lungo periodo (equivalente Aqua, dal 2003)',
  'sensor.HARM_DETAIL': 'Armonizzata, dettaglio (VIIRS 375 m, dal 2013)',
  'basemap.gibs-bluemarble': 'Blue Marble (NASA GIBS), Esri con zoom ravvicinato',
  'basemap.gibs-blackmarble': 'Black Marble, luci notturne (NASA GIBS)',
  'basemap.gibs-truecolor': 'VIIRS NOAA-20 colori reali, giornaliero (NASA GIBS)',

  'legend.detection': 'Singolo rilevamento: potenza radiativa del fuoco (MW, scala log)',
  'legend.harm': 'Armonizzato: {unit} / cella da 1 grado / mese, scala logaritmica',
  'legend.harm.long': 'rilevamenti equivalenti Aqua',
  'legend.harm.detail': 'rilevamenti VIIRS (livello S-NPP)',
  'legend.metric': '{label} ({unit}, scala logaritmica)',
  'note.noData': ' - nessun dato',
  'note.partial': '{month} è un mese parziale (dati fino a oggi).',
  'note.missing': 'Nessun dato {sensors} per {date}.',
  'note.zoom': 'Avvicinati sotto i 2.500 km per vedere i singoli rilevamenti.',
  'note.harmDetections': 'I singoli rilevamenti sono visibili nelle viste MODIS e VIIRS.',

  'det.filtered': 'Dopo i filtri: {counts}.',
  'det.needService': 'I rilevamenti richiedono il servizio dati locale o i file dati statici.',
  'det.loading': 'Caricamento dei rilevamenti...',
  'det.strongest': '{name}: i {n} più intensi su {total}',
  'det.where.region': 'nella regione coperta',
  'det.where.world': 'in tutto il mondo',
  'det.where.view': 'in vista',
  'det.month': 'mese {period}',
  'det.outside': '{outside} Avvicinati o spostati lì per vedere i singoli rilevamenti.',
  'det.status': 'Rilevamenti {where} ({period}): {parts}.',
  'det.error': 'Impossibile caricare i rilevamenti: {msg}',
  'det.title': 'Rilevamenti in vista',
  'det.close': 'Chiudi',
  'det.empty': 'Nessun rilevamento caricato: avvicinati sotto i 2.500 km, oppure passa al passo Giorno.',
  'det.strongestOf': 'I {n} più intensi su {total} rilevamenti caricati.',
  'det.count.one': '{n} rilevamento.',
  'det.count.other': '{n} rilevamenti.',
  'det.hint': 'Passa il mouse su una riga per evidenziare il rilevamento sul globo; clicca per volare lì.',
  'det.col.date': 'Data',
  'det.col.sat': 'Satellite',
  'det.col.pass': 'Passaggio',
  'det.col.pos': 'Lat, Lon',
  'det.day': 'Giorno',
  'det.night': 'Notte',
  'det.conf.low': 'bassa',
  'det.conf.nominal': 'nominale',
  'det.conf.high': 'alta',

  'data.note.api': 'Servizio dati locale: archivio FIRMS completo.',
  'data.loadingEngine': 'Caricamento del motore dati...',
  'data.noSource': 'nessuna fonte dati disponibile',

  'cal.title': 'Calendario degli incendi per area',
  'cal.button': 'Calendario incendi per area',
  'cal.button.title': "Calendario dell'attività degli incendi per un'area, con esportazione CSV. {note}",
  'cal.close': 'Chiudi',
  'cal.draw': 'Disegna un riquadro',
  'cal.view': 'Usa la vista attuale',
  'cal.clear': 'Cancella area',
  'cal.clear.title': "Rimuove l'area dal globo e azzera il calendario",
  'cal.search.placeholder': 'Città, regione, paese o indirizzo',
  'cal.search.aria': 'Cerca un luogo',
  'cal.search.btn': 'Cerca',
  'cal.region.aria': 'Continente o regione GFED',
  'cal.region.placeholder': 'Oppure un continente / regione GFED...',
  'cal.region.continents': 'Continenti',
  'cal.region.gfed': 'Regioni di fuoco GFED',
  'cal.lat.aria': 'Latitudine',
  'cal.lon.aria': 'Longitudine',
  'cal.km.aria': 'Raggio in km',
  'cal.km.title': 'Raggio (km)',
  'cal.pt.btn': 'Punto + km',
  'cal.noArea': "Nessuna area: cerca un luogo, scegli una regione, disegna un riquadro, usa la vista o inserisci un punto e un raggio.",
  'cal.sensor': 'Sensore',
  'cal.variable': 'Variabile',
  'cal.var.n': 'Rilevamenti',
  'cal.var.n.lower': 'rilevamenti',
  'cal.colour': 'Colore',
  'cal.colour.value': 'Valore',
  'cal.colour.anomaly': 'vs mediana',
  'cal.excl': 'Escludi vulcani e fonti industriali',
  'cal.csvCal': 'CSV calendario',
  'cal.pngCal': 'PNG calendario',
  'cal.pngCal.title': 'Immagine del calendario con la sua legenda',
  'cal.range.from': 'Rilevamenti dal',
  'cal.range.to': 'al',
  'cal.csvPts': 'CSV rilevamenti',
  'cal.csvPts.harm': 'Rilevamenti singoli: scegli MODIS o un satellite VIIRS',
  'cal.preparing': 'Preparazione...',
  'cal.exportFailed': 'Esportazione non riuscita: {msg}',
  'cal.raw': 'Conteggi grezzi di un solo sensore. MODIS e VIIRS non sono confrontabili finché non vengono armonizzati.',
  'cal.credits':
    'Ricerca luoghi: {nominatim}, dati &copy; {osm} (i contorni possono differire leggermente dai confini della mappa di base, disegnati da Esri). Continenti: Natural Earth. Regioni di fuoco: regioni di base GFED (Giglio et al. 2013).',
  'cal.loading': 'Caricamento...',
  'cal.loadError': 'Impossibile caricare il calendario: {msg}',
  'cal.src.harmLong':
    "Serie armonizzata a lungo termine, rilevamenti equivalenti Aqua su celle da 1 grado che intersecano l'area. 2003-2021 misurati da Aqua; dal 2022 (e ago 2020) convertiti da VIIRS, con intervallo al 90%.",
  'cal.src.harmDetail':
    "Serie armonizzata di dettaglio, rilevamenti VIIRS a 375 m a livello S-NPP (dal 2013), celle da 1 grado. La banda è la dispersione tra coppie di satelliti, non un intervallo di confidenza.",
  'cal.src.grid':
    "Conteggio sulle celle della griglia da 0,25 gradi che intersecano l'area (per aree piccole si contano le celle intere: usa il CSV dei rilevamenti per i punti esatti).",
  'cal.src.detections': 'Conteggio dai singoli rilevamenti.',
  'cal.legend.anomaly': ' Colore: rapporto con la mediana dello stesso mese negli altri anni, blu 1/4x, bianco 1x, rosso 4x.',
  'cal.legend.value': ' Colore: viridis, scala logaritmica.',
  'cal.sum.median':
    ', <b>{ratio}x</b> la mediana dello stesso mese ({median}, {years}), maggiore del {pct}% di essi.',
  'cal.sum.years.one': '{n} altro anno',
  'cal.sum.years.other': '{n} altri anni',
  'cal.sum.interval': 'intervallo al 90%',
  'cal.sum.spread': 'dispersione tra coppie di satelliti',
  'cal.sum.sig': "La mediana degli altri anni è fuori dall'intervallo al 90% di questo mese (l'incertezza della mediana stessa non è inclusa).",
  'cal.sum.notSig': "La mediana è dentro l'intervallo al 90%: la differenza rientra nell'incertezza.",
  'cal.sum.partial': ' (mese parziale, dati ancora in arrivo: non confrontato con i mesi completi).',
  'cal.sum.aqua': 'Misurato da Aqua MODIS (senza conversione).',
  'cal.sum.noData': 'Nessun dato {sensor} per {key}.',
  'cal.sum.peak': 'Mese di picco nella serie: <b>{month}</b>. Anni più attivi: {years}.',
  'cal.drawHint': 'Clicca due angoli opposti sul globo (Esc annulla).',
  'cal.usePoint': '{label}: {area}. Cambia il raggio qui sotto e premi "{btn}" per ampliarla.',
  'cal.outline.loading': 'Caricamento del contorno...',
  'cal.outline.error': 'Impossibile caricare il contorno: {msg}',
  'cal.searching': 'Ricerca in corso...',
  'cal.noPlace': 'Nessun luogo trovato.',
  'cal.searchFailed': 'Ricerca non riuscita: {msg}',
  'cal.regionLabel.continent': '{name} (continente, Natural Earth)',
  'cal.continent.EU': 'Europa',
  'cal.continent.NA': 'Nord America',
  'cal.continent.SA': 'Sud America',
  'cal.gfed.BONA': 'Nord America boreale',
  'cal.gfed.TENA': 'Nord America temperata',
  'cal.gfed.CEAM': 'America Centrale',
  'cal.gfed.NHSA': 'Sud America, emisfero nord',
  'cal.gfed.SHSA': 'Sud America, emisfero sud',
  'cal.gfed.EURO': 'Europa',
  'cal.gfed.MIDE': 'Medio Oriente',
  'cal.gfed.NHAF': 'Africa, emisfero nord',
  'cal.gfed.SHAF': 'Africa, emisfero sud',
  'cal.gfed.BOAS': 'Asia boreale',
  'cal.gfed.CEAS': 'Asia centrale',
  'cal.gfed.SEAS': 'Sud-est asiatico',
  'cal.gfed.EQAS': 'Asia equatoriale',
  'cal.gfed.AUST': 'Australia e Nuova Zelanda',
  'place.street': 'strada',
  'place.address': 'indirizzo',
  'place.place': 'luogo',
  'place.area': 'area',
  'place.city': 'città',
  'place.town': 'cittadina',
  'place.village': 'villaggio',
  'place.hamlet': 'frazione',
  'place.suburb': 'quartiere',
  'place.state': 'stato',
  'place.region': 'regione',
  'place.county': 'provincia',
  'place.country': 'paese',
  'place.continent': 'continente',
  'place.municipality': 'comune',
  'place.island': 'isola',
  'place.road': 'strada',
  'place.neighbourhood': 'quartiere',
  'place.administrative': 'area amministrativa',

  'area.cells': '{n} celle da {res} gradi, circa {km2} km2',
  'area.cellsPlace': '{label} (luogo di circa {place} km2; conteggio su {cells})',
  'area.box': 'Riquadro {s}..{n} N, {w}..{e} E (circa {km2} km2)',
  'area.circle': '{km} km intorno a {lat} N, {lon} E',

  'slider.play': 'Riproduci',
  'slider.pause': 'Pausa',
  'slider.time': 'Tempo',
  'slider.date': 'Data',
  'slider.speed': 'Velocità',
  'slider.year': 'Anno',
  'slider.month': 'Mese',
  'slider.day': 'Giorno',
  'zoom.in': 'Ingrandisci',
  'zoom.in.title': 'Ingrandisci (+)',
  'zoom.out': 'Riduci',
  'zoom.out.title': 'Riduci (-)',
  'zoom.home': 'Ripristina vista',
  'zoom.home.title': 'Ripristina vista (0)',
  'split.drag': 'Trascina per confrontare',

  'heat.months': 'Gen,Feb,Mar,Apr,Mag,Giu,Lug,Ago,Set,Ott,Nov,Dic',
  'heat.empty': 'Nessun dato per quest\'area.',
  'heat.year': 'Anno',
  'heat.median': 'Med.',
  'heat.noData': '{month} {year}: nessun dato',
  'heat.partial': '{tip} (mese parziale, dati ancora in arrivo)',
  'heat.tip.interval': ' (90%: {lo}-{hi})',
  'heat.tip.median': '; {ratio}x la mediana di {month} ({median}, {years}); maggiore del {pct}% di essi',
  'heat.tip.years.one': '{n} altro anno',
  'heat.tip.years.other': '{n} altri anni',
  'heat.medianTip': 'Mediana {month}: {value}',

  'exp.button': 'Esporta',
  'exp.buttonTitle': 'Esporta immagine o video',
  'exp.mapPng': 'Immagine della mappa (PNG)',
  'exp.videoSection': 'Video (animazione temporale)',
  'exp.videoStart': 'Avvia registrazione',
  'exp.cancel': 'Annulla',
  'exp.from': 'Da',
  'exp.to': 'A',
  'exp.fps': 'Fotogrammi/s',
  'exp.resolution': 'Risoluzione',
  'exp.resCurrent': 'Vista attuale ({w}x{h})',
  'exp.frames.one': '{n} fotogramma, circa {sec} s di video',
  'exp.frames.other': '{n} fotogrammi, circa {sec} s di video',
  'exp.rangeInvalid': 'La fine non può precedere l\'inizio.',
  'exp.noVideo': 'La registrazione video non è supportata da questo browser.',
  'exp.keepVisible': 'Tieni visibile questa scheda durante la registrazione.',
  'exp.progress': 'Fotogramma {i} di {n}: {label}',
  'exp.progressAria': 'Avanzamento',
  'exp.finishing': 'Codifica del file...',
  'exp.saved': 'Salvato {name}',
  'exp.cancelled': 'Annullato.',
  'exp.failed': 'Esportazione non riuscita: {msg}',
  'exp.working': 'Elaborazione...',
  'exp.dataCredit': 'Dati: NASA FIRMS (fuochi attivi MODIS / VIIRS)',
  'exp.imageryFallback': 'Immagini: NASA GIBS / Esri',
  'exp.popLabel': 'Opzioni di esportazione',
  'exp.err.canvas': 'Canvas vuoto',
  'exp.err.blob': 'Rendering dell\'immagine non riuscito',
};

const DICT: Record<Lang, Partial<Record<Key, string>>> = { en, it };

type Params = Record<string, string | number>;
const fill = (s: string, p?: Params) => (p ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m)) : s);

/** Translate a key; `{name}` placeholders are filled from params. Missing keys fall back to English. */
export function t(key: Key, p?: Params): string {
  return fill(DICT[lang][key] ?? en[key] ?? key, p);
}

/** Like t() for keys built at run time (manifest ids, region codes): returns `fallback` when the key does not exist. */
export function tOr(key: string, fallback: string, p?: Params): string {
  const k = key as Key;
  return fill(DICT[lang][k] ?? en[k] ?? fallback, p);
}

/** Plural helper: uses `<key>.one` when n is 1, else `<key>.other`; `{n}` is the formatted count. */
export function tn(key: PluralKey, n: number, p?: Params): string {
  const k = `${key}.${n === 1 ? 'one' : 'other'}` as Key;
  return fill(DICT[lang][k] ?? en[k] ?? k, { n: fmtInt(n), ...p });
}

// ------------------------------------------------------------------ number and date formats

export const fmtInt = (v: number) => Math.round(v).toLocaleString(locale);
/** Fixed number of decimals in the active locale (decimal comma in Italian). */
export const fmtFixed = (v: number, digits: number) =>
  v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Short month names, January first. */
export const monthsShort: string[] = t('heat.months').split(',');
/** One-letter month initials for compact headers. */
export const monthInitials: string[] = monthsShort.map((m) => m[0]);

// ------------------------------------------------------------------ DOM

/**
 * Apply the language to the static page: data-i18n (text), data-i18n-title, data-i18n-aria (aria-label),
 * data-i18n-placeholder; set <html lang> and the title; wire the language select (#lang).
 */
export function applyI18n(root: ParentNode = document) {
  document.documentElement.lang = lang;
  document.title = t('app.title');
  const each = (attr: string, fn: (el: HTMLElement, text: string) => void) => {
    for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) fn(el, t(el.getAttribute(attr) as Key));
  };
  each('data-i18n', (el, s) => (el.textContent = s));
  each('data-i18n-title', (el, s) => el.setAttribute('title', s));
  each('data-i18n-aria', (el, s) => el.setAttribute('aria-label', s));
  each('data-i18n-placeholder', (el, s) => el.setAttribute('placeholder', s));
  const sel = document.getElementById('lang') as HTMLSelectElement | null;
  if (sel) {
    sel.value = lang;
    sel.onchange = () => isLang(sel.value) && setLang(sel.value);
  }
}
