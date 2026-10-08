/**
 * 安定區道路通報後端（Google Apps Script）
 * 部署與帳號設定：見 gas/README.md
 *
 * 公開 API
 *   POST {action:'report', ...}             民眾新增通報
 *   GET  ?action=list                        公開看板（只含類別／位置／狀態，不含說明、聯絡方式、照片）
 * 後台 API（需登入權杖）
 *   POST {action:'login', user, pwd}         登入，取得 8 小時權杖
 *   POST {action:'adminList', token}         全部通報（檢視者看到遮罩後的聯絡方式）
 *   POST {action:'adminPhoto', token, id, n} 讀取第 n 張照片
 *   POST {action:'adminUpdate', token, id, status, reply}   承辦以上：更新狀態與回覆
 *   POST {action:'adminLog', token}          管理者：操作紀錄
 *
 * 角色：viewer 檢視者 < handler 承辦人 < admin 管理者
 */
const SHEET_NAME = '通報';
const LOG_SHEET = '操作紀錄';
const PHOTO_FOLDER_NAME = '安定區道路通報照片';
const HEADERS = ['案號', '通報時間', '類別', '說明', '緯度', '經度', '里別', '鄰近道路', '聯絡方式', '照片ID', '狀態', '處理說明', '處理人', '更新時間'];
const COL = { id: 0, time: 1, type: 2, desc: 3, lat: 4, lng: 5, village: 6, road: 7, contact: 8, photos: 9, status: 10, reply: 11, handler: 12, updated: 13 };
const TYPES = ['路面坑洞', '路面破損/龜裂', '邊坡坍方', '路樹倒塌', '雜草遮蔽', '排水阻塞/積水', '護欄/號誌損壞', '其他'];
const STATUSES = ['待處理', '處理中', '已完成', '不受理'];
const ROLE_LEVEL = { viewer: 1, handler: 2, admin: 3 };
const TOKEN_HOURS = 8;
const MAX_FAILS = 5, LOCK_SECONDS = 900;

/* ===================== 帳號管理（在 Apps Script 編輯器執行） ===================== */

/** 修改下方三個值後，選擇此函式按「執行」即可新增或重設帳號。執行完請把密碼改回空白再儲存。 */
function addAccount() {
  setupAccount_('admin', '', 'admin');   // 帳號, 密碼（至少 10 碼）, 角色 viewer / handler / admin
}

function setupAccount_(user, password, role) {
  user = String(user).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(user)) throw new Error('帳號限英數字 3–32 碼');
  if (String(password).length < 10) throw new Error('密碼至少 10 碼');
  if (!ROLE_LEVEL[role]) throw new Error('角色須為 viewer / handler / admin');
  const accounts = accounts_();
  const salt = Utilities.getUuid();
  const prev = accounts[user];
  accounts[user] = { salt: salt, hash: hash_(password, salt), role: role, ver: prev ? (prev.ver || 0) + 1 : 1 };
  PropertiesService.getScriptProperties().setProperty('ACCOUNTS', JSON.stringify(accounts));
  log_(user, 'setupAccount', role);
  Logger.log('已設定帳號 ' + user + '（' + role + '），該帳號既有登入皆已失效');
}

function removeAccount() {
  const user = '';  // 填入要刪除的帳號後執行
  const accounts = accounts_();
  delete accounts[user];
  PropertiesService.getScriptProperties().setProperty('ACCOUNTS', JSON.stringify(accounts));
  Logger.log('已刪除 ' + user);
}

function listAccounts() {
  const a = accounts_();
  Object.keys(a).forEach(function (u) { Logger.log(u + '：' + a[u].role); });
}

/** 讓所有人的登入立即失效（例如懷疑權杖外洩時） */
function revokeAllSessions() {
  PropertiesService.getScriptProperties().setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('已更換簽章金鑰，所有登入皆已失效');
}

/* ===================== 進入點 ===================== */

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '格式錯誤' }); }
  try {
    switch (d.action) {
      case 'report': return json_(report_(d));
      case 'login': return json_(login_(d));
      case 'adminList': return json_(adminList_(auth_(d.token, 'viewer')));
      case 'adminPhoto': return json_(adminPhoto_(auth_(d.token, 'viewer'), d));
      case 'adminUpdate': return json_(adminUpdate_(auth_(d.token, 'handler'), d));
      case 'adminLog': return json_(adminLog_(auth_(d.token, 'admin')));
      default: return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: err.authError ? err.message : '系統錯誤', auth: !!err.authError });
  }
}

function doGet(e) {
  if ((e.parameter.action || '') !== 'list') return json_({ ok: true, service: '安定區道路通報' });
  const rows = sheet_().getDataRange().getValues().slice(1);
  const items = rows.slice(-300).map(function (r) {
    return {
      id: r[COL.id], time: iso_(r[COL.time]), type: r[COL.type],
      lat: r[COL.lat], lng: r[COL.lng], village: r[COL.village], road: r[COL.road],
      status: r[COL.status], reply: r[COL.reply]
    };
  });
  return json_({ ok: true, items: items });
}

/* ===================== 公開：新增通報 ===================== */

function report_(d) {
  const lat = Number(d.lat), lng = Number(d.lng);
  // 只接受安定區附近座標與既定類別，避免濫用
  if (!(lat > 23.0 && lat < 23.2 && lng > 120.1 && lng < 120.35)) return { ok: false, error: '位置超出範圍' };
  if (TYPES.indexOf(d.type) < 0) return { ok: false, error: '類別錯誤' };
  const cache = CacheService.getScriptCache();
  const burst = Number(cache.get('report:burst') || 0);
  if (burst > 60) return { ok: false, error: '系統忙碌，請稍後再試' };
  cache.put('report:burst', String(burst + 1), 600);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const id = 'AD' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyMMddHHmmss') + Math.floor(Math.random() * 10);
    const ids = [];
    (d.photos || []).slice(0, 3).forEach(function (dataUrl, i) {
      const m = String(dataUrl).match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
      if (!m || m[2].length > 4e6) return;
      const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], id + '_' + (i + 1) + '.jpg');
      ids.push(folder_().createFile(blob).getId());
    });
    sheet_().appendRow([
      id, new Date(), d.type, clean_(d.desc, 300), lat, lng,
      clean_(d.village, 20), clean_(d.road, 60), clean_(d.contact, 60),
      ids.join(','), '待處理', '', '', ''
    ]);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== 後台：登入與權杖 ===================== */

function login_(d) {
  const user = String(d.user || '').trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + user;
  const fails = Number(cache.get(failKey) || 0);
  const allFails = Number(cache.get('fail:*') || 0);
  if (fails >= MAX_FAILS || allFails >= 50) return { ok: false, error: '嘗試次數過多，請 15 分鐘後再試' };

  const acc = accounts_()[user];
  // 帳號不存在時仍計算雜湊，避免以回應時間判斷帳號是否存在
  const ok = acc ? safeEqual_(hash_(String(d.pwd || ''), acc.salt), acc.hash) : (hash_(String(d.pwd || ''), 'x'), false);
  if (!ok) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    cache.put('fail:*', String(allFails + 1), LOCK_SECONDS);
    log_(user || '(空白)', 'loginFail', '');
    return { ok: false, error: '帳號或密碼錯誤' };
  }
  cache.remove(failKey);
  const exp = Date.now() + TOKEN_HOURS * 3600e3;
  const payload = b64_(JSON.stringify({ u: user, r: acc.role, v: acc.ver, exp: exp }));
  log_(user, 'login', '');
  return { ok: true, token: payload + '.' + sign_(payload), user: user, role: acc.role, exp: exp };
}

function auth_(token, need) {
  const parts = String(token || '').split('.');
  const fail = function (msg) { const e = new Error(msg); e.authError = true; throw e; };
  if (parts.length !== 2 || !safeEqual_(sign_(parts[0]), parts[1])) fail('請重新登入');
  let p;
  try {
    const padded = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
  } catch (err) { fail('請重新登入'); }
  if (Date.now() > p.exp) fail('登入逾時，請重新登入');
  const acc = accounts_()[p.u];
  if (!acc || acc.ver !== p.v) fail('帳號已變更，請重新登入');
  if (ROLE_LEVEL[acc.role] < ROLE_LEVEL[need]) fail('權限不足');
  return { user: p.u, role: acc.role };
}

/* ===================== 後台：資料 ===================== */

function adminList_(who) {
  const rows = sheet_().getDataRange().getValues().slice(1);
  const full = ROLE_LEVEL[who.role] >= ROLE_LEVEL.handler;
  const items = rows.map(function (r) {
    return {
      id: r[COL.id], time: iso_(r[COL.time]), type: r[COL.type], desc: r[COL.desc],
      lat: r[COL.lat], lng: r[COL.lng], village: r[COL.village], road: r[COL.road],
      contact: full ? r[COL.contact] : mask_(r[COL.contact]),
      photos: r[COL.photos] ? String(r[COL.photos]).split(',').length : 0,
      status: r[COL.status], reply: r[COL.reply], handler: r[COL.handler], updated: iso_(r[COL.updated])
    };
  });
  return { ok: true, items: items, role: who.role, user: who.user, statuses: STATUSES };
}

function adminPhoto_(who, d) {
  const row = findRow_(d.id);
  if (!row) return { ok: false, error: '找不到案件' };
  const ids = String(row.values[COL.photos] || '').split(',').filter(String);
  const fileId = ids[Number(d.n) || 0];
  if (!fileId) return { ok: false, error: '無此照片' };   // 只能讀取通報本身的照片，無法讀取雲端硬碟其他檔案
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { ok: true, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function adminUpdate_(who, d) {
  if (STATUSES.indexOf(d.status) < 0) return { ok: false, error: '狀態錯誤' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const row = findRow_(d.id);
    if (!row) return { ok: false, error: '找不到案件' };
    const sh = sheet_();
    const now = new Date();
    sh.getRange(row.index, COL.status + 1, 1, 4).setValues([[d.status, clean_(d.reply, 300), who.user, now]]);
    log_(who.user, 'update', d.id + ' → ' + d.status);
    return { ok: true, updated: iso_(now), handler: who.user };
  } finally {
    lock.releaseLock();
  }
}

function adminLog_(who) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  if (!sh) return { ok: true, items: [] };
  const rows = sh.getDataRange().getValues().slice(1).slice(-200).reverse();
  return { ok: true, items: rows.map(function (r) { return { time: iso_(r[0]), user: r[1], action: r[2], detail: r[3] }; }) };
}

/* ===================== 工具 ===================== */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(HEADERS); sh.setFrozenRows(1); }
  return sh;
}

function folder_() {
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function findRow_(id) {
  const vals = sheet_().getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) if (String(vals[i][COL.id]) === String(id)) return { index: i + 1, values: vals[i] };
  return null;
}

function log_(user, action, detail) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) { sh = ss.insertSheet(LOG_SHEET); sh.appendRow(['時間', '帳號', '動作', '內容']); sh.setFrozenRows(1); }
  sh.appendRow([new Date(), clean_(user, 40), action, clean_(detail, 200)]);
}

function accounts_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('ACCOUNTS') || '{}');
}

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}

function hash_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < 2000; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_())).replace(/=+$/, '');
}

function b64_(s) {
  return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function mask_(s) {
  s = String(s || '');
  if (!s) return '';
  return s.replace(/\d(?=\d{3})/g, '＊').replace(/^(\S)\S+/, '$1＊＊');
}

function clean_(s, max) {
  return String(s == null ? '' : s).replace(/^[=+\-@]/, "'$&").slice(0, max);   // 防止試算表公式注入
}

function iso_(v) {
  return v instanceof Date ? v.toISOString() : (v || '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
