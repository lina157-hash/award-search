// 地圖樣式 (兌換地圖 and 區域探索's map, round 6 extra X4): a small select in the map's corner picks the background,
// remembered on this device ('rmapStyle'). All free, no key: OpenStreetMap's standard tiles (the default), the
// Humanitarian style hosted by OpenStreetMap France, OpenTopoMap, and the standard tiles grey or sepia (a CSS filter).
// Stadia Maps' styles are offered only when the site says so (/api/config mapStadia, env MAP_STADIA=1): their free
// non-commercial plan checks the site's domain, registered in Stadia's dashboard, so no key is in the code.
// Terms and credits as the providers state them (read 2026-10-16): wiki.openstreetmap.org/wiki/Raster_tile_providers,
// openstreetmap.fr/usage (credit visible in a corner, public non-profit site, moderate traffic),
// wiki.openstreetmap.org/wiki/OpenTopoMap (CC-BY-SA, always name opentopomap.org, zoom to 17), docs.stadiamaps.com
// (map-styles/*, attribution). features.js addBaseMap asks mapStyleBases(map) which tiles to try, in order; when
// they all fail it still draws the plain Natural Earth outline. Classic script after features.js; the tests load the
// style list with require().

// ---------- the styles ----------
const MS_OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 貢獻者';
const MS_OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MS_STADIA = '&copy; <a href="https://stadiamaps.com/attribution/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const MS_STAMEN = '&copy; <a href="https://stamen.com/">Stamen Design</a>';
// `cls` (one class on the map box) carries the CSS filter, the dark theme's included (styles.css).
const MAP_STYLES = [
  { id: 'osm', name: '標準', url: MS_OSM_URL, cls: 'map-osm', attribution: MS_OSM },
  { id: 'hot', name: '柔和', url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', subdomains: 'abc', cls: 'map-hot',
    attribution: `${MS_OSM}，Tiles style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a> hosted by <a href="https://openstreetmap.fr/">OpenStreetMap France</a>` },
  { id: 'topo', name: '地形', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 17, cls: 'map-topo',
    attribution: `地圖資料 ${MS_OSM}、SRTM｜地圖樣式 &copy; <a href="https://opentopomap.org">OpenTopoMap</a>（<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>）` },
  { id: 'gray', name: '灰階', url: MS_OSM_URL, cls: 'map-gray', attribution: MS_OSM },
  { id: 'retro', name: '復古', url: MS_OSM_URL, cls: 'map-retro', attribution: MS_OSM },
  { id: 'smooth', name: '簡潔（Stadia）', stadia: true, url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png', cls: 'map-st-light', attribution: MS_STADIA },
  { id: 'smoothdark', name: '簡潔深色（Stadia）', stadia: true, url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', cls: 'map-st-dark', attribution: MS_STADIA },
  { id: 'watercolor', name: '水彩（Stadia）', stadia: true, url: 'https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg', maxZoom: 16, cls: 'map-st-light',
    attribution: `&copy; <a href="https://stadiamaps.com/attribution/">Stadia Maps</a> ${MS_STAMEN} &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>` },
  { id: 'toner', name: '黑白（Stadia）', stadia: true, url: 'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}{r}.png', cls: 'map-st-toner', attribution: `${MS_STADIA} ${MS_STAMEN}` },
];
// What the select offers: the free styles, and Stadia's when the site has them.
const mapStylesFor = (stadia) => MAP_STYLES.filter((s) => !s.stadia || stadia);
// The tiles to try for a saved id, in order: that style, then OpenStreetMap's standard tiles unless it already is
// them (灰階 and 復古 are the same tiles). An unknown id, or a Stadia one the site no longer offers, is 標準.
function mapStyleChainFor(id, stadia) {
  const s = mapStylesFor(stadia).find((x) => x.id === id) || MAP_STYLES[0];
  return s.url === MS_OSM_URL ? [s] : [s, MAP_STYLES[0]];
}

// ---------- the page ----------
const MS_KEY = 'rmapStyle';
// `stadia`: null until /api/config has said (a saved Stadia style is tried meanwhile; its tiles fail over by themselves).
const ms = { stadia: null, maps: new Set(), config: null };
const msSaved = () => { try { return localStorage.getItem(MS_KEY) || 'osm'; } catch { return 'osm'; } };
function msSave(id) { try { localStorage.setItem(MS_KEY, id); } catch { /* private mode: this visit only */ } }
const msOptions = () => mapStylesFor(ms.stadia ?? MAP_STYLES.find((s) => s.id === msSaved())?.stadia)
  .map((s) => `<option value="${s.id}" ${s.id === msSaved() ? 'selected' : ''}>${s.name}</option>`).join('');
// Asked once per page, the first time a map draws.
function msConfig() {
  ms.config ||= api('/api/config').then((c) => {
    const was = ms.stadia;
    ms.stadia = Boolean(c.mapStadia);
    for (const sel of document.querySelectorAll('.ms-ctl select')) sel.innerHTML = msOptions();
    // A Stadia style saved earlier, and the site no longer has Stadia: back to 標準 on the maps drawn with it.
    if (!ms.stadia && was !== false && MAP_STYLES.find((s) => s.id === msSaved())?.stadia) mapStyleSet('osm');
  }).catch(() => { ms.config = null; });
}
// The select in the map's top-right corner (Leaflet control), added the first time the map asks for its tiles.
function msControl(map) {
  if (map.msCtl) return;
  const L = window.L;
  const ctl = L.control({ position: 'topright' });
  ctl.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar ms-ctl');
    div.innerHTML = `<label><span>地圖樣式</span><select aria-label="地圖樣式">${msOptions()}</select></label>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    div.querySelector('select').addEventListener('change', (e) => mapStyleSet(e.target.value));
    return div;
  };
  ctl.addTo(map);
  map.msCtl = ctl;
  ms.maps.add(map);
  map.on('unload', () => ms.maps.delete(map));
  msConfig();
}
// For features.js addBaseMap: the tiles to try on this map, the select put in its corner on the way.
function mapStyleBases(map) {
  if (map && window.L) msControl(map);
  return mapStyleChainFor(msSaved(), ms.stadia ?? true);
}
const MS_CLASSES = ['map-plain', ...new Set(MAP_STYLES.map((s) => s.cls))];
// Another style picked: every map on the page drops its background (tiles, or the plain outline) and draws the new one.
function mapStyleSet(id) {
  msSave(id);
  const L = window.L;
  for (const map of ms.maps) {
    if (!map.getContainer().isConnected) { ms.maps.delete(map); continue; }
    map.eachLayer((l) => { if (l instanceof L.TileLayer || l.options?.style?.className === 'map-land') map.removeLayer(l); });
    map.attributionControl?.removeAttribution('Natural Earth');
    map.getContainer().classList.remove(...MS_CLASSES);
    addBaseMap(map);
  }
  for (const sel of document.querySelectorAll('.ms-ctl select')) sel.value = msSaved();
}

if (typeof module === 'object' && module.exports) module.exports = { MAP_STYLES, mapStylesFor, mapStyleChainFor, MS_OSM_URL };
