/* =========================================================
   安定區道路通報管理後台
   權限由後端（Google Apps Script）驗證；前端不含任何密碼或金鑰。
   ========================================================= */
(() => {
'use strict';

const C = window.APP_CONFIG;
const API = C.reportEndpoint;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''; };
const ROLE_NAME = { viewer: '檢視者', handler: '承辦人', admin: '管理者' };
const LEVEL = { viewer: 1, handler: 2, admin: 3 };
const STATUS_COLOR = { '待處理': '#E3001B', '處理中': '#F39200', '已完成': '#2E9E4F', '不受理': '#8C96A8' };
proj4.defs('EPSG:3826', '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs');

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------- 工作階段（sessionStorage：關閉分頁即登出） ---------------- */
const SESSION_KEY = 'ad.adminSession';
let session = null;
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
if (session && session.exp < Date.now()) session = null;

function saveSession(s) { session = s; try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* 無痕 */ } }

async function api(action, body = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 簡單請求，Apps Script 不支援 CORS 預檢
    body: JSON.stringify({ action, token: session?.token, ...body }),
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  const j = await res.json();
  if (!j.ok && j.auth) { logout(j.error || '請重新登入'); throw new Error(j.error); }
  return j;
}

/* ---------------- 登入 ---------------- */
if (!API) {
  $('#loginMsg').textContent = '尚未設定通報後端（js/config.js 的 reportEndpoint），後台無法使用。';
  $('#loginBtn').disabled = true;
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('#loginBtn');
  btn.disabled = true; btn.textContent = '驗證中…'; $('#loginMsg').textContent = '';
  try {
    const j = await api('login', { user: $('#user').value.trim(), pwd: $('#pwd').value });
    if (!j.ok) { $('#loginMsg').textContent = j.error || '登入失敗'; return; }
    saveSession({ token: j.token, user: j.user, role: j.role, exp: j.exp });
    $('#pwd').value = '';
    enterApp();
  } catch (err) {
    $('#loginMsg').textContent = '無法連線到後端，請稍後再試';
  } finally {
    btn.disabled = false; btn.textContent = '登入';
  }
};

let expTimer;
function logout(msg) {
  saveSession(null);
  clearInterval(expTimer);
  $('#appView').hidden = true; $('#loginView').hidden = false;
  $('#detail').hidden = true;
  S.items = [];
  if (msg) $('#loginMsg').textContent = msg;
}
$('#logoutBtn').onclick = () => logout('已登出');

/* ---------------- 主畫面 ---------------- */
const S = { items: [], status: '', sel: null, statuses: ['待處理', '處理中', '已完成', '不受理'] };
let map, markers = L.layerGroup();

function enterApp() {
  $('#loginView').hidden = true; $('#appView').hidden = false;
  $('#userName').textContent = session.user;
  const rb = $('#roleBadge'); rb.textContent = ROLE_NAME[session.role] || session.role; rb.className = 'role-badge ' + session.role;
  $('#exportBtn').hidden = LEVEL[session.role] < LEVEL.admin;
  $('#logTabBtn').hidden = LEVEL[session.role] < LEVEL.admin;
  const tick = () => {
    const left = session.exp - Date.now();
    if (left <= 0) return logout('登入逾時，請重新登入');
    $('#expireHint').textContent = `${Math.floor(left / 3600e3)} 時 ${Math.floor(left % 3600e3 / 60e3)} 分後自動登出`;
  };
  tick(); clearInterval(expTimer); expTimer = setInterval(tick, 30e3);
  initMap();
  load();
}

function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  map = L.map('adminMap', { zoomControl: false, preferCanvas: true }).setView(C.center, C.zoom);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, className: 'tile-warm', attribution: '© 國土測繪中心' }).addTo(map);
  markers.addTo(map);
  Promise.all([fetch('data/boundary.geojson').then(r => r.json()), fetch('data/villages.geojson').then(r => r.json())]).then(([b, v]) => {
    L.geoJSON(v, { style: { color: '#1C5FC4', weight: 1, dashArray: '3 5', fill: false }, interactive: false }).addTo(map);
    const lyr = L.geoJSON(b, { style: { color: '#E3001B', weight: 2.5, dashArray: '10 6', fill: false }, interactive: false }).addTo(map);
    if (!S.items.length) map.fitBounds(lyr.getBounds(), { padding: [10, 10] });
    S.villageNames = v.features.map(f => f.properties.name);
    fillSelect('#fVillage', S.villageNames);
  });
  setTimeout(() => map.invalidateSize(), 50);
}

async function load() {
  $('#caseList').innerHTML = '<li class="muted">載入中…</li>';
  try {
    const j = await api('adminList');
    if (!j.ok) { toast(j.error || '讀取失敗'); return; }
    S.items = (j.items || []).sort((a, b) => String(b.time).localeCompare(String(a.time)));
    if (j.statuses) S.statuses = j.statuses;
    fillSelect('#fType', [...new Set(C.issueTypes.concat(S.items.map(i => i.type)))]);
    render();
  } catch (err) {
    if (session) { $('#caseList').innerHTML = '<li class="muted">無法連線到後端</li>'; }
  }
}
$('#refreshBtn').onclick = load;

function fillSelect(sel, values) {
  const el = $(sel), cur = el.value, first = el.options[0].outerHTML;
  el.innerHTML = first + values.filter(Boolean).map(v => `<option>${esc(v)}</option>`).join('');
  el.value = cur;
}

function filtered() {
  const q = $('#fq').value.trim().toLowerCase(), t = $('#fType').value, v = $('#fVillage').value;
  const from = $('#fFrom').value, to = $('#fTo').value;
  return S.items.filter(i => {
    const day = i.time ? new Date(i.time).toLocaleDateString('sv-SE') : '';
    return (!S.status || i.status === S.status) && (!t || i.type === t) && (!v || i.village === v) &&
      (!from || day >= from) && (!to || day <= to) &&
      (!q || `${i.id} ${i.desc} ${i.road} ${i.village} ${i.contact} ${i.reply}`.toLowerCase().includes(q));
  });
}

function render() {
  // 統計
  const count = s => S.items.filter(i => i.status === s).length;
  $('#kpis').innerHTML = S.statuses.map(s => `<div class="kpi ${S.status === s ? 'on' : ''}" data-s="${esc(s)}" role="button" tabindex="0"><b style="color:${STATUS_COLOR[s] || '#1B2A4A'}">${count(s)}</b><span>${esc(s)}</span></div>`).join('') +
    `<div class="kpi ${!S.status ? 'on' : ''}" data-s="" role="button" tabindex="0"><b>${S.items.length}</b><span>全部</span></div>`;
  $$('.kpi').forEach(k => { k.onclick = () => { S.status = k.dataset.s; render(); }; k.onkeydown = e => { if (e.key === 'Enter') k.click(); }; });

  const list = filtered();
  $('#resultCount').textContent = `共 ${list.length} 件`;
  $('#caseList').innerHTML = list.length ? list.map(i => `
    <li class="case-card ${S.sel?.id === i.id ? 'sel' : ''}" data-id="${esc(i.id)}" tabindex="0">
      <span class="t">${esc(i.type)}・${esc(i.village || '—')}</span><span class="st st-${esc(i.status)}">${esc(i.status)}</span>
      <span class="d">${esc(i.desc || '（無說明）')}</span>
      <span class="m">${esc(i.id)}・${fmtTime(i.time)}${i.photos ? `・📷${i.photos}` : ''}${i.handler ? `・${esc(i.handler)}` : ''}</span>
    </li>`).join('') : '<li class="muted empty">沒有符合條件的案件</li>';
  $$('.case-card').forEach(li => { li.onclick = () => openDetail(li.dataset.id, true); li.onkeydown = e => { if (e.key === 'Enter') li.click(); }; });

  markers.clearLayers();
  list.filter(i => i.lat && i.lng).forEach(i => {
    L.marker([i.lat, i.lng], {
      icon: L.divIcon({ className: 'admin-marker' + (S.sel?.id === i.id ? ' sel' : ''), html: `<span style="background:${STATUS_COLOR[i.status] || '#8C96A8'}"></span>`, iconSize: [22, 22] }),
      title: `${i.id} ${i.type}`, zIndexOffset: S.sel?.id === i.id ? 1000 : 0,
    }).on('click', () => openDetail(i.id, false)).addTo(markers);
  });
}
['#fq', '#fType', '#fVillage', '#fFrom', '#fTo'].forEach(s => $(s).addEventListener('input', render));

/* ---------------- 案件詳細 ---------------- */
function openDetail(id, fly) {
  const i = S.items.find(x => x.id === id);
  if (!i) return;
  S.sel = i;
  const canEdit = LEVEL[session.role] >= LEVEL.handler;
  const t = i.lat ? proj4('EPSG:4326', 'EPSG:3826', [Number(i.lng), Number(i.lat)]) : null;
  const d = $('#detail');
  d.innerHTML = `
    <div class="detail-head"><span class="st st-${esc(i.status)}">${esc(i.status)}</span>
      <h2>${esc(i.type)}</h2><span class="small muted">${esc(i.id)}</span>
      <button class="info-close" aria-label="關閉">✕</button></div>
    <div class="detail-body">
      <dl>
        <dt>通報時間</dt><dd>${fmtTime(i.time)}</dd>
        <dt>位置</dt><dd>${esc(i.village || '—')}${i.road ? `・${esc(i.road)}` : ''}<br>
          <small>WGS84 ${esc(i.lat)}, ${esc(i.lng)}${t ? `<br>TWD97 ${t[0].toFixed(0)}, ${t[1].toFixed(0)}` : ''}</small><br>
          <a href="https://www.google.com/maps?q=${Number(i.lat)},${Number(i.lng)}" target="_blank" rel="noopener noreferrer">Google 地圖</a>｜<a href="./#tools" target="_blank" rel="noopener">圖資系統</a></dd>
        <dt>說明</dt><dd>${esc(i.desc || '（無）')}</dd>
        <dt>聯絡方式</dt><dd>${esc(i.contact || '（未填）')}${session.role === 'viewer' && i.contact ? '<br><small class="muted">檢視者僅顯示遮罩資料</small>' : ''}</dd>
        <dt>照片</dt><dd>${i.photos ? `<div class="photos">${Array.from({ length: i.photos }, (_, n) => `<button type="button" data-n="${n}">載入照片 ${n + 1}</button>`).join('')}</div>` : '無'}</dd>
        <dt>處理人</dt><dd>${esc(i.handler || '—')}${i.updated ? `<br><small>${fmtTime(i.updated)}</small>` : ''}</dd>
        <dt>處理說明</dt><dd>${esc(i.reply || '—')}</dd>
      </dl>
      ${canEdit ? `
      <form class="update-box" id="updForm">
        <h3>更新處理狀態</h3>
        <div class="seg" id="stSeg">${S.statuses.map(s => `<button type="button" data-s="${esc(s)}" class="${s === i.status ? 'on' : ''}">${esc(s)}</button>`).join('')}</div>
        <label class="field">處理說明（會公開於通報看板）<textarea id="replyText" rows="3" maxlength="300">${esc(i.reply || '')}</textarea></label>
        <button class="btn primary full" type="submit">儲存</button>
      </form>` : '<p class="small muted" style="margin-top:12px">檢視者無法修改案件狀態。</p>'}
    </div>`;
  d.hidden = false;
  $('.info-close', d).onclick = () => { d.hidden = true; S.sel = null; render(); };
  $$('.photos button', d).forEach(b => b.onclick = () => loadPhoto(i, +b.dataset.n, b));
  if (canEdit) {
    let st = i.status;
    $$('#stSeg button').forEach(b => b.onclick = () => { st = b.dataset.s; $$('#stSeg button').forEach(x => x.classList.toggle('on', x === b)); });
    $('#updForm').onsubmit = async e => {
      e.preventDefault();
      const btn = $('#updForm button[type=submit]'); btn.disabled = true; btn.textContent = '儲存中…';
      try {
        const j = await api('adminUpdate', { id: i.id, status: st, reply: $('#replyText').value.trim() });
        if (!j.ok) { toast(j.error || '儲存失敗'); return; }
        Object.assign(i, { status: st, reply: $('#replyText').value.trim(), handler: j.handler, updated: j.updated });
        toast(`${i.id} 已更新為「${st}」`);
        render(); openDetail(i.id, false);
      } catch { toast('儲存失敗，請稍後再試'); } finally { btn.disabled = false; btn.textContent = '儲存'; }
    };
  }
  if (fly && i.lat) {
    // 詳細面板蓋住地圖右側，目標點往左偏移半個面板寬
    const z = Math.max(map.getZoom(), 16), panel = matchMedia('(max-width: 820px)').matches ? 0 : d.offsetWidth / 2;
    map.flyTo(map.unproject(map.project([i.lat, i.lng], z).add([panel, 0]), z), z, { duration: .6 });
  }
  render();
}

const photoCache = {};
async function loadPhoto(item, n, btn) {
  const key = item.id + ':' + n;
  btn.textContent = '載入中…';
  try {
    if (!photoCache[key]) {
      const j = await api('adminPhoto', { id: item.id, n });
      if (!j.ok) { btn.textContent = '讀取失敗'; return; }
      photoCache[key] = j.data;
    }
    btn.innerHTML = `<img src="${photoCache[key]}" alt="通報照片 ${n + 1}">`;
    btn.onclick = () => {
      const lb = document.createElement('div'); lb.className = 'lightbox';
      lb.innerHTML = `<img src="${photoCache[key]}" alt="">`;
      lb.onclick = () => lb.remove(); document.body.appendChild(lb);
    };
  } catch { btn.textContent = '讀取失敗'; }
}

/* ---------------- 匯出（管理者） ---------------- */
$('#exportBtn').onclick = () => {
  const rows = [['案號', '通報時間', '類別', '說明', '里別', '鄰近道路', '緯度', '經度', '聯絡方式', '照片數', '狀態', '處理說明', '處理人', '更新時間']]
    .concat(filtered().map(i => [i.id, fmtTime(i.time), i.type, i.desc, i.village, i.road, i.lat, i.lng, i.contact, i.photos, i.status, i.reply, i.handler, fmtTime(i.updated)]));
  // 開頭為 = + - @ 的儲存格加上單引號，避免在 Excel 被當成公式執行
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `安定區道路通報_${new Date().toLocaleDateString('sv-SE')}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ---------------- 操作紀錄（管理者） ---------------- */
$$('.tb-tabs [data-view]').forEach(b => b.onclick = async () => {
  $$('.tb-tabs [data-view]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  const v = b.dataset.view;
  $('#casesView').hidden = v !== 'cases'; $('#logView').hidden = v !== 'log';
  if (v === 'cases') setTimeout(() => map.invalidateSize(), 50);
  if (v === 'log') {
    $('#logBody').innerHTML = '<tr><td colspan="4">載入中…</td></tr>';
    try {
      const j = await api('adminLog');
      $('#logBody').innerHTML = (j.items || []).map(r => `<tr><td>${fmtTime(r.time)}</td><td>${esc(r.user)}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join('') || '<tr><td colspan="4">尚無紀錄</td></tr>';
    } catch { $('#logBody').innerHTML = '<tr><td colspan="4">讀取失敗</td></tr>'; }
  }
});

addEventListener('keydown', e => { if (e.key === 'Escape') { $('.lightbox')?.remove(); } });

if (session) enterApp();
})();
