/* =========================================================
   廠商回報中心：派工清單、精準導航、無紙化上傳履約證明、QR-Code 數位防偽驗收鏈
   ========================================================= */
(() => {
'use strict';

const { C, $, esc, fmtTime, rocDate, toTWD97, statusColor, toast, apiPost } = window.AD;
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const KINDS = ['before', 'during', 'after'];

const SESSION_KEY = 'ad.vendorSession';
let session = null;
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
if (session && session.exp < Date.now()) session = null;
function saveSession(s) { session = s; try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* 無痕 */ } }

async function api(action, body = {}) {
  const j = await apiPost(action, { token: session?.token, ...body });
  if (!j.ok && j.auth) { logout(j.error || '請重新登入'); throw new Error(j.error); }
  return j;
}

if (!C.reportEndpoint) { $('#loginMsg').textContent = '尚未設定後端，回報中心無法使用。'; $('#loginBtn').disabled = true; }
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = '驗證中…'; $('#loginMsg').textContent = '';
  try {
    const j = await apiPost('login', { user: $('#user').value.trim(), pwd: $('#pwd').value });
    if (!j.ok) { $('#loginMsg').textContent = j.error || '登入失敗'; return; }
    if (j.role !== 'vendor') { $('#loginMsg').innerHTML = '公所人員請使用 <a href="admin.html">管理後台</a>'; return; }
    saveSession({ token: j.token, user: j.user, vendor: j.vendor, exp: j.exp });
    $('#pwd').value = '';
    enter();
  } catch { $('#loginMsg').textContent = '無法連線到後端，請稍後再試'; }
  finally { btn.disabled = false; btn.textContent = '登入'; }
};
function logout(msg) {
  saveSession(null);
  $('#appView').hidden = true; $('#loginView').hidden = false;
  if (msg) $('#loginMsg').textContent = msg;
}
$('#logoutBtn').onclick = () => logout('已登出');

const S = { items: [], status: '已派工', sel: null, upload: null };
function enter() {
  $('#loginView').hidden = true; $('#appView').hidden = false;
  $('#vendorName').textContent = session.vendor;
  load();
}
async function load() {
  $('#caseList').innerHTML = '<li class="muted">載入中…</li>';
  try {
    const j = await api('vendorList');
    S.items = (j.items || []).sort((a, b) => String(a.dispatchDate).localeCompare(String(b.dispatchDate)));
    render();
    if (S.sel) openCase(S.sel);
  } catch { if (session) $('#caseList').innerHTML = '<li class="muted">無法連線到後端</li>'; }
}
$('#refreshBtn').onclick = load;
$$('#vTabs [data-s]').forEach(b => b.onclick = () => { S.status = b.dataset.s; $$('#vTabs [data-s]').forEach(x => x.setAttribute('aria-selected', String(x === b))); render(); });
['#fFrom', '#fTo'].forEach(s => $(s).oninput = render);

function render() {
  const from = $('#fFrom').value, to = $('#fTo').value;
  const list = S.items.filter(i => i.status === S.status && (!from || i.dispatchDate >= from) && (!to || i.dispatchDate <= to));
  $$('#vTabs [data-s]').forEach(b => { b.textContent = b.textContent.replace(/（\d+）$/, '') + `（${S.items.filter(i => i.status === b.dataset.s).length}）`; });
  $('#caseList').innerHTML = list.map(i => `<li class="case-card ${S.sel === i.id ? 'sel' : ''}" data-id="${esc(i.id)}" tabindex="0">
    <span class="t">${esc(i.type)}・${esc(i.village)}</span><span class="st" style="background:${statusColor(i.status)}">${esc(i.status)}</span>
    <span class="d">${esc(i.road || '')}　派工 ${esc(rocDate(i.dispatchDate))}　${Number(i.amount).toLocaleString()} 元</span>
    <span class="m">${esc(i.id)}${i.reply && i.reply.startsWith('驗收退回') ? '・<b style="color:#E3001B">被退回</b>' : ''}</span></li>`).join('') || '<li class="muted empty">沒有案件</li>';
  $$('.case-card').forEach(li => { li.onclick = () => openCase(li.dataset.id); li.onkeydown = e => { if (e.key === 'Enter') li.click(); }; });
}

function openCase(id) {
  const i = S.items.find(x => x.id === id);
  if (!i) return;
  S.sel = id; render();
  const t = toTWD97(i.lat, i.lng);
  const d = $('#detail');
  d.innerHTML = `<div class="card">
    <span class="st" style="background:${statusColor(i.status)}">${esc(i.status)}</span>
    <h2 style="margin-top:6px">${esc(i.type)}｜${esc(i.id)}</h2>
    <dl class="case-dl" style="margin-top:8px">
      <dt>位置</dt><dd>${esc(i.village)}・${esc(i.road || '')}<br><small>WGS84 ${esc(i.lat)}, ${esc(i.lng)}｜TWD97 ${t[0].toFixed(1)}, ${t[1].toFixed(1)}</small></dd>
      <dt>派工日期</dt><dd>${esc(rocDate(i.dispatchDate))}</dd><dt>派工金額</dt><dd>${Number(i.amount).toLocaleString()} 元</dd>
      <dt>民眾描述</dt><dd>${esc(i.desc || '—')}</dd>
      ${i.reply ? `<dt>公所說明</dt><dd style="${i.reply.startsWith('驗收退回') ? 'color:#E3001B;font-weight:700' : ''}">${esc(i.reply)}</dd>` : ''}
      <dt>現場照片</dt><dd>${i.citizenPhotos ? `<div class="photos">${Array.from({ length: i.citizenPhotos }, (_, n) => `<button type="button" data-n="${n}">載入 ${n + 1}</button>`).join('')}</div>` : '無'}</dd>
    </dl>
    <div class="btn-row"><a class="btn primary" href="https://www.google.com/maps/dir/?api=1&destination=${Number(i.lat)},${Number(i.lng)}&travelmode=driving" target="_blank" rel="noopener">🧭 精準導航到現場</a></div>
  </div>
  ${i.status === '已派工' ? uploadForm(i) : doneCard(i)}`;
  $$('.photos button', d).forEach(b => b.onclick = async () => {
    b.textContent = '載入中…';
    const j = await api('vendorPhoto', { id: i.id, kind: 'citizen', n: +b.dataset.n }).catch(() => ({ ok: false }));
    b.innerHTML = j.ok ? `<img src="${j.data}" alt="">` : '讀取失敗';
  });
  if (i.status === '已派工') bindUpload(i); else bindDone(i);
}

/* ---------------- 上傳履約證明 ---------------- */
function uploadForm(i) {
  return `<form class="card" id="upForm"><h2>完工回報（無紙化）</h2>
    <p class="muted">照片會先在您的裝置上做 AI 去識別化（遮蔽人臉、車牌），再上傳。送出後系統會產生唯一驗收碼與 QR-Code，並自動通知民眾。</p>
    ${KINDS.map(k => `<div class="kind-block"><b>${AD.KIND_NAME[k]}照片${k === 'during' ? '（選填）' : '（至少 1 張）'}</b>
      <label class="btn sm"><input type="file" accept="image/*" multiple hidden data-kind="${k}">＋ 加入照片</label>
      <div class="thumbs" data-thumbs="${k}"></div></div>`).join('')}
    <label class="field">履約證明文件（選填，PDF 或圖片，5MB 內）<input type="file" id="docFile" accept="application/pdf,image/jpeg,image/png"></label>
    <label class="field">完工日期<input type="date" id="finishDate" required max="${new Date().toLocaleDateString('sv-SE')}" value="${new Date().toLocaleDateString('sv-SE')}"></label>
    <button class="btn primary full" type="submit" id="upBtn">📤 送出完工回報</button></form>`;
}
function bindUpload(i) {
  S.upload = { before: [], during: [], after: [] };
  const draw = k => {
    $(`[data-thumbs="${k}"]`).innerHTML = S.upload[k].map((p, n) => `<figure><img src="${p}" alt=""><button type="button" data-rm="${k}:${n}" aria-label="移除">✕</button><span class="gps">已去識別化</span></figure>`).join('');
    $$(`[data-rm^="${k}:"]`).forEach(b => b.onclick = () => { S.upload[k].splice(+b.dataset.rm.split(':')[1], 1); draw(k); });
  };
  $$('input[data-kind]').forEach(inp => inp.onchange = async () => {
    const k = inp.dataset.kind;
    for (const f of [...inp.files].slice(0, 4 - S.upload[k].length)) {
      const r = await Deid.open(f, { title: `${AD.KIND_NAME[k]}照片去識別化` }).catch(() => null);
      if (r) S.upload[k].push(r.dataUrl);
    }
    inp.value = ''; draw(k);
  });
  $('#upForm').onsubmit = async e => {
    e.preventDefault();
    if (!S.upload.before.length || !S.upload.after.length) return toast('施工前、施工後照片至少各 1 張');
    let doc = null;
    const df = $('#docFile').files[0];
    if (df) {
      if (df.size > 5 * 1024 * 1024) return toast('文件超過 5MB');
      doc = await AD.fileToDataURL(df);
    }
    const btn = $('#upBtn'); btn.disabled = true; btn.textContent = '上傳中，請勿關閉…';
    try {
      const j = await api('vendorUpload', { id: i.id, ...S.upload, doc, finishDate: $('#finishDate').value });
      if (!j.ok) { toast(j.error || '上傳失敗'); return; }
      toast(`回報完成，驗收碼 ${j.code}`, 4000);
      S.lastUpload = { id: i.id, photos: { ...S.upload } };
      await load();
    } catch { toast('上傳失敗，請檢查網路後重試'); }
    finally { btn.disabled = false; btn.textContent = '📤 送出完工回報'; }
  };
}

/* ---------------- 已回報：驗收碼與文件產製 ---------------- */
function doneCard(i) {
  const ph = i.photoHashes || {};
  return `<div class="card"><h2>${i.status === '已驗收' ? '已驗收結案' : '已回報，待公所驗收'}</h2>
    <dl class="case-dl"><dt>完工日期</dt><dd>${esc(rocDate(i.finishDate))}</dd><dt>回報時間</dt><dd>${fmtTime(i.reportTime)}</dd>
      <dt>驗收碼</dt><dd><b class="code">${esc(i.docCode)}</b></dd><dt>照片</dt><dd>${KINDS.map(k => `${AD.KIND_NAME[k]} ${(ph[k] || []).length} 張`).join('、')}</dd>
      ${i.acceptDate ? `<dt>驗收日期</dt><dd>${esc(rocDate(i.acceptDate))}</dd>` : ''}</dl>
    <div class="qr-inline">${AD.qrSvg(AD.verifyUrl(i.docCode), 3)}<small>掃描可驗證文件真偽</small></div>
    <div class="btn-row"><button class="btn primary" type="button" id="printDoc">🖨️ 一鍵產製施工前中後照片（含 QR）</button></div></div>`;
}
function bindDone(i) {
  $('#printDoc').onclick = async () => {
    toast('正在準備文件…');
    const photos = {}, hashes = {};
    for (const k of KINDS) {
      photos[k] = []; hashes[k] = [];
      for (let n = 0; n < (i.photoHashes?.[k] || []).length; n++) {
        const j = await api('vendorPhoto', { id: i.id, kind: k, n }).catch(() => ({ ok: false }));
        if (j.ok) { photos[k].push(j.data); hashes[k].push(j.sha); }
      }
    }
    AD.printAcceptanceDoc({ item: i, photos, hashes, code: i.docCode, setHash: i.setHash });
  };
}

if (session) enter();
})();
