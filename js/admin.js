/* =========================================================
   安定區公眾通行道路 管理後台
   權限由後端（Google Apps Script）逐一驗證；前端不含任何密碼或金鑰。
   ========================================================= */
(() => {
'use strict';

const { C, $, esc, fmtTime, rocDate, toTWD97, STATUS, statusColor, toast, apiPost, apiGet } = window.AD;
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ROLE_NAME = { vendor: '廠商', viewer: '檢視者', handler: '承辦人', admin: '管理者' };
const LEVEL = { vendor: 0, viewer: 1, handler: 2, admin: 3 };
const STATUSES = ['已立案', '已派工', '已完工', '已驗收', '不受理'];
const today = () => new Date().toLocaleDateString('sv-SE');

/* ---------------- 工作階段（sessionStorage：關閉分頁即登出） ---------------- */
const SESSION_KEY = 'ad.adminSession';
let session = null;
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
if (session && (session.exp < Date.now() || session.role === 'vendor')) session = null;
function saveSession(s) { session = s; try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* 無痕 */ } }
const can = role => session && LEVEL[session.role] >= LEVEL[role];

async function api(action, body = {}) {
  const j = await apiPost(action, { token: session?.token, ...body });
  if (!j.ok && j.auth) { logout(j.error || '請重新登入'); throw new Error(j.error); }
  return j;
}

/* ---------------- 登入 ---------------- */
if (!C.reportEndpoint) { $('#loginMsg').textContent = '尚未設定後端（js/config.js 的 reportEndpoint），後台無法使用。'; $('#loginBtn').disabled = true; }
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = '驗證中…'; $('#loginMsg').textContent = '';
  try {
    const j = await apiPost('login', { user: $('#user').value.trim(), pwd: $('#pwd').value });
    if (!j.ok) { $('#loginMsg').textContent = j.error || '登入失敗'; return; }
    if (j.role === 'vendor') { $('#loginMsg').innerHTML = '廠商帳號請使用 <a href="vendor.html">廠商回報中心</a>'; return; }
    saveSession({ token: j.token, user: j.user, role: j.role, exp: j.exp });
    $('#pwd').value = '';
    enterApp();
  } catch { $('#loginMsg').textContent = '無法連線到後端，請稍後再試'; }
  finally { btn.disabled = false; btn.textContent = '登入'; }
};
let expTimer;
function logout(msg) {
  saveSession(null); clearInterval(expTimer);
  $('#appView').hidden = true; $('#loginView').hidden = false; $('#detail').hidden = true;
  S.items = [];
  if (msg) $('#loginMsg').textContent = msg;
}
$('#logoutBtn').onclick = () => logout('已登出');

/* ---------------- 主畫面 ---------------- */
const S = { items: [], status: '', sel: null, contracts: [], roads: null, staticCases: null, pick: null };
let map, markers = L.layerGroup(), roadLayer = null, landLayer, photoLayer, selMarker = null;

function enterApp() {
  $('#loginView').hidden = true; $('#appView').hidden = false;
  $('#userName').textContent = session.user;
  const rb = $('#roleBadge'); rb.textContent = ROLE_NAME[session.role]; rb.className = 'role-badge ' + session.role;
  $$('[data-admin]').forEach(el => el.hidden = !can('admin'));
  $$('[data-handler]').forEach(el => el.hidden = !can('handler'));
  const tick = () => {
    const left = session.exp - Date.now();
    if (left <= 0) return logout('登入逾時，請重新登入');
    $('#expireHint').textContent = `${Math.floor(left / 3600e3)} 時 ${Math.floor(left % 3600e3 / 60e3)} 分後自動登出`;
  };
  tick(); clearInterval(expTimer); expTimer = setInterval(tick, 30e3);
  initMap(); load(); loadContracts();
}

function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  map = L.map('adminMap', { zoomControl: false, preferCanvas: true, maxZoom: 20 }).setView(C.center, C.zoom);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  const NLSC = id => `https://wmts.nlsc.gov.tw/wmts/${id}/default/GoogleMapsCompatible/{z}/{y}/{x}`;
  L.tileLayer(NLSC('EMAP'), { maxZoom: 20, maxNativeZoom: 18, className: 'tile-warm', attribution: '© 國土測繪中心' }).addTo(map);
  photoLayer = L.tileLayer(NLSC('PHOTO2'), { maxZoom: 20, maxNativeZoom: 19 });
  landLayer = L.tileLayer(NLSC('LAND_OPENDATA'), { maxZoom: 20, maxNativeZoom: 19, minZoom: 16, opacity: .9, attribution: '地籍：國土測繪中心' });
  markers.addTo(map);
  Promise.all(['data/boundary.geojson', 'data/villages.geojson', 'data/roads.geojson'].map(u => fetch(u).then(r => r.json()))).then(([b, v, roads]) => {
    L.geoJSON(v, { style: { color: '#1C5FC4', weight: 1, dashArray: '3 5', fill: false }, interactive: false }).addTo(map);
    const lyr = L.geoJSON(b, { style: { color: '#E3001B', weight: 2.5, dashArray: '10 6', fill: false }, interactive: false }).addTo(map);
    S.roads = roads.features;
    roadLayer = L.geoJSON(roads, { interactive: false, style: f => ({ color: (C.roadClasses[f.properties.cls] || {}).color || '#888', weight: f.properties.cls === 'lane' ? 1.5 : 3, opacity: .75 }) }).addTo(map);
    if (!S.items.length) map.fitBounds(lyr.getBounds(), { padding: [10, 10] });
    fillSelect('#fVillage', v.features.map(f => f.properties.name));
    S.villages = v;
  });
  $$('#mapLayers [data-layer]').forEach(cb => cb.onchange = () => setLayer(cb.dataset.layer, cb.checked));
  map.on('click', e => { if (S.pick) S.pick(e.latlng); });
  setTimeout(() => map.invalidateSize(), 50);
}
function setLayer(name, on) {
  const l = { roads: roadLayer, land: landLayer, photo: photoLayer }[name];
  if (!l) return;
  $(`#mapLayers [data-layer=${name}]`).checked = on;
  if (on) { l.addTo(map); if (name === 'photo') l.bringToBack(); } else map.removeLayer(l);
}

async function load() {
  $('#caseList').innerHTML = '<li class="muted">載入中…</li>';
  try {
    const j = await api('adminList');
    if (!j.ok) { toast(j.error || '讀取失敗'); return; }
    S.items = (j.items || []).sort((a, b) => String(b.time).localeCompare(String(a.time)));
    fillSelect('#fType', j.types || C.issueTypes);
    render();
    if (S.sel) openDetail(S.sel.id, false);
  } catch { if (session) $('#caseList').innerHTML = '<li class="muted">無法連線到後端</li>'; }
}
$('#refreshBtn').onclick = () => { load(); loadContracts(); };

async function loadContracts() {
  try { const j = await api('adminContracts'); S.contracts = j.items || []; renderContracts(); if (S.sel) updateBudget(S.sel); } catch { /* 已處理 */ }
}

function fillSelect(sel, values) {
  const el = $(sel), cur = el.value, first = el.options[0].outerHTML;
  el.innerHTML = first + values.filter(Boolean).map(v => `<option>${esc(v)}</option>`).join('');
  el.value = cur;
}

function filtered() {
  const q = $('#fq').value.trim().toLowerCase(), t = $('#fType').value, v = $('#fVillage').value;
  const from = $('#fFrom').value, to = $('#fTo').value;
  return S.items.filter(i => {
    const day = i.date || '';
    return (!S.status || i.status === S.status) && (!t || i.type === t) && (!v || i.village === v) &&
      (!from || day >= from) && (!to || day <= to) &&
      (!q || `${i.id} ${i.desc} ${i.road} ${i.village} ${i.contact} ${i.email} ${i.reply} ${i.vendor}`.toLowerCase().includes(q));
  });
}

function render() {
  const count = s => S.items.filter(i => i.status === s).length;
  const rated = S.items.filter(i => i.rating);
  $('#kpis').innerHTML = STATUSES.map(s => `<div class="kpi ${S.status === s ? 'on' : ''}" data-s="${s}" role="button" tabindex="0"><b style="color:${statusColor(s)}">${count(s)}</b><span>${s}</span></div>`).join('') +
    `<div class="kpi ${!S.status ? 'on' : ''}" data-s="" role="button" tabindex="0"><b>${S.items.length}</b><span>全部</span></div>` +
    `<div class="kpi static" title="民眾評分平均"><b style="color:#F5A623">${rated.length ? (rated.reduce((a, i) => a + i.rating, 0) / rated.length).toFixed(1) : '—'}</b><span>平均評分</span></div>`;
  $$('.kpi[data-s]').forEach(k => { k.onclick = () => { S.status = k.dataset.s; render(); }; k.onkeydown = e => { if (e.key === 'Enter') k.click(); }; });

  const list = filtered();
  $('#resultCount').textContent = `共 ${list.length} 件`;
  $('#caseList').innerHTML = list.length ? list.map(i => `
    <li class="case-card ${S.sel?.id === i.id ? 'sel' : ''}" data-id="${esc(i.id)}" tabindex="0">
      <span class="t">${esc(i.type)}・${esc(i.village || '—')}</span><span class="st" style="background:${statusColor(i.status)}">${esc(i.status)}</span>
      <span class="d">${esc(i.desc || '（無說明）')}</span>
      <span class="m">${esc(i.id)}・${esc(i.source)}・${fmtTime(i.time)}${i.citizenPhotos ? `・📷${i.citizenPhotos}` : ''}${i.vendor ? `・${esc(i.vendor)}` : ''}${i.comments ? `・💬${i.comments}` : ''}${i.rating ? `・${'★'.repeat(i.rating)}` : ''}</span>
    </li>`).join('') : '<li class="muted empty">沒有符合條件的案件</li>';
  $$('.case-card').forEach(li => { li.onclick = () => openDetail(li.dataset.id, true); li.onkeydown = e => { if (e.key === 'Enter') li.click(); }; });

  markers.clearLayers();
  list.filter(i => i.lat && i.lng).forEach(i => {
    L.marker([i.lat, i.lng], {
      icon: L.divIcon({ className: 'admin-marker' + (S.sel?.id === i.id ? ' sel' : ''), html: `<span style="background:${statusColor(i.status)}"></span>`, iconSize: [22, 22] }),
      title: `${i.id} ${i.type}`, zIndexOffset: S.sel?.id === i.id ? 1000 : 0,
    }).on('click', () => openDetail(i.id, false)).addTo(markers);
  });
}
['#fq', '#fType', '#fVillage', '#fFrom', '#fTo'].forEach(s => $(s).addEventListener('input', render));

/* ---------------- 防弊檢核（前端輔助；後端仍會再驗證） ---------------- */
function nearestRoad(lat, lng) {
  if (!S.roads) return null;
  const k = Math.cos(lat * Math.PI / 180) * 111320, ky = 110574;
  let best = { d: Infinity, name: '' };
  S.roads.forEach(f => {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    lines.forEach(l => { for (let n = 0; n < l.length - 1; n++) {
      const ax = (l[n][0] - lng) * k, ay = (l[n][1] - lat) * ky, bx = (l[n + 1][0] - lng) * k, by = (l[n + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, L2 ? -(ax * dx + ay * dy) / L2 : 0));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.d) best = { d, name: f.properties.name, cls: f.properties.clsName };
    } });
  });
  return best;
}
async function staticHistoryNear(lat, lng) {
  if (!S.staticCases) {
    S.staticCases = [];
    const idx = await fetch('data/cases/index.json').then(r => r.json()).catch(() => ({ groups: [] }));
    for (const g of idx.groups || []) for (const it of g.items) {
      const gj = await fetch('data/cases/' + it.file).then(r => r.json()).catch(() => ({ features: [] }));
      gj.features.forEach(f => S.staticCases.push({ ...f.properties, label: it.label, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
    }
  }
  return S.staticCases.filter(c => {
    const when = Date.parse(c.finishDate || c.dispatchDate);
    return map.distance([lat, lng], [c.lat, c.lng]) <= 50 && (isNaN(when) || Date.now() - when <= 3 * 365.25 * 864e5);
  }).map(c => ({ id: c.title || c.label, date: c.finishDate || c.dispatchDate, type: c.type || c.label, status: '歷史維修', dist: Math.round(map.distance([lat, lng], [c.lat, c.lng])) }));
}

/* ---------------- 案件詳細 ---------------- */
async function openDetail(id, fly) {
  const i = S.items.find(x => x.id === id);
  if (!i) return;
  S.sel = i;
  const d = $('#detail');
  const t = toTWD97(i.lat, i.lng);
  const road = nearestRoad(Number(i.lat), Number(i.lng));
  d.innerHTML = `
    <div class="detail-head" style="border-top:8px solid ${statusColor(i.status)}"><span class="st" style="background:${statusColor(i.status)}">${esc(i.status)}</span>
      <h2>${esc(i.type)}</h2><span class="small muted">${esc(i.id)}・${esc(i.source)}</span>
      <button class="info-close" aria-label="關閉">✕</button></div>
    <div class="detail-body">
      <dl>
        <dt>立案時間</dt><dd>${fmtTime(i.time)}</dd>
        <dt>位置</dt><dd>${esc(i.village || '—')}${i.road ? `・${esc(i.road)}` : ''}<br>
          <small>WGS84 ${esc(i.lat)}, ${esc(i.lng)}<br>TWD97 ${t[0].toFixed(1)}, ${t[1].toFixed(1)}</small><br>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${Number(i.lat)},${Number(i.lng)}" target="_blank" rel="noopener noreferrer">導航</a>｜<a href="./#case=${esc(i.id)}" target="_blank" rel="noopener">公開案件頁</a></dd>
        <dt>說明</dt><dd>${esc(i.desc || '（無）')}</dd>
        <dt>聯絡方式</dt><dd>${esc(i.contact || '（未填）')}</dd>
        <dt>通知</dt><dd>${i.email ? `Email ${esc(i.email)}` : ''}${i.line ? '　LINE 已綁定' : ''}${!i.email && !i.line ? '（無）' : ''}</dd>
        <dt>民眾照片</dt><dd>${photoButtons('citizen', i.citizenPhotos)}</dd>
      </dl>

      <section class="dsec" id="checkSec"><h3>🛡️ 防弊檢核</h3>
        <div class="check-row ${road && road.d <= 30 ? 'ok' : 'warn'}"><b>① 地籍圖比對</b>
          <span>距最近公眾通行道路 ${road ? `${Math.round(road.d)} m（${esc(road.name)}）` : '計算中'}${road && road.d > 30 ? '，<b>可能位於私有土地，請務必套疊地籍圖確認</b>' : '；派工前仍須套疊地籍圖確認'}</span>
          <button class="btn sm" type="button" id="showLand">套疊地籍圖</button></div>
        <div class="check-row" id="dupRow"><b>② 時間及空間雙重演算法</b><span>比對中…</span></div>
        <div class="check-row ${i.contractId ? 'ok' : ''}" id="budgetRow"><b>③ 預算控管</b><span>${i.contractId ? '' : '派工時檢核'}</span></div>
      </section>

      ${dispatchSection(i)}
      ${reportSection(i)}
      ${can('handler') && ['已立案', '不受理'].includes(i.status) ? `
      <section class="dsec"><h3>受理狀態</h3>
        <div class="seg" id="stSeg">${['已立案', '不受理'].map(s => `<button type="button" data-s="${s}" class="${s === i.status ? 'on' : ''}">${s}</button>`).join('')}</div>
        <label class="field">處理說明（公開）<textarea id="replyText" rows="2" maxlength="300">${esc(i.reply || '')}</textarea></label>
        <button class="btn full" type="button" id="saveStatus">儲存</button></section>` : (i.reply ? `<section class="dsec"><h3>處理說明</h3><p>${esc(i.reply)}</p></section>` : '')}

      <section class="dsec"><h3>💬 留言與評分</h3>
        ${i.rating ? `<p><span class="stars">${'★'.repeat(i.rating)}${'☆'.repeat(5 - i.rating)}</span> ${esc(i.ratingText || '')}</p>` : '<p class="small muted">尚未評分</p>'}
        <ul class="comments" id="commentList"><li class="muted">載入中…</li></ul>
        ${can('handler') ? `<form class="comment-form" id="replyForm"><textarea id="replyComment" rows="2" maxlength="300" placeholder="以公所身分回覆（會通知民眾）" required></textarea><button class="btn primary" type="submit">公所回覆</button></form>` : ''}
      </section>

      <section class="dsec"><h3>🔗 數位軌跡</h3><ol class="events" id="eventList"><li class="muted">載入中…</li></ol></section>
    </div>`;
  d.hidden = false;
  $('.info-close', d).onclick = () => { d.hidden = true; S.sel = null; render(); };
  $('#showLand').onclick = () => { setLayer('land', true); map.flyTo([i.lat, i.lng], 18); toast('已套疊地籍圖，請確認案件位置屬公眾通行道路'); };
  bindPhotos(i);
  bindDispatch(i);
  bindReport(i);
  if ($('#saveStatus')) {
    let st = i.status;
    $$('#stSeg button').forEach(b => b.onclick = () => { st = b.dataset.s; $$('#stSeg button').forEach(x => x.classList.toggle('on', x === b)); });
    $('#saveStatus').onclick = () => act('adminUpdate', { id: i.id, status: st, reply: $('#replyText').value.trim() }, `${i.id} 已更新`);
  }
  if ($('#replyForm')) $('#replyForm').onsubmit = e => { e.preventDefault(); act('adminReply', { id: i.id, text: $('#replyComment').value.trim() }, '已回覆並通知民眾'); };
  if (fly && i.lat) {
    const z = Math.max(map.getZoom(), 17), panel = matchMedia('(max-width: 820px)').matches ? 0 : d.offsetWidth / 2;
    map.flyTo(map.unproject(map.project([i.lat, i.lng], z).add([panel, 0]), z), z, { duration: .6 });
  }
  render();
  // 非同步：重複案件比對、留言與軌跡
  const [near, hist] = await Promise.all([
    apiGet({ action: 'nearby', lat: i.lat, lng: i.lng, exclude: i.id }).then(r => r.items || []).catch(() => []),
    staticHistoryNear(Number(i.lat), Number(i.lng)),
  ]);
  if (S.sel !== i) return;
  const all = near.concat(hist);
  i._dup = all;
  const dupRow = $('#dupRow');
  dupRow.className = 'check-row ' + (all.length ? 'warn' : 'ok');
  dupRow.querySelector('span').innerHTML = all.length
    ? `3 年內方圓 50 公尺內有 <b>${all.length} 件</b>：${all.slice(0, 4).map(x => `${esc(x.id)}（${esc(x.date)}，${x.dist} m）`).join('、')}<br><b>不得逕行派工，須辦理會勘並簽奉核可</b>`
    : '3 年內方圓 50 公尺內無其他案件';
  const ap = $('#dApproval');
  if (ap) ap.closest('label').hidden = !all.length;   // 必填檢核由送出時的警示視窗處理
  updateBudget(i);
  try {
    const c = await api('adminComments', { id: i.id });
    if (S.sel !== i) return;
    $('#commentList').innerHTML = (c.items || []).map(m => `<li class="${m.role === '公所' ? 'staff' : ''} ${m.hidden ? 'hidden-c' : ''}"><b>${esc(m.name)}</b><small>${fmtTime(m.time)}${m.hidden ? '・已隱藏' : ''}</small>
      ${can('handler') ? `<button class="link-btn" data-hide="${esc(m.cid)}" data-h="${m.hidden ? '' : '1'}">${m.hidden ? '取消隱藏' : '隱藏'}</button>` : ''}<p>${esc(m.text)}</p></li>`).join('') || '<li class="muted">尚無留言</li>';
    $$('[data-hide]').forEach(b => b.onclick = () => act('adminHideComment', { cid: b.dataset.hide, hidden: !!b.dataset.h }, '已更新留言'));
    $('#eventList').innerHTML = (c.events || []).map(ev => `<li><b>${esc(ev.event)}</b> ${esc(ev.user)}<small>${fmtTime(ev.time)}｜${esc(String(ev.hash).slice(0, 10))}</small></li>`).join('');
  } catch { /* 已處理 */ }
}

function photoButtons(kind, n) {
  return n ? `<div class="photos">${Array.from({ length: n }, (_, k) => `<button type="button" data-kind="${kind}" data-n="${k}">載入 ${k + 1}</button>`).join('')}</div>` : '無';
}
const fileCache = {};
async function getFile(item, kind, n) {
  const key = `${item.id}:${kind}:${n}`;
  if (!fileCache[key]) {
    const j = await api('adminPhoto', { id: item.id, kind, n });
    if (!j.ok) throw new Error(j.error);
    fileCache[key] = j;
  }
  return fileCache[key];
}
function bindPhotos(i) {
  $$('#detail .photos button').forEach(b => b.onclick = async () => {
    b.textContent = '載入中…';
    try {
      const f = await getFile(i, b.dataset.kind, +b.dataset.n);
      b.innerHTML = `<img src="${f.data}" alt="">`;
      b.title = 'SHA-256 ' + f.sha;
      b.onclick = () => { const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${f.data}" alt="">`; lb.onclick = () => lb.remove(); document.body.appendChild(lb); };
    } catch { b.textContent = '讀取失敗'; }
  });
}

/* ---------------- 派工：地籍確認、會勘簽核、預算控管 ---------------- */
function dispatchSection(i) {
  if (i.status === '已立案' && can('handler')) {
    const opts = S.contracts.filter(c => c.status !== '停用').map(c => `<option value="${esc(c.id)}">${esc(c.id)}｜${esc(c.vendor)}｜剩餘 ${c.remaining.toLocaleString()} 元</option>`).join('');
    return `<section class="dsec"><h3>📋 審核派工</h3>
      ${opts ? `<form id="dispatchForm">
        <label class="field">開口契約<select id="dContract" required><option value="">請選擇</option>${opts}</select></label>
        <label class="field">派工金額（元）<input id="dAmount" type="number" min="1" step="1" required inputmode="numeric"></label>
        <div class="budget-bar" id="dBudget" hidden><i></i><span></span></div>
        <label class="field">排程施工日期<input id="dDate" type="date" required min="${today()}" value="${today()}"></label>
        <label class="field check"><input type="checkbox" id="dLand"> 已套疊地籍圖，確認屬公眾通行道路（防私路公修）</label>
        <label class="field" hidden>會勘簽奉核可文號（重複案件必填）<input id="dApproval" maxlength="60" placeholder="例：安區建字第1150001234號"></label>
        <label class="field">派工說明（公開）<textarea id="dReply" rows="2" maxlength="300"></textarea></label>
        <button class="btn primary full" type="submit">派工</button></form>` : '<p class="small muted">尚無啟用中的開口契約，請管理者先到「開口契約」建立。</p>'}
    </section>`;
  }
  if (!i.contractId) return '';
  return `<section class="dsec"><h3>📋 派工資訊</h3><dl>
    <dt>契約</dt><dd>${esc(i.contractId)}</dd><dt>廠商</dt><dd>${esc(i.vendor)}</dd>
    <dt>派工金額</dt><dd>${Number(i.amount).toLocaleString()} 元</dd><dt>排程日期</dt><dd>${esc(rocDate(i.dispatchDate))}</dd>
    <dt>派工人</dt><dd>${esc(i.dispatcher)}</dd><dt>地籍確認</dt><dd>${i.landChecked ? '✔ 已確認' : '—'}</dd>
    ${i.approvalNo ? `<dt>會勘簽核</dt><dd>${esc(i.approvalNo)}</dd>` : ''}</dl></section>`;
}
function updateBudget(i) {
  const row = $('#budgetRow span');
  if (!row) return;
  if (i.contractId) {
    const c = S.contracts.find(x => x.id === i.contractId);
    row.textContent = c ? `${c.id} 已派工 ${c.used.toLocaleString()} / 限額 ${c.limit.toLocaleString()} 元（${Math.round(c.used / c.limit * 100)}%）` : i.contractId;
    $('#budgetRow').className = 'check-row ok';
  }
}
function bindDispatch(i) {
  const f = $('#dispatchForm');
  if (!f) return;
  const contract = () => S.contracts.find(c => c.id === $('#dContract').value);
  const showBudget = () => {
    const c = contract(), bar = $('#dBudget');
    if (!c) { bar.hidden = true; return; }
    const amt = Number($('#dAmount').value) || 0, pct = Math.min(100, (c.used + amt) / c.limit * 100);
    bar.hidden = false;
    bar.querySelector('i').style.width = pct + '%';
    bar.querySelector('i').style.background = pct > 90 ? '#E3001B' : pct > 70 ? '#F39200' : '#2E9E4F';
    bar.querySelector('span').textContent = `派工後執行率 ${pct.toFixed(1)}%｜剩餘 ${(c.remaining - amt).toLocaleString()} 元`;
    $('#budgetRow span').textContent = `${c.id} 剩餘 ${c.remaining.toLocaleString()} 元`;
  };
  $('#dContract').onchange = showBudget;
  // 預算控管：超過契約剩餘額度時跳出警示並阻斷金額輸入
  $('#dAmount').oninput = () => {
    const c = contract(), amt = Number($('#dAmount').value);
    if (c && amt > c.remaining) {
      $('#dAmount').value = '';
      alertBox(`⚠️ 超過契約限額，已阻斷輸入`, `「${c.name}」剩餘額度為 ${c.remaining.toLocaleString()} 元，派工金額不得超過。<br>如需追加，請循程序辦理契約變更。`);
    }
    showBudget();
  };
  f.onsubmit = async e => {
    e.preventDefault();
    if (!$('#dLand').checked) return alertBox('請先完成地籍圖比對', '套疊地籍圖並確認案件位置屬公眾通行道路後，才能派工。');
    if (i._dup?.length && !$('#dApproval').value.trim()) return alertBox('須會勘並簽奉核可', `此位置 3 年內方圓 50 公尺內已有 ${i._dup.length} 件案件。依內控程序，須辦理會勘、查明根因並簽奉核可後始得派工，請填寫簽核文號。`);
    act('adminDispatch', { id: i.id, contractId: $('#dContract').value, amount: Number($('#dAmount').value), date: $('#dDate').value,
      landChecked: true, approvalNo: $('#dApproval').value.trim(), clientDup: !!i._dup?.length, reply: $('#dReply').value.trim() }, `${i.id} 已派工，並通知民眾`, () => loadContracts());
  };
}
function alertBox(title, html) {
  const el = document.createElement('div');
  el.className = 'alert-modal'; el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<div class="alert-card"><h3>${title}</h3><p>${html}</p><button class="btn primary" type="button">我知道了</button></div>`;
  document.body.appendChild(el);
  $('button', el).onclick = () => el.remove(); $('button', el).focus();
}

/* ---------------- 施工回報與驗收 ---------------- */
function reportSection(i) {
  if (!['已完工', '已驗收'].includes(i.status)) return '';
  const ph = i.photoHashes || {};
  return `<section class="dsec"><h3>🏗️ 施工回報與驗收</h3><dl>
    <dt>完工日期</dt><dd>${esc(rocDate(i.finishDate))}</dd><dt>回報時間</dt><dd>${fmtTime(i.reportTime)}</dd>
    <dt>驗收碼</dt><dd><b class="code">${esc(i.docCode)}</b> <a href="${AD.verifyUrl(i.docCode)}" target="_blank" rel="noopener">驗證頁</a></dd>
    <dt>照片組雜湊</dt><dd><small class="hash">${esc(i.setHash)}</small></dd>
    ${['before', 'during', 'after'].map(k => `<dt>${AD.KIND_NAME[k]}</dt><dd>${photoButtons(k, (ph[k] || []).length)}</dd>`).join('')}
    <dt>履約文件</dt><dd>${i.hasDoc ? '<button class="btn sm" type="button" id="openDoc">開啟文件</button>' : '無'}</dd>
    ${i.acceptDate ? `<dt>驗收</dt><dd>${esc(rocDate(i.acceptDate))}　${esc(i.acceptor || '')}</dd>` : ''}</dl>
    <div class="btn-row"><button class="btn" type="button" id="printDoc">🖨️ 產製施工照片（含 QR）</button></div>
    ${i.status === '已完工' && can('handler') ? `<div class="btn-row"><button class="btn danger" type="button" id="returnBtn">退回重做</button><button class="btn primary" type="button" id="acceptBtn">✔ 驗收通過</button></div>` : ''}
  </section>`;
}
function bindReport(i) {
  if ($('#openDoc')) $('#openDoc').onclick = async () => {
    try {
      const f = await getFile(i, 'doc', 0);
      const bytes = AD.dataUrlBytes(f.data), type = f.data.slice(5, f.data.indexOf(';'));
      window.open(URL.createObjectURL(new Blob([bytes], { type })), '_blank');
    } catch { toast('文件讀取失敗'); }
  };
  if ($('#printDoc')) $('#printDoc').onclick = async () => {
    toast('正在載入施工照片…');
    const photos = {}, hashes = {};
    for (const k of ['before', 'during', 'after']) {
      photos[k] = []; hashes[k] = [];
      for (let n = 0; n < (i.photoHashes?.[k] || []).length; n++) {
        try { const f = await getFile(i, k, n); photos[k].push(f.data); hashes[k].push(f.sha); } catch { /* 略過 */ }
      }
    }
    AD.printAcceptanceDoc({ item: i, photos, hashes, code: i.docCode, setHash: i.setHash });
  };
  if ($('#acceptBtn')) $('#acceptBtn').onclick = () => {
    if (confirm(`確認 ${i.id} 驗收通過並結案？系統將通知民眾。`)) act('adminAccept', { id: i.id }, `${i.id} 已驗收結案`);
  };
  if ($('#returnBtn')) $('#returnBtn').onclick = () => {
    const reason = prompt('退回原因（廠商可見，原驗收碼將作廢）');
    if (reason && reason.trim()) act('adminReturn', { id: i.id, reason: reason.trim() }, `${i.id} 已退回廠商`);
  };
}

async function act(action, body, okMsg, after) {
  try {
    const j = await api(action, body);
    if (!j.ok) { alertBox('無法完成', esc(j.error || '操作失敗')); return; }
    toast(okMsg);
    await load();
    if (after) after();
  } catch { toast('操作失敗，請稍後再試'); }
}

/* ---------------- 代為登錄（電話、里幹事協助，照顧數位弱勢） ---------------- */
$('#createBtn').onclick = () => {
  const d = $('#detail');
  S.sel = null;
  d.hidden = false;
  d.innerHTML = `<div class="detail-head"><h2>代為登錄案件</h2><span class="small muted">電話、里幹事、臨櫃或巡查發現</span><button class="info-close" aria-label="關閉">✕</button></div>
    <form class="detail-body" id="createForm">
      <label class="field">來源<select id="cSource"><option>電話通報</option><option>里幹事協助</option><option>臨櫃通報</option><option>巡查發現</option></select></label>
      <label class="field">類別<select id="cType">${C.issueTypes.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
      <label class="field">說明<textarea id="cDesc" rows="3" maxlength="500" required></textarea></label>
      <label class="field">位置 <button class="btn sm" type="button" id="cPick">在地圖點選</button><span class="small" id="cLoc">尚未選擇</span></label>
      <label class="field">民眾聯絡方式（不公開）<input id="cContact" maxlength="60"></label>
      <label class="field">民眾 Email（選填，進度通知）<input id="cEmail" type="email" maxlength="120"></label>
      <button class="btn primary full" type="submit">立案</button>
    </form>`;
  let ll = null;
  $('.info-close', d).onclick = () => { d.hidden = true; S.pick = null; $('#pickHint').hidden = true; };
  $('#cPick').onclick = () => {
    $('#pickHint').hidden = false;
    S.pick = latlng => {
      ll = latlng; S.pick = null; $('#pickHint').hidden = true;
      if (selMarker) map.removeLayer(selMarker);
      selMarker = L.marker(latlng).addTo(map);
      $('#cLoc').textContent = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
    };
  };
  $('#createForm').onsubmit = async e => {
    e.preventDefault();
    if (!ll) return toast('請在地圖點選位置');
    const village = villageAt(ll), road = nearestRoad(ll.lat, ll.lng);
    const j = await api('adminCreate', { source: $('#cSource').value, type: $('#cType').value, desc: $('#cDesc').value.trim(), lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6),
      village, road: road && road.d < 80 ? road.name : '', contact: $('#cContact').value.trim(), email: $('#cEmail').value.trim() }).catch(() => ({ ok: false }));
    if (!j.ok) return alertBox('立案失敗', esc(j.error || '請稍後再試'));
    if (selMarker) { map.removeLayer(selMarker); selMarker = null; }
    toast(`已立案 ${j.id}${j.nearby?.length ? `（附近有 ${j.nearby.length} 件重複案件）` : ''}`);
    await load(); openDetail(j.id, true);
  };
};
function villageAt(ll) {
  if (!S.villages) return '';
  const pt = [ll.lng, ll.lat];
  const inRing = r => { let c = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { const [xi, yi] = r[a], [xj, yj] = r[b]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
  const f = S.villages.features.find(f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).some(p => inRing(p[0])));
  return f ? f.properties.name : '';
}

/* ---------------- 開口契約 ---------------- */
function renderContracts() {
  $('#contractBody').innerHTML = S.contracts.map(c => {
    const pct = c.limit ? c.used / c.limit * 100 : 0;
    return `<tr><td>${esc(c.id)}</td><td>${esc(c.name)}</td><td>${esc(c.vendor)}</td><td>${esc(c.year)}</td><td class="num">${c.limit.toLocaleString()}</td>
      <td class="num">${c.used.toLocaleString()}</td><td class="num">${c.remaining.toLocaleString()}</td>
      <td><div class="budget-bar mini"><i style="width:${Math.min(100, pct)}%;background:${pct > 90 ? '#E3001B' : pct > 70 ? '#F39200' : '#2E9E4F'}"></i><span>${pct.toFixed(1)}%</span></div></td>
      <td>${esc(c.status)}</td><td>${can('admin') ? `<button class="link-btn" data-edit="${esc(c.id)}">編輯</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="10" class="muted">尚無契約</td></tr>';
  $$('[data-edit]').forEach(b => b.onclick = () => {
    const c = S.contracts.find(x => x.id === b.dataset.edit);
    $('#kId').value = c.id; $('#kName').value = c.name; $('#kVendor').value = c.vendor; $('#kYear').value = c.year; $('#kLimit').value = c.limit; $('#kStatus').value = c.status;
    $('#contractFormTitle').textContent = `編輯契約 ${c.id}`;
    $('#contractForm').scrollIntoView({ behavior: 'smooth' });
  });
  $('#vendorNames').innerHTML = [...new Set(S.contracts.map(c => c.vendor))].map(v => `<option value="${esc(v)}">`).join('');
}
$('#kReset').onclick = () => { $('#kId').value = ''; $('#contractFormTitle').textContent = '新增開口契約'; };
$('#contractForm').onsubmit = async e => {
  e.preventDefault();
  const j = await api('adminSaveContract', { id: $('#kId').value, name: $('#kName').value.trim(), vendor: $('#kVendor').value.trim(), year: $('#kYear').value.trim(),
    limit: Number($('#kLimit').value), status: $('#kStatus').value }).catch(() => ({ ok: false }));
  if (!j.ok) return alertBox('無法儲存', esc(j.error || '請稍後再試'));
  toast(`契約 ${j.id} 已儲存`); $('#contractForm').reset(); $('#kId').value = ''; $('#contractFormTitle').textContent = '新增開口契約';
  loadContracts();
};

/* ---------------- 帳號（管理者） ---------------- */
async function loadAccounts() {
  const j = await api('adminAccounts').catch(() => ({ items: [] }));
  $('#accountBody').innerHTML = (j.items || []).map(a => `<tr><td>${esc(a.user)}</td><td>${ROLE_NAME[a.role] || esc(a.role)}</td><td>${esc(a.vendor)}</td>
    <td>${a.disabled ? '<span style="color:#E3001B">停用</span>' : '啟用'}</td>
    <td><button class="link-btn" data-acc="${esc(a.user)}">編輯</button>${a.user !== session.user ? ` <button class="link-btn danger" data-del="${esc(a.user)}">刪除</button>` : ''}</td></tr>`).join('');
  $$('[data-acc]').forEach(b => b.onclick = () => {
    const a = j.items.find(x => x.user === b.dataset.acc);
    $('#aUser').value = a.user; $('#aRole').value = a.role; $('#aVendor').value = a.vendor; $('#aPwd').value = ''; $('#aDisabled').checked = a.disabled;
  });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm(`確定刪除帳號 ${b.dataset.del}？`)) return;
    const r = await api('adminDeleteAccount', { user: b.dataset.del }).catch(() => ({ ok: false }));
    r.ok ? (toast('已刪除'), loadAccounts()) : alertBox('無法刪除', esc(r.error || ''));
  });
}
$('#accountForm').onsubmit = async e => {
  e.preventDefault();
  const r = await api('adminSaveAccount', { user: $('#aUser').value.trim().toLowerCase(), role: $('#aRole').value, vendor: $('#aVendor').value.trim(),
    password: $('#aPwd').value, disabled: $('#aDisabled').checked }).catch(() => ({ ok: false }));
  if (!r.ok) return alertBox('無法儲存', esc(r.error || ''));
  toast('帳號已儲存'); $('#accountForm').reset(); loadAccounts();
};

/* ---------------- 設定（管理者） ---------------- */
async function loadSettings() {
  const j = await api('adminSettings').catch(() => ({}));
  $('#sEmails').value = j.notifyEmails || ''; $('#sSite').value = j.siteUrl || '';
  $('#sLine').placeholder = j.lineTokenSet ? '已設定（不顯示）' : '未設定';
  $('#webhookUrl').textContent = C.reportEndpoint;
}
$('#settingsForm').onsubmit = async e => {
  e.preventDefault();
  const j = await api('adminSettings', { save: true, notifyEmails: $('#sEmails').value, siteUrl: $('#sSite').value, lineToken: $('#sLine').value, clearLineToken: $('#sLineClear').checked }).catch(() => ({ ok: false }));
  if (!j.ok) return alertBox('無法儲存', esc(j.error || ''));
  $('#sLine').value = ''; $('#sLineClear').checked = false; toast('設定已儲存'); loadSettings();
};

/* ---------------- 數位軌跡（管理者） ---------------- */
async function loadChain() {
  $('#chainBody').innerHTML = '<tr><td colspan="7">載入中…</td></tr>';
  const j = await api('adminLog').catch(() => ({ items: [] }));
  const v = j.verify || {};
  $('#chainStatus').innerHTML = v.ok
    ? `<div class="chain-ok">✔ 雜湊鏈完整：共 ${v.count} 筆，最新雜湊 <code>${esc(String(v.head).slice(0, 16))}…</code></div>`
    : `<div class="chain-bad">✖ 雜湊鏈在第 ${esc(v.brokenAt)} 筆斷裂：資料可能遭竄改，請立即查明</div>`;
  $('#chainBody').innerHTML = (j.items || []).map(r => `<tr><td>${r.seq}</td><td>${fmtTime(r.time)}</td><td>${esc(r.user)}</td><td>${esc(r.event)}</td><td>${esc(r.id)}</td>
    <td class="wrap">${esc(String(r.detail).slice(0, 120))}</td><td><code>${esc(String(r.hash).slice(0, 12))}</code></td></tr>`).join('');
}

/* ---------------- 分頁 ---------------- */
$$('.tb-tabs [data-view]').forEach(b => b.onclick = () => {
  $$('.tb-tabs [data-view]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  const v = b.dataset.view;
  ['cases', 'contracts', 'accounts', 'settings', 'chain'].forEach(n => { $('#view-' + n).hidden = n !== v; });
  if (v === 'cases') setTimeout(() => map.invalidateSize(), 50);
  if (v === 'contracts') loadContracts();
  if (v === 'accounts') loadAccounts();
  if (v === 'settings') loadSettings();
  if (v === 'chain') loadChain();
});

/* ---------------- 匯出（管理者） ---------------- */
$('#exportBtn').onclick = () => AD.downloadCSV(
  [['案號', '立案時間', '來源', '類別', '說明', '里別', '鄰近道路', '緯度', '經度', '聯絡方式', 'Email', '狀態', '處理說明', '契約', '廠商', '派工金額', '派工日期', '完工日期', '驗收日期', '驗收碼', '評分']]
    .concat(filtered().map(i => [i.id, fmtTime(i.time), i.source, i.type, i.desc, i.village, i.road, i.lat, i.lng, i.contact, i.email, i.status, i.reply, i.contractId, i.vendor, i.amount, i.dispatchDate, i.finishDate, i.acceptDate, i.docCode, i.rating])),
  `安定區道路案件_${today()}.csv`);

addEventListener('keydown', e => { if (e.key === 'Escape') { $('.lightbox')?.remove(); $('.alert-modal')?.remove(); } });
if (session) enterApp();
})();
