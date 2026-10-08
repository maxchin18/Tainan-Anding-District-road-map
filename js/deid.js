/* =========================================================
   AI 端點隱私運算去識別化
   - 在使用者裝置上以 MediaPipe 偵測人臉、人物與車輛，自動加上馬賽克（人臉、車牌區域）
   - 提供手動塗抹／擦除補強；只有處理後的影像會被上傳，原始照片從未離開裝置
   - 模型於第一次選照片時才載入（約 5 MB），不影響一般瀏覽速度
   ========================================================= */
(() => {
'use strict';
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const OBJ_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
const VEHICLES = ['car', 'truck', 'bus', 'motorcycle'];
const MAX_EDGE = 1280;

let detectorsPromise = null;
function loadDetectors() {
  if (!detectorsPromise) {
    detectorsPromise = (async () => {
      const v = await import(`${MP}/vision_bundle.mjs`);
      const fs = await v.FilesetResolver.forVisionTasks(`${MP}/wasm`);
      const [face, obj] = await Promise.all([
        v.FaceDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: 'IMAGE', minDetectionConfidence: .45 }),
        v.ObjectDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: OBJ_MODEL }, runningMode: 'IMAGE', scoreThreshold: .3, maxResults: 20,
          categoryAllowlist: ['person'].concat(VEHICLES) }),
      ]);
      return { face, obj };
    })().catch(err => { detectorsPromise = null; throw err; });
  }
  return detectorsPromise;
}

/** 偵測需遮蔽的區域：人臉（含遠處人物的頭部）與車輛的車牌區域 */
async function detectRegions(canvas) {
  const { face, obj } = await loadDetectors();
  const rects = [];
  const faces = face.detect(canvas).detections.map(d => d.boundingBox);
  faces.forEach(b => rects.push(pad({ x: b.originX, y: b.originY, w: b.width, h: b.height }, .35)));
  let persons = 0, vehicles = 0;
  obj.detect(canvas).detections.forEach(d => {
    const b = d.boundingBox, cat = d.categories[0].categoryName;
    if (cat === 'person') {
      persons++;
      // 人臉偵測對遠處小臉較弱：以人物框上緣 22% 作為頭部區域補強
      const head = { x: b.originX + b.width * .15, y: b.originY, w: b.width * .7, h: Math.max(b.height * .22, b.width * .5) };
      if (!faces.some(f => overlap(f, head))) rects.push(pad(head, .15));
    } else if (VEHICLES.includes(cat)) {
      vehicles++;
      // 車牌位於車頭／車尾下半部：遮蔽車輛框下方 55%
      rects.push({ x: b.originX, y: b.originY + b.height * .45, w: b.width, h: b.height * .55 });
    }
  });
  return { rects, faces: faces.length, persons, vehicles };
}
const pad = (r, k) => ({ x: r.x - r.w * k / 2, y: r.y - r.h * k / 2, w: r.w * (1 + k), h: r.h * (1 + k) });
const overlap = (a, b) => !(a.originX > b.x + b.w || a.originX + a.width < b.x || a.originY > b.y + b.h || a.originY + a.height < b.y);

/* ---------------- 編輯器 ---------------- */
function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }

/**
 * 開啟去識別化編輯器。
 * @param {File|string} src 圖片檔或 dataURL
 * @returns {Promise<{dataUrl:string, summary:string}|null>} 取消時回傳 null
 */
async function open(src, { title = '照片去識別化' } = {}) {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  if (typeof src !== 'string') URL.revokeObjectURL(url);
  const k = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const W = Math.round(img.width * k), H = Math.round(img.height * k);

  const orig = document.createElement('canvas'); orig.width = W; orig.height = H;
  orig.getContext('2d').drawImage(img, 0, 0, W, H);
  // 馬賽克版本
  const block = Math.max(10, Math.round(Math.max(W, H) / 55));
  const tiny = document.createElement('canvas'); tiny.width = Math.ceil(W / block); tiny.height = Math.ceil(H / block);
  tiny.getContext('2d').drawImage(orig, 0, 0, tiny.width, tiny.height);
  const pix = document.createElement('canvas'); pix.width = W; pix.height = H;
  const pctx = pix.getContext('2d'); pctx.imageSmoothingEnabled = false; pctx.drawImage(tiny, 0, 0, W, H);
  const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
  const mctx = mask.getContext('2d');

  const dlg = el(`<div class="deid" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="deid-card">
      <div class="deid-head"><b>🛡️ ${title}</b><span class="deid-status">AI 偵測中…</span></div>
      <div class="deid-stage"><canvas></canvas></div>
      <div class="deid-tools">
        <div class="seg deid-mode" role="radiogroup" aria-label="筆刷"><button type="button" data-m="paint" class="on">🖌️ 塗抹馬賽克</button><button type="button" data-m="erase">🧽 擦除</button></div>
        <label class="deid-size">筆刷 <input type="range" min="10" max="120" value="40" aria-label="筆刷大小"></label>
      </div>
      <p class="small muted deid-note">AI 在您的裝置上執行，原始照片不會上傳。請確認人臉與車牌都已遮蔽，未偵測到的可用手指塗抹補強。</p>
      <div class="btn-row"><button type="button" class="btn ghost" data-a="cancel">取消</button><button type="button" class="btn ghost" data-a="clear">清除遮蔽</button><button type="button" class="btn primary" data-a="ok">✔ 確認使用</button></div>
    </div></div>`);
  document.body.appendChild(dlg);
  const view = dlg.querySelector('canvas'); view.width = W; view.height = H;
  const vctx = view.getContext('2d');
  const status = dlg.querySelector('.deid-status');

  function render() {
    vctx.globalCompositeOperation = 'source-over';
    vctx.drawImage(orig, 0, 0);
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.drawImage(mask, 0, 0); t.globalCompositeOperation = 'source-in'; t.drawImage(pix, 0, 0);
    vctx.drawImage(tmp, 0, 0);
  }
  render();

  // AI 自動偵測
  let summary = '手動處理';
  (async () => {
    try {
      const r = await detectRegions(orig);
      mctx.fillStyle = '#000';
      r.rects.forEach(b => mctx.fillRect(Math.max(0, b.x), Math.max(0, b.y), b.w, b.h));
      render();
      summary = `AI 偵測：人臉 ${r.faces}、人物 ${r.persons}、車輛 ${r.vehicles}`;
      status.textContent = r.rects.length ? `已自動遮蔽 ${r.rects.length} 處（${summary.slice(6)}）` : '未偵測到人臉或車輛，請目視確認';
      status.classList.add('ok');
    } catch (err) {
      console.warn('去識別化模型載入失敗', err);
      status.textContent = 'AI 模型無法載入（可能離線），請手動塗抹人臉與車牌';
      status.classList.add('warn');
    }
  })();

  // 手動筆刷
  let mode = 'paint', drawing = false, last = null;
  const size = dlg.querySelector('input[type=range]');
  dlg.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; dlg.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b)); });
  const pos = e => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
  function stroke(p) {
    mctx.globalCompositeOperation = mode === 'paint' ? 'source-over' : 'destination-out';
    mctx.strokeStyle = mctx.fillStyle = '#000'; mctx.lineCap = 'round'; mctx.lineJoin = 'round';
    mctx.lineWidth = size.value * W / view.getBoundingClientRect().width;
    mctx.beginPath(); mctx.moveTo((last || p).x, (last || p).y); mctx.lineTo(p.x, p.y); mctx.stroke();
    last = p; render();
  }
  view.addEventListener('pointerdown', e => { drawing = true; last = null; view.setPointerCapture(e.pointerId); stroke(pos(e)); });
  view.addEventListener('pointermove', e => { if (drawing) stroke(pos(e)); });
  view.addEventListener('pointerup', () => { drawing = false; last = null; mctx.globalCompositeOperation = 'source-over'; });

  return new Promise(resolve => {
    const close = v => { dlg.remove(); resolve(v); };
    dlg.querySelector('[data-a=cancel]').onclick = () => close(null);
    dlg.querySelector('[data-a=clear]').onclick = () => { mctx.clearRect(0, 0, W, H); render(); };
    dlg.querySelector('[data-a=ok]').onclick = () => { render(); close({ dataUrl: view.toDataURL('image/jpeg', .8), summary }); };
  });
}

window.Deid = { open, preload: () => loadDetectors().catch(() => {}) };
})();
