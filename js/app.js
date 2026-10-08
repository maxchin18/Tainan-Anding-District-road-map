/* =========================================================
   臺南市安定區公眾通行道路圖資系統
   ========================================================= */
(() => {
'use strict';

const C = window.APP_CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtLen = m => m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)}<small> km</small>` : `${Math.round(m)}<small> m</small>`;
const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };
const fmtLenTxt = m => m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無痕模式 */ } }
};

proj4.defs('EPSG:3826', '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
const toTWD97 = (lat, lng) => proj4('EPSG:4326', 'EPSG:3826', [lng, lat]);
const fromTWD97 = (x, y) => { const [lng, lat] = proj4('EPSG:3826', 'EPSG:4326', [x, y]); return [lat, lng]; };

const S = {
  roads: [], villages: null, boundary: null,
  roadLayer: null, haloLayer: null, villageLayer: null,
  activeCls: new Set(Object.keys(C.roadClasses)),
  village: '', query: '', sort: 'len', shown: 40,
  selected: null, mode: null,
  report: { photos: [], latlng: null, type: '', step: 1 },
};

/* ---------------- 地圖 ---------------- */
const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 11, maxZoom: 19 })
  .setView(C.center, C.zoom);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
const canvas = L.canvas({ padding: .3, tolerance: 6 });

const NLSC = id => `https://wmts.nlsc.gov.tw/wmts/${id}/default/GoogleMapsCompatible/{z}/{y}/{x}`;
const BASES = {
  emap:  { name: '通用版電子地圖', icon: '🗺️', layer: L.tileLayer(NLSC('EMAP'), { maxZoom: 19, maxNativeZoom: 18, className: 'tile-warm', attribution: '© 國土測繪中心' }) },
  gray:  { name: '淺灰簡圖', icon: '🧾', layer: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, className: 'tile-warm', attribution: 'Tiles © Esri' }) },
  photo: { name: '正射影像', icon: '🛰️', layer: L.tileLayer(NLSC('PHOTO2'), { maxZoom: 19, maxNativeZoom: 19, attribution: '© 國土測繪中心' }) },
};
const OVERLAYS = {
  land: { name: '地籍圖（公開地籍）', layer: L.tileLayer(NLSC('LAND_OPENDATA'), { maxZoom: 19, maxNativeZoom: 19, opacity: .85, minZoom: 16, attribution: '地籍：國土測繪中心' }) },
  sect: { name: '地段界', layer: L.tileLayer(NLSC('LANDSECT'), { maxZoom: 19, maxNativeZoom: 19, opacity: .8, minZoom: 13 }) },
  villages: { name: '里界與里名', layer: null },
};
let baseKey = store.get('ad.base', 'emap');
if (!BASES[baseKey]) baseKey = 'emap';
BASES[baseKey].layer.addTo(map);

function buildBaseMenu() {
  const m = $('#baseMenu');
  m.innerHTML = '<h3>底圖</h3>' + Object.entries(BASES).map(([k, b]) =>
    `<button role="menuitemradio" data-base="${k}" class="${k === baseKey ? 'on' : ''}">${b.icon} ${b.name}</button>`).join('') +
    '<h3>疊加圖層</h3>' + Object.entries(OVERLAYS).map(([k, o]) =>
    `<label><input type="checkbox" data-ov="${k}" ${o.layer && map.hasLayer(o.layer) ? 'checked' : ''}> ${o.name}</label>`).join('');
  $$('[data-base]', m).forEach(b => b.onclick = () => {
    map.removeLayer(BASES[baseKey].layer);
    baseKey = b.dataset.base; store.set('ad.base', baseKey);
    BASES[baseKey].layer.addTo(map).bringToBack();
    buildBaseMenu();
    if (baseKey === 'photo') toast('提示：正射影像下農路較難辨識，可放大檢視');
  });
  $$('[data-ov]', m).forEach(cb => cb.onchange = () => {
    const o = OVERLAYS[cb.dataset.ov];
    if (!o.layer) return;
    cb.checked ? o.layer.addTo(map) : map.removeLayer(o.layer);
    if (cb.dataset.ov === 'land' && cb.checked && map.getZoom() < 16) toast('地籍圖需放大至街道層級才會顯示');
  });
}
$('#fabBase').onclick = e => { e.stopPropagation(); const m = $('#baseMenu'); m.hidden = !m.hidden; if (!m.hidden) buildBaseMenu(); };
document.addEventListener('click', e => { if (!e.target.closest('#baseMenu')) $('#baseMenu').hidden = true; });

/* ---------------- 共用 UI ---------------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const isMobile = () => matchMedia('(max-width: 820px)').matches;

function setSheet(state) {
  const p = $('#panel');
  p.classList.remove('sheet-peek', 'sheet-half', 'sheet-full');
  p.classList.add('sheet-' + state);
}
function openTab(name, { expand = true } = {}) {
  $$('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  $('.panel-body').scrollTop = 0;
  if (isMobile() && expand && $('#panel').classList.contains('sheet-peek')) setSheet('half');
  if (name === 'report') mapPickOn(S.report.step === 2);
  history.replaceState(null, '', S.selected ? `#road=${S.selected.properties.id}` : `#${name}`);
}
$$('.tabs [role=tab]').forEach(b => b.onclick = () => openTab(b.dataset.tab));

/* 行動版抽屜拖曳 */
(() => {
  const h = $('#sheetHandle'), p = $('#panel');
  let y0 = null, moved = false;
  const order = ['peek', 'half', 'full'];
  const cur = () => order.find(s => p.classList.contains('sheet-' + s)) || 'half';
  h.addEventListener('pointerdown', e => { y0 = e.clientY; moved = false; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (y0 != null && Math.abs(e.clientY - y0) > 8) moved = true; });
  h.addEventListener('pointerup', e => {
    if (y0 == null) return;
    const dy = e.clientY - y0, i = order.indexOf(cur());
    if (!moved) setSheet(order[(i + 1) % 3]);
    else if (dy < -30) setSheet(order[Math.min(2, i + 1)]);
    else if (dy > 30) setSheet(order[Math.max(0, i - 1)]);
    y0 = null;
  });
  h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(order[(order.indexOf(cur()) + 1) % 3]); } });
  map.on('dragstart', () => { if (isMobile() && !p.classList.contains('sheet-peek')) setSheet('peek'); });
})();

/* ---------------- 幾何工具 ---------------- */
function segDistM(p, a, b) {
  // p,a,b = [lng,lat]；以局部平面近似計算點到線段距離（公尺）
  const k = Math.cos(p[1] * Math.PI / 180) * 111320, ky = 110574;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
const linesOf = g => g.type === 'LineString' ? [g.coordinates] : g.coordinates;
function distToRoad(lnglat, f) {
  const [x0, y0, x1, y1] = f.properties.bbox, pad = .01;
  if (lnglat[0] < x0 - pad || lnglat[0] > x1 + pad || lnglat[1] < y0 - pad || lnglat[1] > y1 + pad) return Infinity;
  let d = Infinity;
  for (const l of linesOf(f.geometry)) for (let i = 0; i < l.length - 1; i++) d = Math.min(d, segDistM(lnglat, l[i], l[i + 1]));
  return d;
}
function nearestRoads(latlng, radius = 60, n = 5) {
  const p = [latlng.lng, latlng.lat];
  return S.roads.map(f => ({ f, d: distToRoad(p, f) })).filter(o => o.d <= radius).sort((a, b) => a.d - b.d).slice(0, n);
}
function villageAt(latlng) {
  if (!S.villages) return '';
  const pt = [latlng.lng, latlng.lat];
  const inRing = r => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
  for (const f of S.villages.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (polys.some(p => inRing(p[0]))) return f.properties.name;
  }
  return '';
}

/* ---------------- 資料載入 ---------------- */
const getJSON = url => fetch(url, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(url); return r.json(); });

Promise.all([getJSON('data/boundary.geojson'), getJSON('data/villages.geojson'), getJSON('data/roads.geojson')])
  .then(([b, v, r]) => {
    S.boundary = b; S.villages = v; S.roads = r.features;
    drawBoundary(); drawVillages(); drawRoads();
    buildFilters(); renderStats(); renderList(); renderVillageStats(); renderLegend();
    if (!location.hash.startsWith('#case=')) routeFromHash();
  })
  .catch(err => { console.error(err); toast('圖資載入失敗，請重新整理'); });

function drawBoundary() {
  // 區外遮罩：讓安定區範圍在視覺上「浮」起來
  const outer = [[-90, -180], [-90, 180], [90, 180], [90, -180]];
  const ring = S.boundary.features[0].geometry.coordinates[0].map(([x, y]) => [y, x]);
  L.polygon([outer, ring], { stroke: false, fillColor: '#FBF6EC', fillOpacity: .55, interactive: false, renderer: canvas }).addTo(map);
  L.polygon(ring, { color: '#1B2A4A', weight: 6, opacity: .15, fill: false, interactive: false, renderer: canvas }).addTo(map);
  L.polygon(ring, { color: '#E3001B', weight: 2.5, dashArray: '10 6', fill: false, interactive: false, renderer: canvas }).addTo(map);
  S.homeBounds = L.latLngBounds(ring);
}

function drawVillages() {
  S.villageLayer = L.geoJSON(S.villages, {
    renderer: canvas,
    style: () => ({ color: '#1C5FC4', weight: 1.2, opacity: .55, dashArray: '3 5', fillColor: '#1C5FC4', fillOpacity: 0 }),
    onEachFeature: (f, l) => {
      l.bindTooltip(f.properties.name, { permanent: true, direction: 'center', className: 'vlabel' });
      l.on('click', e => { if (!S.mode) { L.DomEvent.stop(e); pickVillage(f.properties.name); } });
    },
  }).addTo(map);
  OVERLAYS.villages.layer = S.villageLayer;
  const sync = () => {
    const z = map.getZoom();
    S.villageLayer.eachLayer(l => { const t = l.getTooltip(); if (t) t.getElement() && (t.getElement().style.display = z >= 13 && z <= 16 ? '' : 'none'); });
  };
  map.on('zoomend', sync); setTimeout(sync, 0);
}

const zoomK = () => { const z = map.getZoom(); return z <= 12 ? .45 : z === 13 ? .65 : z === 14 ? .85 : z >= 17 ? 1.3 : 1; };
function roadStyle(f) {
  const c = C.roadClasses[f.properties.cls];
  const dim = S.selected && S.selected !== f;
  return { color: c.color, weight: c.weight * zoomK(), opacity: S.activeCls.has(f.properties.cls) ? (dim ? .3 : .95) : 0, lineCap: 'round', lineJoin: 'round' };
}
function drawRoads() {
  // 白色外框，做出插畫風「描邊道路」效果
  S.casing = L.geoJSON({ type: 'FeatureCollection', features: S.roads.filter(f => f.properties.cls !== 'lane') }, {
    renderer: canvas, interactive: false,
    style: f => ({ color: '#fff', weight: C.roadClasses[f.properties.cls].weight * zoomK() + 3 * zoomK(), opacity: S.activeCls.has(f.properties.cls) ? .9 : 0, lineCap: 'round' }),
  }).addTo(map);
  S.roadLayer = L.geoJSON({ type: 'FeatureCollection', features: S.roads }, {
    renderer: canvas, style: roadStyle,
    onEachFeature: (f, l) => {
      f._layer = l;
      l.bindTooltip(() => `${esc(f.properties.name)}・${fmtLenTxt(f.properties.length_m)}`, { sticky: true, className: 'road-tip', direction: 'top', offset: [0, -6] });
      l.on('click', e => { if (S.mode) return; L.DomEvent.stop(e); selectRoad(f, { fit: false }); });
      l.on('mouseover', () => { if (S.activeCls.has(f.properties.cls)) l.setStyle({ weight: C.roadClasses[f.properties.cls].weight * zoomK() + 3, opacity: 1 }); });
      l.on('mouseout', () => l.setStyle(roadStyle(f)));
    },
  }).addTo(map);
}
function restyleRoads() {
  S.roadLayer.setStyle(roadStyle);
  S.casing.setStyle(f => ({ weight: C.roadClasses[f.properties.cls].weight * zoomK() + 3 * zoomK(), opacity: S.activeCls.has(f.properties.cls) ? .9 : 0 }));
}
map.on('zoomend', () => S.roadLayer && restyleRoads());

/* ---------------- 道路篩選與清單 ---------------- */
function buildFilters() {
  const counts = {};
  S.roads.forEach(f => counts[f.properties.cls] = (counts[f.properties.cls] || 0) + 1);
  $('#clsChips').innerHTML = Object.entries(C.roadClasses).map(([k, c]) =>
    `<button class="chip" data-cls="${k}" aria-pressed="true"><i class="sw" style="background:${c.color}"></i>${c.name}<small>${counts[k] || 0}</small></button>`).join('');
  $$('#clsChips .chip').forEach(b => b.onclick = () => {
    const k = b.dataset.cls, on = !S.activeCls.has(k);
    on ? S.activeCls.add(k) : S.activeCls.delete(k);
    b.setAttribute('aria-pressed', String(on));
    restyleRoads(); S.shown = 40; renderList(); renderLegend();
  });
  $('#villageFilter').innerHTML = `<option value="">全部 ${S.villages.features.length} 里</option>` +
    S.villages.features.map(f => `<option>${esc(f.properties.name)}</option>`).join('');
  $('#villageFilter').onchange = e => pickVillage(e.target.value, { fromSelect: true });
  let t;
  $('#roadSearch').oninput = e => { clearTimeout(t); t = setTimeout(() => { S.query = e.target.value.trim(); S.shown = 40; renderList(); }, 120); };
  $('#sortBtn').onclick = () => {
    S.sort = S.sort === 'len' ? 'name' : 'len';
    $('#sortBtn').textContent = S.sort === 'len' ? '依長度排序' : '依名稱排序';
    renderList();
  };
  $('#moreRoads').onclick = () => { S.shown += 60; renderList(); };
}

function pickVillage(name, { fromSelect = false } = {}) {
  S.village = name; S.shown = 40;
  if (!fromSelect) $('#villageFilter').value = name;
  S.villageLayer.setStyle(f => ({ fillOpacity: name && f.properties.name === name ? .12 : 0, weight: name && f.properties.name === name ? 3 : 1.2, dashArray: name && f.properties.name === name ? null : '3 5', opacity: name && f.properties.name === name ? .9 : .55 }));
  if (name) {
    const f = S.villages.features.find(v => v.properties.name === name);
    const [x0, y0, x1, y1] = f.properties.bbox;
    map.flyToBounds([[y0, x0], [y1, x1]], { padding: [30, 30], duration: .6 });
    openTab('roads');
  }
  renderList();
}

function matchRoad(p, q) {
  if (!q) return true;
  const hay = `${p.name} ${p.ref} ${p.id} ${p.villages.join(' ')} ${p.clsName}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
function hl(text, q) {
  let s = esc(text);
  if (!q) return s;
  q.split(/\s+/).filter(Boolean).forEach(w => { s = s.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`); });
  return s;
}

function filteredRoads() {
  const list = S.roads.filter(f => {
    const p = f.properties;
    return S.activeCls.has(p.cls) && (!S.village || p.villages.includes(S.village)) && matchRoad(p, S.query);
  });
  const ord = { main: 0, dist: 1, local: 2, farm: 3, lane: 4 };
  list.sort(S.sort === 'len'
    ? (a, b) => (b.properties.named - a.properties.named) || (ord[a.properties.cls] - ord[b.properties.cls]) || (b.properties.length_m - a.properties.length_m)
    : (a, b) => a.properties.name.localeCompare(b.properties.name, 'zh-Hant'));
  return list;
}

function renderList() {
  const list = filteredRoads();
  const total = list.reduce((s, f) => s + f.properties.length_m, 0);
  $('#roadCount').textContent = `${S.village || '全區'}・${list.length} 條・${fmtLenTxt(total)}`;
  const ul = $('#roadList');
  if (!list.length) { ul.innerHTML = '<li class="empty">找不到符合的道路<br><small>試試其他關鍵字或開啟更多道路等級</small></li>'; $('#moreRoads').hidden = true; return; }
  ul.innerHTML = list.slice(0, S.shown).map(f => {
    const p = f.properties, c = C.roadClasses[p.cls];
    return `<li class="road-item ${S.selected === f ? 'sel' : ''}" tabindex="0" data-id="${p.id}">
      <i class="bar" style="background:${c.color}"></i>
      <div><div class="nm">${hl(p.name, S.query)}</div><div class="meta">${esc(p.clsName)}・${esc(p.villages.slice(0, 2).join('、') || '—')}${p.villages.length > 2 ? ' 等' : ''}・${hl(p.id, S.query)}</div></div>
      <div class="len">${fmtLen(p.length_m)}</div></li>`;
  }).join('');
  $('#moreRoads').hidden = list.length <= S.shown;
  $('#moreRoads').textContent = `顯示更多（尚有 ${list.length - S.shown} 條）`;
  $$('.road-item', ul).forEach(li => {
    const go = () => selectRoad(S.roads.find(f => f.properties.id === li.dataset.id));
    li.onclick = go;
    li.onkeydown = e => { if (e.key === 'Enter') go(); };
    li.onmouseenter = () => { const f = S.roads.find(r => r.properties.id === li.dataset.id); flashHalo(f); };
    li.onmouseleave = () => { if (!S.selected) clearHalo(); else flashHalo(S.selected); };
  });
}

function renderStats() {
  const sum = cls => S.roads.filter(f => cls.includes(f.properties.cls)).reduce((s, f) => s + f.properties.length_m, 0);
  const farm = S.roads.filter(f => f.properties.cls === 'farm');
  $('#statRow').innerHTML = `
    <div class="stat s1"><b>${(sum(['farm']) / 1000).toFixed(0)}</b><span>農路 km・${farm.length} 條</span></div>
    <div class="stat s2"><b>${(sum(['main', 'dist', 'local']) / 1000).toFixed(0)}</b><span>省市區道 km</span></div>
    <div class="stat s3"><b>${S.villages.features.length}</b><span>里</span></div>`;
}

function renderLegend() {
  const lg = $('#legend');
  lg.innerHTML = '<div class="lg lg-title">道路等級 ▾</div>' + Object.entries(C.roadClasses).filter(([k]) => S.activeCls.has(k)).map(([k, c]) =>
    `<div class="lg"><i class="sw" style="height:${Math.max(3, c.weight)}px;background:${c.color}"></i>${c.name}</div>`).join('') +
    '<div class="lg"><i class="sw" style="height:0;border-top:2.5px dashed #E3001B"></i>安定區界</div>';
  $('.lg-title', lg).onclick = () => lg.classList.toggle('collapsed');
  if (isMobile() && !lg.dataset.init) { lg.classList.add('collapsed'); lg.dataset.init = 1; }
}

/* ---------------- 道路選取與資訊卡 ---------------- */
function flashHalo(f) {
  clearHalo();
  if (!f) return;
  S.haloLayer = L.geoJSON(f, { renderer: canvas, interactive: false, style: { color: '#1B2A4A', weight: C.roadClasses[f.properties.cls].weight + 10, opacity: .4, lineCap: 'round' } }).addTo(map);
  f._layer.bringToFront();
}
function clearHalo() { if (S.haloLayer) { map.removeLayer(S.haloLayer); S.haloLayer = null; } }

function selectRoad(f, { fit = true } = {}) {
  if (!f) return;
  S.selected = f;
  S.roadLayer.setStyle(roadStyle);
  if (!S.activeCls.has(f.properties.cls)) { S.activeCls.add(f.properties.cls); $(`#clsChips [data-cls=${f.properties.cls}]`).setAttribute('aria-pressed', 'true'); restyleRoads(); renderLegend(); }
  flashHalo(f);
  if (fit) {
    const [x0, y0, x1, y1] = f.properties.bbox;
    const pad = isMobile() ? { paddingTopLeft: [20, 60], paddingBottomRight: [20, innerHeight * .5] } : { paddingTopLeft: [360, 40], paddingBottomRight: [70, 40] };
    map.flyToBounds([[y0, x0], [y1, x1]], { ...pad, maxZoom: 17, duration: .7 });
  }
  showInfo(f);
  $$('.road-item').forEach(li => li.classList.toggle('sel', li.dataset.id === f.properties.id));
  history.replaceState(null, '', `#road=${f.properties.id}`);
  if (isMobile()) setSheet('peek');
}

function showInfo(f) {
  const p = f.properties, c = C.roadClasses[p.cls];
  const [x0, y0, x1, y1] = p.bbox, mid = [(y0 + y1) / 2, (x0 + x1) / 2];
  const twd = toTWD97(mid[0], mid[1]);
  const card = $('#infoCard');
  card.innerHTML = `
    <div class="info-head" style="background:${c.color}">
      <span class="cls">${esc(p.clsName)}</span>
      <h3>${esc(p.name)}</h3>
      <button class="info-close" aria-label="關閉">✕</button>
    </div>
    <div class="info-body">
      <div class="kv">
        <div><b>${fmtLenTxt(p.length_m)}</b><span>總長度</span></div>
        <div><b>${p.segments}</b><span>路段數</span></div>
        <div><b>${esc(p.surface || '—')}</b><span>鋪面</span></div>
      </div>
      <p><b>編號</b> ${esc(p.id)}${p.ref ? `　<b>路線</b> ${esc(p.ref)}` : ''}</p>
      <p><b>行經</b> ${esc(p.villages.join('、') || '—')}</p>
      <p class="small muted" style="margin:2px 0">中心 TWD97 ${twd[0].toFixed(0)}, ${twd[1].toFixed(0)}${p.named ? '' : '｜未命名道路，暫以里別編號'}</p>
      <div class="btn-row">
        <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${mid[0].toFixed(6)},${mid[1].toFixed(6)}" target="_blank" rel="noopener">🧭 導航</a>
        <button class="btn" data-act="share">🔗 分享</button>
        <button class="btn danger" data-act="report">📣 通報</button>
      </div>
    </div>`;
  card.hidden = false;
  $('.info-close', card).onclick = closeInfo;
  $('[data-act=share]', card).onclick = () => {
    const url = `${location.origin}${location.pathname}#road=${p.id}`;
    if (navigator.share) navigator.share({ title: p.name, text: `${C.district} ${p.name}`, url }).catch(() => {});
    else navigator.clipboard?.writeText(url).then(() => toast('已複製連結'), () => prompt('複製連結', url));
  };
  $('[data-act=report]', card).onclick = () => {
    const l = linesOf(f.geometry)[0], m = l[Math.floor(l.length / 2)];
    startReport(L.latLng(m[1], m[0]), p.name);
  };
}
function closeInfo() {
  $('#infoCard').hidden = true; S.selected = null; clearHalo(); S.roadLayer.setStyle(roadStyle);
  $$('.road-item.sel').forEach(li => li.classList.remove('sel'));
  history.replaceState(null, '', location.pathname);
}

/* ---------------- 里別統計 ---------------- */
function renderVillageStats() {
  const rows = S.villages.features.map(f => ({ name: f.properties.name, m: f.properties.road_m, total: Object.values(f.properties.road_m).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const max = Math.max(...rows.map(r => r.total));
  $('#villageStats').innerHTML = '<p class="muted small" style="margin:0">各里道路長度（km），點選可定位該里</p>' + rows.map(r =>
    `<div class="bar-row" data-v="${esc(r.name)}"><b>${esc(r.name)}</b><div class="bar-track" style="width:${(r.total / max * 100).toFixed(1)}%">${
      Object.entries(C.roadClasses).map(([k, c]) => `<i style="width:${(r.m[k] / r.total * 100).toFixed(1)}%;background:${c.color}" title="${c.name} ${(r.m[k] / 1000).toFixed(1)} km"></i>`).join('')
    }</div><span class="num">${(r.total / 1000).toFixed(1)}</span></div>`).join('');
  $$('#villageStats .bar-row').forEach(r => r.onclick = () => pickVillage(r.dataset.v));
}

/* ---------------- 施工／維修案件 ---------------- */
const caseLayers = {};
const caseData = {};
function freshColor(dateStr) {
  // 近期 → 深藍，久遠 → 紅
  const d = Date.parse(dateStr);
  if (isNaN(d)) return '#8C96A8';
  const age = Math.min(1, Math.max(0, (Date.now() - d) / (3 * 365 * 864e5)));
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  const [c1, c2] = age < .5 ? [[28, 95, 196], [143, 184, 234]] : [[143, 184, 234], [227, 0, 27]];
  const t = age < .5 ? age * 2 : (age - .5) * 2;
  return `rgb(${lerp(c1[0], c2[0], t)},${lerp(c1[1], c2[1], t)},${lerp(c1[2], c2[2], t)})`;
}
getJSON('data/cases/index.json').then(idx => {
  const box = $('#caseGroups');
  if (!idx.groups?.length) {
    box.innerHTML = '<p class="muted">目前尚無公開案件資料。<br><small>公所可依 <code>data/cases/README.md</code> 格式上傳 GeoJSON 後自動顯示。</small></p>';
    return;
  }
  box.innerHTML = '<div class="fresh-scale">近<i></i>遠</div>' + idx.groups.map(g => `
    <div class="case-year"><div>${esc(g.year)} 年度 <button class="link-btn" data-all="${esc(g.year)}">全選</button></div>
    ${g.items.map(it => `<label><input type="checkbox" data-file="${esc(it.file)}"> ${esc(it.label)}<span class="count" data-count="${esc(it.file)}"></span></label>`).join('')}</div>`).join('');
  $$('[data-file]', box).forEach(cb => cb.onchange = () => toggleCase(cb.dataset.file, cb.checked));
  $$('[data-all]', box).forEach(b => b.onclick = () => $$('input', b.closest('.case-year')).forEach(cb => { if (!cb.checked) { cb.checked = true; toggleCase(cb.dataset.file, true); } }));
}).catch(() => { $('#caseGroups').innerHTML = '<p class="muted">案件資料載入失敗。</p>'; });

async function toggleCase(file, on) {
  if (!on) { if (caseLayers[file]) map.removeLayer(caseLayers[file]); return; }
  if (!caseData[file]) {
    try { caseData[file] = await getJSON('data/cases/' + file); } catch { toast('案件檔讀取失敗：' + file); return; }
  }
  const gj = caseData[file];
  $(`[data-count="${CSS.escape(file)}"]`).textContent = `${gj.features.length} 件`;
  caseLayers[file] = L.geoJSON(gj, {
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 9, color: '#1B2A4A', weight: 2.5, fillColor: freshColor(f.properties.finishDate || f.properties.dispatchDate), fillOpacity: 1, renderer: canvas }),
    onEachFeature: (f, l) => {
      const p = f.properties;
      l.bindPopup(`<h4>${esc(p.title || p.road || '維修案件')}</h4>
        ${p.type ? `<b>類別</b> ${esc(p.type)}<br>` : ''}${p.village ? `<b>里別</b> ${esc(p.village)}<br>` : ''}
        ${p.dispatchDate ? `<b>派工</b> ${esc(p.dispatchDate)}<br>` : ''}${p.finishDate ? `<b>完工</b> ${esc(p.finishDate)}<br>` : ''}
        ${p.vendor ? `<b>廠商</b> ${esc(p.vendor)}<br>` : ''}${p.amount ? `<b>金額</b> ${Number(p.amount).toLocaleString()} 元<br>` : ''}
        ${p.note ? `<span class="muted">${esc(p.note)}</span>` : ''}`);
    },
  }).addTo(map);
  if (gj.features.length) map.flyToBounds(caseLayers[file].getBounds(), { padding: [40, 40], maxZoom: 16 });
}
$('#caseClear').onclick = () => { Object.values(caseLayers).forEach(l => map.removeLayer(l)); $$('#caseGroups input').forEach(cb => cb.checked = false); };
$('#caseCsv').onclick = () => {
  const rows = [['檔案', '標題', '類別', '里別', '派工日期', '完工日期', '廠商', '金額', 'WGS84經度', 'WGS84緯度']];
  Object.entries(caseData).forEach(([file, gj]) => gj.features.forEach(f => { const p = f.properties, [x, y] = f.geometry.coordinates; rows.push([file, p.title, p.type, p.village, p.dispatchDate, p.finishDate, p.vendor, p.amount, x, y]); }));
  if (rows.length === 1) return toast('請先勾選要下載的案件');
  downloadCSV(rows, '安定區維修案件.csv');
};

/* 民眾通報看板（需設定後端） */
let liveLayer = null, liveItems = [];
$('#liveHint').textContent = C.reportEndpoint ? '資料來源：公所通報系統（個資不公開）。點選標記可看案件進度、施工前後照片與留言。' : '尚未連接公所通報後端；目前僅顯示您在本機暫存的通報。';
async function loadLive() {
  let items = store.get('ad.reports', []).filter(r => r.status === '本機暫存');
  if (C.reportEndpoint) {
    try { const r = await AD.apiGet({ action: 'list' }); items = (r.items || []).concat(items); }
    catch { toast('通報看板讀取失敗，僅顯示本機資料'); }
  }
  return (liveItems = items);
}
$('#liveToggle').onchange = async e => {
  if (liveLayer) { map.removeLayer(liveLayer); liveLayer = null; }
  if (!e.target.checked) return;
  const items = await loadLive();
  liveLayer = L.layerGroup(items.filter(i => i.lat && i.lng).map(i => L.marker([i.lat, i.lng], {
    icon: L.divIcon({ className: 'pin-icon', html: `<span style="background:${AD.statusColor(i.status)}"></span>`, iconSize: [24, 24] }),
  }).bindPopup(`<h4>${esc(i.type)}・${esc(i.status)}</h4>${esc(i.village || '')}${i.road ? `・${esc(i.road)}` : ''}<br><small>${esc(i.id)}・${esc(i.date || fmtTime(i.time))}</small>
    ${i.reply ? `<br><b>公所說明：</b>${esc(i.reply)}` : ''}${String(i.id).startsWith('AD') ? `<br><a href="#case=${esc(i.id)}">查看案件進度 →</a>` : ''}`))).addTo(map);
  toast(`顯示 ${items.length} 筆通報`);
};
$('#caseLookup').onkeydown = e => { if (e.key === 'Enter' && e.target.value.trim()) location.hash = 'case=' + e.target.value.trim().toUpperCase(); };
$('#openDataCsv').onclick = async () => {
  if (!C.reportEndpoint) return toast('尚未連接公所後端，暫無通報案件資料');
  try {
    const r = await AD.apiGet({ action: 'list' });
    AD.downloadCSV(AD.openDataRows((r.items || []).filter(i => i.status !== '不受理')), `安定區道路案件開放資料_${new Date().toLocaleDateString('sv-SE')}.csv`);
  } catch { toast('下載失敗，請稍後再試'); }
};

/* ---------------- 道路通報流程 ---------------- */
const R = S.report;
$('#issueChips').innerHTML = C.issueTypes.map(t => `<button type="button" class="chip choice" role="radio" aria-checked="false" data-type="${esc(t)}">${esc(t)}</button>`).join('');
$$('#issueChips .chip').forEach(b => b.onclick = () => {
  R.type = b.dataset.type;
  $$('#issueChips .chip').forEach(x => x.setAttribute('aria-checked', String(x === b)));
});

let captcha = null;
function gotoStep(n) {
  if (n === 3 && !R.latlng) return toast('請先選擇事發位置');
  if (n === 4 && !R.type) return toast('請選擇狀況類別');
  if (n === 4 && $('#email').value && !$('#email').checkValidity()) return toast('Email 格式不正確');
  R.step = n;
  $$('.step').forEach(s => s.hidden = +s.dataset.step !== n);
  $$('#stepper li').forEach((li, i) => { li.classList.toggle('on', i + 1 === n); li.classList.toggle('done', i + 1 < n); });
  mapPickOn(n === 2);
  if (n === 4) {
    renderReview();
    if (C.reportEndpoint) { if (!captcha) captcha = AD.captchaWidget($('#captchaBox')); else captcha.refresh(); }
  }
  $('.panel-body').scrollTop = 0;
}
$$('[data-next]').forEach(b => b.onclick = () => gotoStep(R.step + 1));
$$('[data-prev]').forEach(b => b.onclick = () => gotoStep(R.step - 1));

/* 照片：讀取 GPS 後，在裝置端執行 AI 去識別化，只保留處理後影像 */
$('#photoDrop').onclick = e => { if (e.target.tagName !== 'INPUT') { e.preventDefault(); $('#photoInput').click(); } };
$('#photoInput').onchange = async e => {
  for (const file of [...e.target.files].slice(0, 3 - R.photos.length)) {
    let gps = null;
    try { const g = await exifr.gps(file); if (g?.latitude) gps = L.latLng(g.latitude, g.longitude); } catch { /* 無 EXIF */ }
    const res = await Deid.open(file, { title: `照片去識別化（${R.photos.length + 1}/3）` }).catch(() => null);
    if (!res) continue;
    R.photos.push({ data: res.dataUrl, gps, summary: res.summary });
    if (gps && !R.latlng) setReportLoc(gps, '照片 GPS');
  }
  e.target.value = '';
  renderThumbs();
};
function renderThumbs() {
  $('#thumbs').innerHTML = R.photos.map((p, i) => `<figure><img src="${p.data}" alt="現場照片 ${i + 1}"><button type="button" data-rm="${i}" aria-label="移除">✕</button>
    <span class="gps">${p.gps ? 'GPS・' : ''}已去識別化</span></figure>`).join('');
  $$('[data-rm]').forEach(b => b.onclick = () => { R.photos.splice(+b.dataset.rm, 1); renderThumbs(); });
}

/* 語音／鍵盤雙軌輸入 */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  $('#micBtn').hidden = false; $('#micHint').hidden = false;
  let rec = null;
  $('#micBtn').onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'zh-TW'; rec.interimResults = true; rec.continuous = false;
    const ta = $('#issueDesc'), base = ta.value ? ta.value.replace(/\s*$/, '，') : '';
    rec.onresult = ev => { ta.value = (base + [...ev.results].map(r => r[0].transcript).join('')).slice(0, 500); };
    rec.onerror = ev => toast(ev.error === 'not-allowed' ? '請允許使用麥克風' : '語音辨識失敗，請改用鍵盤輸入');
    rec.onend = () => { rec = null; $('#micBtn').classList.remove('on'); };
    rec.start(); $('#micBtn').classList.add('on'); toast('請開始說話…');
  };
}

let reportMarker = null;
function setReportLoc(latlng, src) {
  R.latlng = latlng;
  R.village = villageAt(latlng);
  R.near = nearestRoads(latlng, 80, 1)[0]?.f.properties.name || '';
  if (!reportMarker) reportMarker = L.marker(latlng, { draggable: true, icon: L.divIcon({ className: 'pin-icon', html: '<span style="background:#E3001B;width:22px;height:22px"></span>', iconSize: [28, 28] }) })
    .on('dragend', e => setReportLoc(e.target.getLatLng(), '手動調整')).addTo(map);
  else reportMarker.setLatLng(latlng).addTo(map);
  const t = toTWD97(latlng.lat, latlng.lng);
  const box = $('#locBox');
  box.classList.add('ok');
  box.innerHTML = `✅ <b>${esc(R.village || '安定區外')}</b>${R.near ? `・近 <b>${esc(R.near)}</b>` : ''}<br><small>${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}｜TWD97 ${t[0].toFixed(0)}, ${t[1].toFixed(0)}｜來源：${esc(src)}（可拖曳紅點微調）</small>`;
  if (!R.village) toast('此位置不在安定區範圍內，請確認');
  checkDuplicates(latlng);
}

/* 時間及空間雙重演算法警示：3 年內、方圓 50 公尺內是否已有通報或維修 */
const DUP_M = 50, DUP_MS = 3 * 365.25 * 864e5;
let dupSeq = 0;
async function staticCasesNear(latlng) {
  const idx = await getJSON('data/cases/index.json').catch(() => ({ groups: [] }));
  const out = [];
  for (const g of idx.groups || []) for (const it of g.items) {
    if (!caseData[it.file]) caseData[it.file] = await getJSON('data/cases/' + it.file).catch(() => ({ features: [] }));
    caseData[it.file].features.forEach(f => {
      const p = f.properties, [x, y] = f.geometry.coordinates, d = map.distance(latlng, [y, x]);
      const when = Date.parse(p.finishDate || p.dispatchDate);
      if (d <= DUP_M && (isNaN(when) || Date.now() - when <= DUP_MS)) out.push({ id: p.title || it.label, date: p.finishDate || p.dispatchDate, status: '維修紀錄', type: p.type || it.label, dist: Math.round(d) });
    });
  }
  return out;
}
async function findNearby(latlng, exclude) {
  const [api, hist] = await Promise.all([
    C.reportEndpoint ? AD.apiGet({ action: 'nearby', lat: latlng.lat, lng: latlng.lng, exclude: exclude || '' }).then(r => r.items || []).catch(() => []) : [],
    staticCasesNear(latlng),
  ]);
  return api.concat(hist).sort((a, b) => a.dist - b.dist);
}
async function checkDuplicates(latlng) {
  const seq = ++dupSeq, box = $('#dupBox');
  const list = await findNearby(latlng);
  if (seq !== dupSeq) return;
  R.nearby = list;
  box.hidden = !list.length;
  if (!list.length) return;
  box.innerHTML = `<b>⚠️ 此位置 3 年內、方圓 50 公尺內已有 ${list.length} 件案件</b>
    <ul>${list.slice(0, 5).map(i => `<li>${String(i.id).startsWith('AD') ? `<a href="#case=${esc(i.id)}">${esc(i.id)}</a>` : esc(i.id)}｜${esc(i.type)}｜${esc(i.date)}｜${esc(i.status)}｜${i.dist} m</li>`).join('')}</ul>
    <small>若是同一個問題，可直接到該案件留言追蹤，避免重複通報；若是新的損壞，仍可繼續通報。</small>`;
}
function mapPickOn(on) {
  const reportVisible = $('#tab-report').classList.contains('active');
  on = on && reportVisible;
  if (on) setMode('pick', '點選地圖設定事發位置');
  else if (S.mode === 'pick') setMode(null);
}
$('#pickOnMap').onclick = () => { setMode('pick', '點選地圖設定事發位置'); if (isMobile()) setSheet('peek'); };
$('#useGps').onclick = () => locate(ll => { setReportLoc(ll, '裝置定位'); map.flyTo(ll, 17); });

function startReport(latlng, roadName) {
  openTab('report');
  $('#reportDone').hidden = true; $('#reportForm').hidden = false; $('#stepper').hidden = false;
  if (latlng) setReportLoc(latlng, roadName ? `道路「${roadName}」` : '地圖');
  gotoStep(latlng ? 3 : 1);
  if (isMobile()) setSheet('full');
}
$('#fabReport').onclick = () => startReport(null);

function renderReview() {
  $('#reviewBox').innerHTML = `<dl>
    <dt>類別</dt><dd>${esc(R.type)}</dd>
    <dt>位置</dt><dd>${esc(R.village)}${R.near ? `・${esc(R.near)}` : ''}<br><small>${R.latlng.lat.toFixed(6)}, ${R.latlng.lng.toFixed(6)}</small></dd>
    <dt>說明</dt><dd>${esc($('#issueDesc').value || '（未填）')}</dd>
    <dt>照片</dt><dd>${R.photos.length} 張（已去識別化）</dd>
    <dt>通知</dt><dd>${$('#email').value ? 'Email ' : ''}${C.lineOaId ? 'LINE（送出後綁定）' : ''}${!$('#email').value && !C.lineOaId ? '不通知' : ''}</dd>
    ${R.nearby?.length ? `<dt>提醒</dt><dd style="color:#B45309">附近已有 ${R.nearby.length} 件案件</dd>` : ''}</dl>`;
  $('#submitNote').textContent = C.reportEndpoint ? '送出後系統自動立案並給號，處理進度會以 Email／LINE 通知，也可在案件頁查詢。' : '目前尚未連接公所後端：送出後會暫存於本機，並可下載通報單轉交公所。';
}

$('#reportForm').onsubmit = async e => {
  e.preventDefault();
  if ($('#hp').value) return; // 機器人陷阱
  const rec = {
    id: 'R' + Date.now().toString(36).toUpperCase(),
    time: new Date().toISOString(), type: R.type, desc: $('#issueDesc').value.trim(),
    lat: +R.latlng.lat.toFixed(6), lng: +R.latlng.lng.toFixed(6), village: R.village, road: R.near,
  };
  const btn = $('#submitReport');
  if (C.reportEndpoint) {
    const cap = captcha.get();
    if (!/^\d{4}$/.test(cap.answer)) return toast('請輸入驗證碼（4 個數字）');
    btn.disabled = true; btn.textContent = '送出中…';
    try {
      const j = await AD.apiPost('report', { ...rec, contact: $('#contact').value.trim(), email: $('#email').value.trim(), photos: R.photos.map(p => p.data), ...cap });
      if (!j.ok) { toast(j.error || '送出失敗'); captcha.refresh(); return; }
      const mine = store.get('ad.reports', []);
      mine.unshift({ ...rec, id: j.id, key: j.key, status: '已立案' });
      store.set('ad.reports', mine.slice(0, 30));
      showDone(j);
      resetReport(); renderMyReports();
    } catch (err) {
      console.error(err);
      toast('網路異常，已暫存於本機並開啟通報單', 3500);
      saveLocal(rec);
    } finally { btn.disabled = false; btn.textContent = '🚀 送出通報'; }
    return;
  }
  toast('已暫存，正在開啟通報單…', 3500);
  saveLocal(rec);
};
function saveLocal(rec) {
  const mine = store.get('ad.reports', []);
  mine.unshift({ ...rec, status: '本機暫存' });
  store.set('ad.reports', mine.slice(0, 30));
  printReportSheet(rec);
  resetReport(); renderMyReports();
}
function lineLink(id, key) {
  return `https://line.me/R/oaMessage/${encodeURIComponent(C.lineOaId)}/?${encodeURIComponent(`追蹤 ${id} ${key}`)}`;
}
function showDone(j) {
  $('#reportForm').hidden = true; $('#stepper').hidden = true;
  const box = $('#reportDone');
  box.hidden = false;
  box.innerHTML = `<div class="done-badge">✔</div><h2>通報成功，系統已自動立案</h2>
    <dl class="done-dl"><dt>案號</dt><dd><b>${esc(j.id)}</b></dd><dt>查詢碼</dt><dd><b class="code">${esc(j.key)}</b></dd></dl>
    <p class="small muted">請保存查詢碼：完工後可用來評分，也可用來綁定 LINE 通知。本機已自動記住。</p>
    ${j.nearby?.length ? `<p class="small" style="color:#B45309">系統比對到附近 3 年內有 ${j.nearby.length} 件案件，公所派工前會辦理會勘確認。</p>` : ''}
    <div class="btn-row wrap">
      ${C.lineOaId ? `<a class="btn line" href="${lineLink(j.id, j.key)}" target="_blank" rel="noopener">LINE 接收進度</a>` : ''}
      <a class="btn" href="#case=${esc(j.id)}">查看案件頁</a>
      <button class="btn ghost" type="button" id="newReport">再通報一件</button>
    </div>`;
  $('#newReport').onclick = () => startReport(null);
  $('.panel-body').scrollTop = 0;
}
function resetReport() {
  R.photos = []; R.latlng = null; R.type = ''; R.nearby = []; renderThumbs();
  $('#issueDesc').value = ''; $('#contact').value = ''; $('#email').value = '';
  $('#locBox').className = 'loc-box'; $('#locBox').textContent = '尚未選擇位置'; $('#dupBox').hidden = true;
  $$('#issueChips .chip').forEach(x => x.setAttribute('aria-checked', 'false'));
  if (reportMarker) { map.removeLayer(reportMarker); reportMarker = null; }
  R.step = 1;
  $$('.step').forEach(s => s.hidden = +s.dataset.step !== 1);
  $$('#stepper li').forEach((li, i) => { li.classList.toggle('on', i === 0); li.classList.remove('done'); });
  mapPickOn(false);
}
function printReportSheet(rec) {
  const w = window.open('', '_blank');
  if (!w) return toast('請允許彈出視窗以列印通報單');
  const t = toTWD97(rec.lat, rec.lng);
  w.document.write(`<!doctype html><meta charset="utf-8"><title>道路通報單 ${rec.id}</title>
  <style>body{font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif;padding:28px;color:#1B2A4A}h1{color:#1C5FC4;border-bottom:4px solid #E3001B;padding-bottom:6px}
  table{border-collapse:collapse;width:100%}td,th{border:1.5px solid #1B2A4A;padding:8px;text-align:left;vertical-align:top}th{width:110px;background:#FBF6EC}img{max-width:48%;margin:4px;border:1px solid #ccc}</style>
  <h1>${esc(C.district)} 道路狀況通報單</h1>
  <table><tr><th>暫存編號</th><td>${rec.id}</td></tr><tr><th>通報時間</th><td>${new Date(rec.time).toLocaleString('zh-TW')}</td></tr>
  <tr><th>類別</th><td>${esc(rec.type)}</td></tr><tr><th>里別／道路</th><td>${esc(rec.village)} ${esc(rec.road)}</td></tr>
  <tr><th>座標</th><td>WGS84 ${rec.lat}, ${rec.lng}<br>TWD97 ${t[0].toFixed(0)}, ${t[1].toFixed(0)}<br><a href="https://www.google.com/maps?q=${rec.lat},${rec.lng}">Google 地圖</a></td></tr>
  <tr><th>說明</th><td>${esc(rec.desc) || '—'}</td></tr></table>
  <div>${R.photos.map(p => `<img src="${p.data}">`).join('')}</div>
  <p style="font-size:13px;color:#5E6A80">請將本通報單送交${esc(C.district)}公所，或撥打 1999 市民服務專線。</p>
  <script>setTimeout(()=>print(),400)<\/script>`);
  w.document.close();
}
function renderMyReports() {
  const mine = store.get('ad.reports', []);
  $('#myReportsCard').hidden = !mine.length;
  $('#myReports').innerHTML = mine.map(r => `<li data-id="${esc(r.id)}" data-ll="${r.lat},${r.lng}"><span>${esc(r.id)}・${esc(r.type)}・${esc(r.village || '')}<br><small class="muted">${fmtTime(r.time)}</small></span>
    <span class="tag" style="color:${r.status === '本機暫存' ? '#F39200' : '#2E9E4F'}">${esc(r.status === '本機暫存' ? r.status : '查看進度')}</span></li>`).join('');
  $$('#myReports li').forEach(li => li.onclick = () => {
    if (li.dataset.id.startsWith('AD')) location.hash = 'case=' + li.dataset.id;
    else { const [a, b] = li.dataset.ll.split(',').map(Number); map.flyTo([a, b], 17); }
  });
}
renderMyReports();

/* ---------------- 案件頁：進度、施工前中後照片、評分、留言 ---------------- */
const STEPS = ['已立案', '已派工', '已完工', '已驗收'];
let caseCaptcha = null;
async function openCase(id) {
  const modal = $('#caseModal'), sheet = $('#caseSheet');
  modal.hidden = false;
  sheet.innerHTML = '<p class="muted" style="padding:20px">載入中…</p>';
  if (!C.reportEndpoint) { sheet.innerHTML = '<p style="padding:20px">尚未連接公所後端，無法查詢案件。</p><button class="btn" data-close>關閉</button>'; bindClose(); return; }
  let j;
  try { j = await AD.apiGet({ action: 'case', id }); } catch { j = { ok: false, error: '網路異常' }; }
  if (!j.ok) { sheet.innerHTML = `<div class="case-head" style="background:#8C96A8"><h3>${esc(id)}</h3><button class="info-close" data-close aria-label="關閉">✕</button></div><p style="padding:16px">${esc(j.error || '查無此案件')}</p>`; bindClose(); return; }
  const i = j.item, st = AD.STATUS[i.status] || { step: 0 };
  const mine = store.get('ad.reports', []).find(r => r.id === i.id);
  const key = mine?.key || new URLSearchParams(location.hash.split('&').slice(1).join('&')).get('k') || '';
  const t = toTWD97(i.lat, i.lng);
  const dates = { '已立案': i.date, '已派工': i.dispatchDate, '已完工': i.finishDate, '已驗收': i.acceptDate };
  const kinds = ['before', 'during', 'after'].filter(k => i.photos[k]);
  sheet.innerHTML = `
    <div class="case-head" style="background:${AD.statusColor(i.status)}"><span class="cls">${esc(i.status)}</span><h3>${esc(i.type)}</h3><small>${esc(i.id)}</small>
      <button class="info-close" data-close aria-label="關閉">✕</button></div>
    <div class="case-body">
      ${i.status === '不受理' ? '' : `<ol class="timeline">${STEPS.map((s, n) => `<li class="${n + 1 <= st.step ? 'done' : ''}"><b>${s}</b><small>${esc(AD.rocDate(dates[s]) || '')}</small></li>`).join('')}</ol>`}
      <dl class="case-dl">
        <dt>位置</dt><dd>${esc(i.village || '')}${i.road ? `・${esc(i.road)}` : ''}<br><small>WGS84 ${esc(i.lat)}, ${esc(i.lng)}｜TWD97 ${t[0].toFixed(0)}, ${t[1].toFixed(0)}</small></dd>
        ${i.vendor ? `<dt>施工廠商</dt><dd>${esc(i.vendor)}</dd>` : ''}
        ${i.amount !== '' && i.amount != null ? `<dt>決標金額</dt><dd>${Number(i.amount).toLocaleString()} 元</dd>` : ''}
        ${i.reply ? `<dt>公所說明</dt><dd>${esc(i.reply)}</dd>` : ''}
      </dl>
      ${kinds.length ? `<h4>施工照片（全民檢視）</h4><div class="seg photo-kind">${kinds.map((k, n) => `<button type="button" data-k="${k}" class="${n ? '' : 'on'}">${AD.KIND_NAME[k]} ${i.photos[k]}</button>`).join('')}</div><div class="case-photos" id="casePhotos"></div>` : ''}
      ${i.rating ? `<p class="stars-line"><span class="stars">${'★'.repeat(i.rating)}${'☆'.repeat(5 - i.rating)}</span> 民眾評分${i.ratingText ? `：${esc(i.ratingText)}` : ''}</p>` : ''}
      ${key && ['已完工', '已驗收'].includes(i.status) ? `<form class="rate-form" id="rateForm"><h4>為這次處理評分</h4>
        <div class="star-input" role="radiogroup" aria-label="評分">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-s="${n}" aria-label="${n} 星">★</button>`).join('')}</div>
        <input id="rateText" maxlength="200" placeholder="想對公所說的話（選填）"><button class="btn primary" type="submit">送出評分</button></form>` : ''}
      <h4>案件留言板</h4>
      <ul class="comments">${i.comments.length ? i.comments.map(c => `<li class="${c.role === '公所' ? 'staff' : ''}"><b>${esc(c.name)}</b><small>${fmtTime(c.time)}</small><p>${esc(c.text)}</p></li>`).join('') : '<li class="muted">尚無留言</li>'}</ul>
      <form class="comment-form" id="commentForm">
        <input id="cName" maxlength="20" placeholder="暱稱（選填）"><textarea id="cText" rows="2" maxlength="300" placeholder="留言（公所會收到通知）" required></textarea>
        <div id="cCaptcha"></div><button class="btn primary" type="submit">送出留言</button></form>
      <div class="btn-row wrap">
        <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${Number(i.lat)},${Number(i.lng)}" target="_blank" rel="noopener">🧭 導航</a>
        <button class="btn" type="button" data-loc>📍 地圖定位</button>
        ${key && C.lineOaId ? `<a class="btn line" href="${lineLink(i.id, key)}" target="_blank" rel="noopener">LINE 接收進度</a>` : ''}
      </div>
    </div>`;
  bindClose();
  $('[data-loc]', sheet).onclick = () => { modal.hidden = true; map.flyTo([i.lat, i.lng], 18); };
  // 施工照片（延遲載入）
  const showKind = async k => {
    $$('.photo-kind button', sheet).forEach(b => b.classList.toggle('on', b.dataset.k === k));
    const box = $('#casePhotos'); box.innerHTML = Array.from({ length: i.photos[k] }, (_, n) => `<figure data-n="${n}"><span class="muted small">載入中…</span></figure>`).join('');
    for (let n = 0; n < i.photos[k]; n++) {
      AD.apiGet({ action: 'photo', id: i.id, kind: k, n }).then(p => {
        const fig = box.querySelector(`[data-n="${n}"]`); if (!fig || !p.ok) return;
        fig.innerHTML = `<img src="${p.data}" alt="${AD.KIND_NAME[k]} ${n + 1}"><figcaption>指紋 ${esc(p.sha.slice(0, 12))}</figcaption>`;
        fig.onclick = () => { const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${p.data}" alt="">`; lb.onclick = () => lb.remove(); document.body.appendChild(lb); };
      });
    }
  };
  $$('.photo-kind button', sheet).forEach(b => b.onclick = () => showKind(b.dataset.k));
  if (kinds.length) showKind(kinds[0]);
  // 評分
  const rf = $('#rateForm');
  if (rf) {
    let stars = 0;
    $$('.star-input button', rf).forEach(b => b.onclick = () => { stars = +b.dataset.s; $$('.star-input button', rf).forEach(x => x.classList.toggle('on', +x.dataset.s <= stars)); });
    rf.onsubmit = async ev => {
      ev.preventDefault();
      if (!stars) return toast('請選擇星等');
      const r = await AD.apiPost('rate', { id: i.id, key, stars, text: $('#rateText').value.trim() }).catch(() => ({ ok: false, error: '網路異常' }));
      if (!r.ok) return toast(r.error || '評分失敗');
      toast('感謝您的評分！'); openCase(i.id);
    };
  }
  // 留言
  caseCaptcha = AD.captchaWidget($('#cCaptcha'));
  $('#commentForm').onsubmit = async ev => {
    ev.preventDefault();
    const cap = caseCaptcha.get();
    if (!/^\d{4}$/.test(cap.answer)) return toast('請輸入驗證碼（4 個數字）');
    const r = await AD.apiPost('comment', { id: i.id, name: $('#cName').value.trim(), text: $('#cText').value.trim(), ...cap }).catch(() => ({ ok: false, error: '網路異常' }));
    if (!r.ok) { toast(r.error || '留言失敗'); caseCaptcha.refresh(); return; }
    toast('留言已送出，公所會收到通知'); openCase(i.id);
  };
}
function bindClose() {
  $$('#caseSheet [data-close]').forEach(b => b.onclick = closeCase);
}
function closeCase() {
  $('#caseModal').hidden = true;
  if (location.hash.startsWith('#case=')) history.replaceState(null, '', location.pathname + location.search);
}
$('#caseModal').onclick = e => { if (e.target.id === 'caseModal') closeCase(); };

/* ---------------- 地圖互動模式（點選位置／點查／量測） ---------------- */
function setMode(mode, hint) {
  S.mode = mode;
  const h = $('#mapHint');
  if (mode) {
    h.innerHTML = `${esc(hint)} <button type="button">完成</button>`;
    h.hidden = false;
    $('button', h).onclick = () => { if (mode === 'measure') finishMeasure(); setMode(null); if (mode === 'identify') $('#identifyToggle').checked = false; };
    map.getContainer().style.cursor = 'crosshair';
  } else {
    h.hidden = true;
    map.getContainer().style.cursor = '';
  }
}
map.on('click', e => {
  if (S.mode === 'pick') { setReportLoc(e.latlng, '地圖點選'); if (isMobile()) setSheet('half'); return; }
  if (S.mode === 'identify') return identify(e.latlng);
  if (S.mode === 'measure') return addMeasure(e.latlng);
  if (S.selected) closeInfo();
});

function identify(ll) {
  const t = toTWD97(ll.lat, ll.lng), near = nearestRoads(ll, 100, 3), v = villageAt(ll);
  L.popup().setLatLng(ll).setContent(`<h4>${esc(v || '安定區外')}</h4>
    WGS84：${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}<br>TWD97：${t[0].toFixed(1)}, ${t[1].toFixed(1)}<br>
    ${near.length ? '<b>鄰近道路</b><br>' + near.map(o => `${esc(o.f.properties.name)}（${Math.round(o.d)} m）`).join('<br>') : '<span class="muted">100 m 內無登錄道路</span>'}
    <div style="margin-top:6px"><a href="#" data-copy="${t[0].toFixed(1)},${t[1].toFixed(1)}">複製 TWD97</a>｜<a href="#" data-copy="${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}">複製 WGS84</a></div>`).openOn(map);
  setTimeout(() => $$('[data-copy]').forEach(a => a.onclick = ev => { ev.preventDefault(); navigator.clipboard?.writeText(a.dataset.copy).then(() => toast('已複製 ' + a.dataset.copy)); }), 0);
}
$('#identifyToggle').onchange = e => e.target.checked ? setMode('identify', '點擊地圖查詢座標') : setMode(null);

let measurePts = [], measureLayer = L.layerGroup().addTo(map);
function addMeasure(ll) {
  if (measurePts.length && map.distance(measurePts[measurePts.length - 1], ll) < .5) return;
  measurePts.push(ll);
  measureLayer.clearLayers();
  L.polyline(measurePts, { color: '#1B2A4A', weight: 7, opacity: .25 }).addTo(measureLayer);
  L.polyline(measurePts, { color: '#F39200', weight: 3.5, dashArray: '8 6' }).addTo(measureLayer);
  measurePts.forEach(p => L.circleMarker(p, { radius: 5, color: '#1B2A4A', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(measureLayer));
  let d = 0; for (let i = 1; i < measurePts.length; i++) d += map.distance(measurePts[i - 1], measurePts[i]);
  $('#measureOut').textContent = fmtLenTxt(d);
  $('#mapHint').firstChild.textContent = `量測中：${fmtLenTxt(d)} `;
}
function finishMeasure() { $('#measureBtn').textContent = '開始量測'; }
$('#measureBtn').onclick = () => {
  if (S.mode === 'measure') { finishMeasure(); return setMode(null); }
  measurePts = []; measureLayer.clearLayers(); $('#measureOut').textContent = '';
  setMode('measure', '點擊地圖開始量測'); $('#measureBtn').textContent = '完成量測';
  if (isMobile()) setSheet('peek');
};
$('#measureClear').onclick = () => { measurePts = []; measureLayer.clearLayers(); $('#measureOut').textContent = ''; };
map.on('dblclick', e => { if (S.mode === 'measure') { L.DomEvent.stop(e); finishMeasure(); setMode(null); } });
map.doubleClickZoom.disable();
map.on('dblclick', e => { if (!S.mode) map.setZoomAround(e.latlng, map.getZoom() + 1); });

/* ---------------- 座標定位／半徑 ---------------- */
let radius = 0, coordLayer = L.layerGroup().addTo(map);
$$('#radiusSeg button').forEach(b => b.onclick = () => { radius = +b.dataset.r; $$('#radiusSeg button').forEach(x => x.classList.toggle('on', x === b)); if ($('#coordInput').value.trim()) $('#coordGo').click(); });
function parseCoord(line) {
  const n = line.replace(/[，、\s]+/g, ',').split(',').filter(Boolean).map(Number);
  if (n.length < 2 || n.some(isNaN)) return null;
  let [a, b] = n;
  if (a > 1000 && b > 1000) { // TWD97
    if (a > b) [a, b] = [b, a];
    return { ll: L.latLng(...fromTWD97(a, b)), src: `TWD97 ${a}, ${b}` };
  }
  if (a > 90) [a, b] = [b, a]; // 經度在前
  if (a < 20 || a > 27 || b < 118 || b > 124) return null;
  return { ll: L.latLng(a, b), src: `WGS84 ${a}, ${b}` };
}
$('#coordGo').onclick = () => {
  coordLayer.clearLayers();
  const lines = $('#coordInput').value.split(/\n/).map(s => s.trim()).filter(Boolean);
  const hits = lines.map(parseCoord);
  const out = [];
  hits.forEach((h, i) => {
    if (!h) { out.push(`<div class="coord-hit">⚠️ 第 ${i + 1} 行無法辨識：${esc(lines[i])}</div>`); return; }
    const v = villageAt(h.ll), near = nearestRoads(h.ll, Math.max(radius, 60), 3);
    L.marker(h.ll, { icon: L.divIcon({ className: 'pin-icon', html: '<span style="background:#1C5FC4"></span>', iconSize: [24, 24] }) })
      .bindTooltip(`#${i + 1}`, { permanent: true, direction: 'top', offset: [0, -10], className: 'road-tip' }).addTo(coordLayer);
    if (radius) L.circle(h.ll, { radius, color: '#E3001B', weight: 2, dashArray: '6 4', fillColor: '#E3001B', fillOpacity: .08 }).addTo(coordLayer);
    h.idx = out.length;
    out.push(`<div class="coord-hit" data-ll="${h.ll.lat},${h.ll.lng}"><b>#${i + 1} ${esc(v || '安定區外')}</b><br><small>${esc(h.src)}</small><br>${near.length ? '鄰近：' + near.map(o => `${esc(o.f.properties.name)} ${Math.round(o.d)}m`).join('、') : '<span class="muted">附近無登錄道路</span>'}</div>`);
  });
  $('#coordResult').innerHTML = out.join('');
  $$('#coordResult [data-ll]').forEach(d => d.onclick = () => map.flyTo(d.dataset.ll.split(',').map(Number), 17));
  const ok = hits.filter(Boolean);
  if (ok.length === 1) map.flyTo(ok[0].ll, radius > 100 ? 16 : 17);
  else if (ok.length > 1) map.flyToBounds(L.latLngBounds(ok.map(h => h.ll)), { padding: [60, 60], maxZoom: 16 });
};
$('#coordClear').onclick = () => { coordLayer.clearLayers(); $('#coordInput').value = ''; $('#coordResult').innerHTML = ''; };

/* ---------------- 定位 ---------------- */
let meMarker = null;
function locate(cb) {
  if (!navigator.geolocation) return toast('此裝置不支援定位');
  toast('定位中…');
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="pulse"></div>', iconSize: [18, 18] }), interactive: false }).addTo(map);
    else meMarker.setLatLng(ll);
    cb ? cb(ll) : map.flyTo(ll, 17);
    if (!villageAt(ll)) toast('您目前不在安定區範圍內');
  }, () => toast('無法取得位置，請確認定位權限'), { enableHighAccuracy: true, timeout: 10000 });
}
$('#fabLocate').onclick = () => locate();
$('#fabHome').onclick = () => S.homeBounds && map.flyToBounds(S.homeBounds, { padding: [20, 20], duration: .6 });

/* ---------------- 下載／列印 ---------------- */
function downloadCSV(rows, name) {
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#roadsCsv').onclick = () => downloadCSV(
  [['編號', '名稱', '等級', '路線編號', '行經里別', '長度(m)', '鋪面', '路段數', 'OSM way']].concat(
    S.roads.map(f => { const p = f.properties; return [p.id, p.name, p.clsName, p.ref, p.villages.join('、'), p.length_m, p.surface, p.segments, p.osm.join(' ')]; })),
  '安定區公眾通行道路清冊.csv');
$('#printBtn').onclick = () => window.print();

/* ---------------- 公告 ---------------- */
getJSON('data/news.json').then(list => {
  list.sort((a, b) => (b.pin - a.pin) || b.date.localeCompare(a.date));
  $('#newsList').innerHTML = list.map(n => `<article class="news-item ${n.pin ? 'pin' : ''}"><time>${esc(n.date)}${n.pin ? '・置頂' : ''}</time><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p></article>`).join('') || '<p class="muted">目前沒有公告</p>';
}).catch(() => { $('#newsList').innerHTML = '<p class="muted">公告載入失敗</p>'; });

/* ---------------- 網址導向、雙模式入口分流 ---------------- */
addEventListener('hashchange', () => routeFromHash());
function routeFromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('case=')) return openCase(h.slice(5).split('&')[0].toUpperCase());
  if (!S.roads.length) return;
  if (h.startsWith('road=')) { const f = S.roads.find(r => r.properties.id === h.slice(5)); if (f) return selectRoad(f); }
  if (['roads', 'cases', 'report', 'tools', 'news'].includes(h)) return openTab(h, { expand: false });
  if (S.homeBounds) map.fitBounds(S.homeBounds, { padding: [10, 10] });
}
if (location.hash.startsWith('#case=')) routeFromHash();

/** 輕量版：只保留「通報」流程，介面最精簡，適合長輩與現場快速通報 */
function enterLite() {
  document.body.classList.add('lite');
  startReport(null);
  if (isMobile()) setSheet('full');
}
if (new URLSearchParams(location.search).get('mode') === 'lite') enterLite();
else if (!store.get('ad.skipWelcome', false) && !location.hash) {
  $('#welcome').hidden = false;
  $$('#welcome [data-mode]').forEach(b => b.onclick = () => {
    if ($('#welcomeSkip').checked) store.set('ad.skipWelcome', true);
    $('#welcome').hidden = true;
    if (b.dataset.mode === 'lite') { history.replaceState(null, '', '?mode=lite'); enterLite(); }
    else openTab('roads');
  });
  $('#welcome').onclick = e => { if (e.target.id === 'welcome') $('#welcome').hidden = true; };
}
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#caseModal').hidden) return closeCase();
  $('#welcome').hidden = true; $('#baseMenu').hidden = true;
  if (S.mode) { if (S.mode === 'measure') finishMeasure(); setMode(null); } else if (S.selected) closeInfo();
});
if (isMobile() && !document.body.classList.contains('lite')) setSheet(location.hash && !location.hash.startsWith('#road=') ? 'half' : 'peek');
})();
