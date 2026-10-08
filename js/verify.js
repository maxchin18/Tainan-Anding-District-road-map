/* QR-Code 數位防偽驗收鏈：驗證頁
   取出資料庫原始照片，於瀏覽器重新計算 SHA-256，與回報當下記錄的指紋比對 */
(() => {
'use strict';
const { $, esc, rocDate, toTWD97, statusColor, apiGet, dataUrlBytes, sha256Hex, KIND_NAME } = window.AD;

async function verify(code) {
  const box = $('#result');
  box.innerHTML = '<p class="muted">驗證中…</p>';
  let j;
  try { j = await apiGet({ action: 'verify', c: code }); } catch { j = { ok: false, error: '無法連線到驗證伺服器' }; }
  if (!j.ok) { box.innerHTML = `<div class="chain-bad">✖ ${esc(j.error || '驗證失敗')}</div>`; return; }
  const i = j.item, t = toTWD97(i.lat, i.lng);
  const kinds = ['before', 'during', 'after'].filter(k => j.photoHashes[k].length);
  box.innerHTML = `<div class="chain-ok">✔ 驗收碼有效：此文件登錄於系統資料庫</div>
    <div class="card"><span class="st" style="background:${statusColor(i.status)}">${esc(i.status)}</span>
      <h2 style="margin-top:6px">${esc(i.type)}｜${esc(i.id)}</h2>
      <dl class="case-dl" style="margin-top:8px">
        <dt>位置</dt><dd>${esc(i.village)}・${esc(i.road || '')}<br><small>TWD97 ${t[0].toFixed(0)}, ${t[1].toFixed(0)}</small></dd>
        <dt>施工廠商</dt><dd>${esc(i.vendor)}</dd><dt>決標金額</dt><dd>${Number(i.amount).toLocaleString()} 元</dd>
        <dt>派工日期</dt><dd>${esc(rocDate(i.dispatchDate))}</dd><dt>完工日期</dt><dd>${esc(rocDate(i.finishDate))}</dd>
        ${i.acceptDate ? `<dt>驗收日期</dt><dd>${esc(rocDate(i.acceptDate))}</dd>` : ''}
        <dt>照片組雜湊</dt><dd><small class="hash">${esc(j.setHash)}</small></dd>
      </dl></div>
    ${kinds.map(k => `<div class="card"><h2>${KIND_NAME[k]}</h2><div class="case-photos">${j.photoHashes[k].map((h, n) =>
      `<figure data-k="${k}" data-n="${n}" data-h="${esc(h)}"><span class="muted small">載入中…</span><figcaption>指紋 ${esc(h.slice(0, 12))}</figcaption></figure>`).join('')}</div></div>`).join('')}
    <p class="small muted">「指紋」是照片檔案的 SHA-256 前 12 碼。紙本文件上每張照片下方都印有指紋；若紙本照片與本頁不同，或指紋不符，代表文件遭到抽換。</p>`;
  for (const fig of box.querySelectorAll('figure[data-k]')) {
    apiGet({ action: 'photo', id: i.id, kind: fig.dataset.k, n: fig.dataset.n }).then(async p => {
      if (!p.ok) { fig.innerHTML = '<span class="muted small">無法讀取</span>'; return; }
      const h = await sha256Hex(dataUrlBytes(p.data));
      const ok = h === fig.dataset.h;
      fig.innerHTML = `<img src="${p.data}" alt=""><figcaption style="background:${ok ? 'rgba(46,158,79,.9)' : 'rgba(227,0,27,.9)'}">${ok ? '✔ 指紋相符' : '✖ 指紋不符'} ${esc(h.slice(0, 12))}</figcaption>`;
    });
  }
}

const params = new URLSearchParams(location.search);
$('#codeForm').onsubmit = e => {
  e.preventDefault();
  const c = $('#code').value.trim().toUpperCase();
  history.replaceState(null, '', '?c=' + encodeURIComponent(c));
  verify(c);
};
if (params.get('c')) { $('#code').value = params.get('c').toUpperCase(); verify($('#code').value); }
})();
