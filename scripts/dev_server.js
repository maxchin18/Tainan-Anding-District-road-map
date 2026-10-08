/*
 * 本機開發測試伺服器：直接執行 gas/Code.gs（以記憶體模擬 Google 試算表、雲端硬碟、Email、LINE），
 * 並提供網站靜態檔。測試的就是正式後端程式本身。
 *
 *   node scripts/dev_server.js        → http://localhost:8766
 *
 * 測試帳號（僅本機）：demo-admin / demo-handler / demo-viewer / demo-vendor，密碼皆為 local-test-only
 * 開發用端點：/__mail（寄出的信）、/__line（LINE 推播）、/__captcha（最近一次驗證碼答案，供自動測試）
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8766);
const PWD = 'local-test-only';

/* ---------------- Google Apps Script 服務模擬 ---------------- */
const signed = buf => [...buf].map(b => (b > 127 ? b - 256 : b));
const toBuf = v => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map(b => b & 255)));
const props = {}, cache = {}, sheets = {}, files = {}, mails = [], lineCalls = [];
let lastCaptcha = '';

const cell = v => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);   // 試算表會吃掉開頭單引號
function makeSheet(name) {
  const rows = [];
  const sh = {
    rows,
    appendRow: r => rows.push(r.map(cell)),
    setFrozenRows() {},
    getLastColumn: () => (rows[0] || []).length,
    getLastRow: () => rows.length,
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: v => { for (let i = 0; i < nr; i++) { rows[r - 1 + i] = rows[r - 1 + i] || []; for (let j = 0; j < nc; j++) rows[r - 1 + i][c - 1 + j] = cell(v[i][j]); } },
    }),
  };
  sheets[name] = sh;
  return sh;
}
function fmtDate(d, tz, pattern) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]));
  return pattern.replace('yyyy', p.year).replace('yy', p.year.slice(2)).replace('MM', p.month).replace('dd', p.day)
    .replace('HH', p.hour === '24' ? '00' : p.hour).replace('mm', p.minute).replace('ss', p.second);
}
const gas = {
  Utilities: {
    computeDigest: (alg, v) => signed(crypto.createHash('sha256').update(toBuf(v)).digest()),
    computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', k).update(v).digest()),
    base64Encode: v => toBuf(v).toString('base64'),
    base64EncodeWebSafe: v => toBuf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: s => signed(Buffer.from(s, 'base64')),
    base64DecodeWebSafe: s => signed(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    newBlob: (bytes, type, name) => ({ buf: toBuf(bytes), type, name, getDataAsString: () => toBuf(bytes).toString('utf8') }),
    getUuid: () => crypto.randomUUID(),
    formatDate: fmtDate,
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'JSON' } },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => makeSheet(n) }) },
  DriveApp: {
    getFoldersByName: () => ({ hasNext: () => false }),
    createFolder: () => ({ createFile: b => { const id = 'F' + crypto.randomBytes(6).toString('hex'); files[id] = b; return { getId: () => id }; } }),
    getFileById: id => { if (!files[id]) throw new Error('no file'); return { getBlob: () => ({ getContentType: () => files[id].type, getBytes: () => signed(files[id].buf) }) }; },
  },
  MailApp: { sendEmail: (to, subject, body) => { mails.push({ to, subject, body, time: new Date().toISOString() }); console.log(`[mail] ${to}｜${subject}`); } },
  UrlFetchApp: { fetch: (url, o) => { lineCalls.push({ url, payload: JSON.parse(o.payload) }); console.log(`[line] ${url}`); return { getResponseCode: () => 200 }; } },
  Logger: { log: m => console.log('[log]', m) },
};
const ctx = vm.createContext({ ...gas, console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

// 記錄驗證碼答案供自動測試（只在本機）
const origSha = ctx.sha256hex_;
ctx.sha256hex_ = s => { const m = /^(\d{4})\|[0-9a-f-]{36}$/.exec(s); if (m) lastCaptcha = m[1]; return origSha(s); };

/* ---------------- 測試資料 ---------------- */
for (const [u, r, v] of [['demo-admin', 'admin'], ['demo-handler', 'handler'], ['demo-viewer', 'viewer'], ['demo-vendor', 'vendor', '測試營造有限公司']]) ctx.setupAccount_(u, PWD, r, v || '');
ctx.saveContract_({ user: 'demo-admin' }, { name: '115年道路養護開口契約（測試）', vendor: '測試營造有限公司', year: '115', limit: 300000 });
props.SETTINGS = JSON.stringify({ notifyEmails: ['staff1@example.test', 'staff2@example.test'], siteUrl: `http://localhost:${PORT}/`, lineToken: 'dev-token' });
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
ctx.createCase_({ type: '路面坑洞', desc: '【測試資料】坑洞約一公尺', lat: 23.104681, lng: 120.230568, village: '港尾里', road: '港尾里農路 09', contact: '測試者 0912345678', email: 'citizen@example.test', photos: [PIXEL] }, '網路通報', 'public');
ctx.createCase_({ type: '路樹倒塌', desc: '【測試資料】樹倒擋路', lat: 23.1007, lng: 120.2141, village: '海寮里', road: '海寮里農路 11', contact: '', photos: [] }, '電話通報', 'demo-handler');

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/api') {
    if (req.method === 'GET') return send(res, 200, ctx.doGet({ parameter: Object.fromEntries(u.searchParams) }).s);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { send(res, 200, ctx.doPost({ postData: { contents: body } }).s); }
      catch (err) { console.error(err); send(res, 500, JSON.stringify({ ok: false, error: String(err) })); }
    });
    return;
  }
  if (u.pathname === '/__mail') return send(res, 200, JSON.stringify(mails));
  if (u.pathname === '/__line') return send(res, 200, JSON.stringify(lineCalls));
  if (u.pathname === '/__captcha') return send(res, 200, JSON.stringify({ answer: lastCaptcha }));
  if (u.pathname === '/__sheet') return send(res, 200, JSON.stringify(sheets[u.searchParams.get('name')]?.rows || []));
  if (u.pathname === '/__save' && req.method === 'POST') {   // 把瀏覽器產生的圖片存到暫存資料夾，方便檢查
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const f = path.join(require('os').tmpdir(), path.basename(u.searchParams.get('name') || 'shot') + '.jpg');
      fs.writeFileSync(f, Buffer.from(body.split(',')[1] || '', 'base64'));
      send(res, 200, JSON.stringify({ ok: true, file: f }));
    });
    return;
  }
  if (u.pathname === '/__tamper') {   // 模擬有人直接改試算表，用來測試雜湊鏈驗證
    const rows = sheets['數位軌跡'].rows; rows[2][5] = '{"tampered":true}';
    return send(res, 200, '{"ok":true}');
  }
  let file = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
  if (u.pathname === '/js/config.js') {
    return send(res, 200, fs.readFileSync(file, 'utf8') + `\nwindow.APP_CONFIG.reportEndpoint = 'http://localhost:${PORT}/api';\nwindow.APP_CONFIG.lineOaId = window.APP_CONFIG.lineOaId || '@dev-test';\n`, MIME['.js']);
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, '127.0.0.1', () => console.log(`開發伺服器：http://localhost:${PORT}  （後台 /admin.html、廠商 /vendor.html；帳號 demo-admin/demo-handler/demo-viewer/demo-vendor，密碼 ${PWD}）`));
