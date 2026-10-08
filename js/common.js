/* 共用工具：網站、後台、廠商回報中心、驗證頁共用 */
(() => {
'use strict';
const C = window.APP_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''; };
const rocDate = s => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? s : `${d.getFullYear() - 1911}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };

if (window.proj4) proj4.defs('EPSG:3826', '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
const toTWD97 = (lat, lng) => proj4('EPSG:4326', 'EPSG:3826', [Number(lng), Number(lat)]);

const STATUS = {
  '已立案': { color: '#E3001B', step: 1 }, '已派工': { color: '#F39200', step: 2 }, '已完工': { color: '#1C5FC4', step: 3 },
  '已驗收': { color: '#2E9E4F', step: 4 }, '不受理': { color: '#8C96A8', step: 0 },
  // 舊版狀態相容
  '待處理': { color: '#E3001B', step: 1 }, '處理中': { color: '#F39200', step: 2 }, '已完成': { color: '#2E9E4F', step: 4 },
};
const statusColor = s => (STATUS[s] || { color: '#8C96A8' }).color;

let toastTimer;
function toast(msg, ms = 2800) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- 後端 API ---------- */
async function apiPost(action, body = {}) {
  if (!C.reportEndpoint) throw new Error('未設定後端');
  const res = await fetch(C.reportEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 簡單請求，Apps Script 不支援 CORS 預檢
    body: JSON.stringify({ action, ...body }), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  return res.json();
}
async function apiGet(params) {
  if (!C.reportEndpoint) throw new Error('未設定後端');
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${C.reportEndpoint}?${q}`, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  return res.json();
}

/* ---------- 防機器人驗證碼 ---------- */
function captchaWidget(box) {
  box.innerHTML = `<div class="captcha"><img alt="驗證碼圖片：請輸入圖中 4 個數字" width="150" height="54"><button type="button" class="btn ghost sm" aria-label="換一張">↻</button>
    <input inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="輸入圖中數字" aria-label="驗證碼" autocomplete="off"></div>`;
  const img = $('img', box), input = $('input', box);
  let token = '';
  async function refresh() {
    input.value = ''; img.style.opacity = .4;
    try { const j = await apiGet({ action: 'captcha' }); token = j.token; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(j.svg); }
    catch { toast('驗證碼載入失敗，請檢查網路'); }
    img.style.opacity = 1;
  }
  $('button', box).onclick = refresh;
  refresh();
  return { refresh, get: () => ({ captcha: token, answer: input.value.trim() }), input };
}

/* ---------- 圖片與檔案 ---------- */
function loadImage(src) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
}
async function shrinkImage(file, max = 1280, q = .8) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);   // 重新編碼同時移除 EXIF（含 GPS）
  } finally { URL.revokeObjectURL(url); }
}
const fileToDataURL = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
function dataUrlBytes(dataUrl) {
  const b = atob(String(dataUrl).split(',')[1] || '');
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
async function sha256Hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function downloadCSV(rows, name) {
  // 開頭為 = + - @ 的儲存格加上單引號，避免在 Excel 被當成公式執行
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 去識別化開放資料 CSV（資料開放） ---------- */
function openDataRows(items) {
  const head = ['案件編號', '通報日期', '派工日期', '完工日期', '驗收日期', 'TWD97_X', 'TWD97_Y', 'WGS84_經度', 'WGS84_緯度', '里別', '搶修類型', '處理狀態', '施工廠商', '決標金額(元)', '民眾評分'];
  return [head].concat(items.map(i => {
    const t = i.lat ? toTWD97(i.lat, i.lng) : ['', ''];
    return [i.id, i.date || (i.time || '').slice(0, 10), i.dispatchDate, i.finishDate, i.acceptDate, t[0] && t[0].toFixed(1), t[1] && t[1].toFixed(1),
      i.lng, i.lat, i.village, i.type, i.status, i.vendor, i.amount, i.rating];
  }));
}

/* ---------- 一鍵產製施工前中後照片（含 QR-Code 數位防偽驗收鏈） ---------- */
const KIND_NAME = { before: '施工前', during: '施工中', after: '施工後' };
function verifyUrl(code) { return new URL(`verify.html?c=${code}`, location.href).href; }
function qrSvg(text, cell = 4) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}
function printAcceptanceDoc({ item, photos, hashes, code, setHash }) {
  const w = window.open('', '_blank');
  if (!w) { toast('請允許彈出視窗以產製文件'); return; }
  const url = verifyUrl(code);
  const t = item.lat ? toTWD97(item.lat, item.lng) : null;
  const section = k => (photos[k] || []).length ? `<h2>${KIND_NAME[k]}</h2><div class="grid">${photos[k].map((p, n) =>
    `<figure><img src="${p}"><figcaption>${KIND_NAME[k]} ${n + 1}｜指紋 ${esc((hashes[k][n] || '').slice(0, 12))}</figcaption></figure>`).join('')}</div>` : '';
  w.document.write(`<!doctype html><meta charset="utf-8"><title>施工照片及履約證明 ${esc(item.id)}</title>
  <style>@page{size:A4;margin:14mm}body{font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif;color:#1B2A4A;margin:0}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:4px solid #E3001B;padding-bottom:8px}
  h1{color:#1C5FC4;font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:14px 0 6px;border-left:6px solid #F39200;padding-left:8px}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}td,th{border:1px solid #1B2A4A;padding:5px 7px;text-align:left}th{background:#FBF6EC;width:90px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}figure{margin:0;break-inside:avoid}img{width:100%;height:62mm;object-fit:cover;border:1px solid #999}
  figcaption{font-size:11px;color:#5E6A80;font-family:monospace}.qr{text-align:center;font-size:11px}.qr svg{width:34mm;height:34mm}
  .foot{font-size:11px;color:#5E6A80;margin-top:12px;border-top:1px dashed #999;padding-top:6px;word-break:break-all}</style>
  <header><div><h1>${esc(C.district || '')}公眾通行道路 施工照片及履約證明</h1>
  <div>案號 <b>${esc(item.id)}</b>｜驗收碼 <b>${esc(code)}</b></div></div>
  <div class="qr">${qrSvg(url)}<br>掃描驗證真偽</div></header>
  <table><tr><th>類別</th><td>${esc(item.type)}</td><th>里別／道路</th><td>${esc(item.village || '')} ${esc(item.road || '')}</td></tr>
  <tr><th>施工廠商</th><td>${esc(item.vendor || '')}</td><th>派工金額</th><td>${item.amount ? Number(item.amount).toLocaleString() + ' 元' : ''}</td></tr>
  <tr><th>派工日期</th><td>${esc(rocDate(item.dispatchDate))}</td><th>完工日期</th><td>${esc(rocDate(item.finishDate))}</td></tr>
  <tr><th>座標</th><td colspan="3">WGS84 ${esc(item.lat)}, ${esc(item.lng)}${t ? `｜TWD97 ${t[0].toFixed(0)}, ${t[1].toFixed(0)}` : ''}</td></tr></table>
  ${section('before')}${section('during')}${section('after')}
  <div class="foot">照片組雜湊（SHA-256）：${esc(setHash)}<br>本文件於回報當下產製唯一驗收碼，並與上列照片的數位指紋綁定。掃描 QR-Code 可比對資料庫原始照片；任何照片遭替換，指紋即無法相符。<br>驗證網址：${esc(url)}</div>
  <script>window.onload=()=>setTimeout(()=>print(),500)<\/script>`);
  w.document.close();
}

window.AD = { C, $, esc, fmtTime, rocDate, toTWD97, STATUS, statusColor, toast, apiPost, apiGet, captchaWidget, loadImage, shrinkImage, fileToDataURL,
  dataUrlBytes, sha256Hex, downloadCSV, openDataRows, printAcceptanceDoc, verifyUrl, qrSvg, KIND_NAME };
})();
