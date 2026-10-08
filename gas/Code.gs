/**
 * 臺南市安定區公眾通行道路圖資系統 — 後端（Google Apps Script）
 * 部署與帳號設定：見 gas/README.md
 *
 * 六階段數位閉環：民眾通報 → 自動立案 → 審核派工 → 廠商施工驗收 → 民眾回饋 → 資料開放
 * 每個事件寫入「數位軌跡」雜湊鏈（SHA-256，前後串接），任何事後竄改都可被驗出。
 *
 * 公開 API（GET ?action=…）  list / case / photo / verify / nearby / captcha
 * 公開 API（POST）           report / comment / rate ；LINE Webhook（含 events 的 POST）
 * 後台 API（POST，需權杖）    login / admin* / vendor*
 *
 * 角色：vendor 廠商（只看自己的派工） · viewer 檢視者 < handler 承辦人 < admin 管理者
 */

/* ===================== 設定 ===================== */
const SITE_URL_DEFAULT = 'https://maxchin18.github.io/Tainan-Anding-District-road-map/';
const DISTRICT = '臺南市安定區';
const PHOTO_FOLDER_NAME = '安定區道路通報檔案';
const TYPES = ['路面坑洞', '路面破損/龜裂', '邊坡坍方', '路樹倒塌', '雜草遮蔽', '排水阻塞/積水', '護欄/號誌損壞', '其他'];
const ST = { NEW: '已立案', DISPATCHED: '已派工', DONE: '已完工', ACCEPTED: '已驗收', REJECTED: '不受理' };
const STATUSES = [ST.NEW, ST.DISPATCHED, ST.DONE, ST.ACCEPTED, ST.REJECTED];
const ROLE_LEVEL = { vendor: 0, viewer: 1, handler: 2, admin: 3 };
const TOKEN_HOURS = 8;
const MAX_FAILS = 5, LOCK_SECONDS = 900;
const DUP_RADIUS_M = 50, DUP_YEARS = 3;          // 時間及空間雙重演算法：3 年內、方圓 50 公尺
const PHOTO_KINDS = ['before', 'during', 'after']; // 施工前、中、後（公開）
const KIND_NAME = { citizen: '民眾照片', before: '施工前', during: '施工中', after: '施工後', doc: '履約文件' };

const SHEETS = {
  cases: { name: '案件', headers: ['案號', '立案時間', '來源', '類別', '說明', '緯度', '經度', '里別', '鄰近道路', '聯絡方式', 'Email', 'LINE', '民眾照片', '查詢碼雜湊',
    '狀態', '處理說明', '承辦人', '更新時間', '契約編號', '廠商', '派工金額', '派工日期', '派工人', '地籍確認', '會勘簽核文號',
    '施工照片', '履約文件', '完工日期', '回報時間', '驗收碼', '照片組雜湊', '驗收日期', '驗收人', '評分', '評語', '評分時間'] },
  contracts: { name: '開口契約', headers: ['契約編號', '契約名稱', '廠商', '年度', '契約限額', '狀態', '建立時間'] },
  comments: { name: '留言', headers: ['留言編號', '時間', '案號', '身分', '名稱', '內容', '隱藏'] },
  chain: { name: '數位軌跡', headers: ['序號', '時間', '帳號', '事件', '案號', '內容', '前一雜湊', '雜湊'] },
};

/* ===================== 帳號管理（第一次部署在編輯器執行） ===================== */

/** 建立第一個管理者帳號：修改下方帳號密碼後，選此函式按「執行」。執行完請把密碼改回空白再儲存。
 *  之後的帳號（含廠商）可在後台「帳號管理」建立。 */
function addAccount() {
  setupAccount_('admin', '', 'admin', '');   // 帳號, 密碼（至少 10 碼）, 角色, 廠商名稱（廠商才需要）
}

function setupAccount_(user, password, role, vendor) {
  user = String(user).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(user)) throw new Error('帳號限英數字 3–32 碼');
  if (ROLE_LEVEL[role] === undefined) throw new Error('角色須為 vendor / viewer / handler / admin');
  if (role === 'vendor' && !String(vendor || '').trim()) throw new Error('廠商帳號須填廠商名稱');
  const accounts = accounts_();
  const prev = accounts[user];
  if (!prev && String(password).length < 10) throw new Error('密碼至少 10 碼');
  if (prev && password && String(password).length < 10) throw new Error('密碼至少 10 碼');
  const acc = prev || {};
  if (password) { acc.salt = Utilities.getUuid(); acc.hash = hash_(password, acc.salt); }
  acc.role = role;
  acc.vendor = role === 'vendor' ? String(vendor).trim() : '';
  acc.ver = (acc.ver || 0) + 1;      // 任何變更都讓既有登入失效（例如更換廠商即更換密碼）
  acc.disabled = false;
  accounts[user] = acc;
  saveAccounts_(accounts);
  return acc;
}

function listAccounts() {
  const a = accounts_();
  Object.keys(a).forEach(function (u) { Logger.log(u + '：' + a[u].role + (a[u].vendor ? '（' + a[u].vendor + '）' : '')); });
}

/** 讓所有人的登入立即失效（例如懷疑權杖外洩時） */
function revokeAllSessions() {
  PropertiesService.getScriptProperties().setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('已更換簽章金鑰，所有登入皆已失效');
}

/* ===================== 進入點 ===================== */

function doGet(e) {
  const p = e.parameter || {};
  try {
    switch (p.action) {
      case 'list': return json_(publicList_());
      case 'case': return json_(publicCase_(p.id));
      case 'photo': return json_(publicPhoto_(p.id, p.kind, p.n));
      case 'verify': return json_(verifyDoc_(p.c));
      case 'nearby': return json_({ ok: true, items: nearby_(Number(p.lat), Number(p.lng), p.exclude) });
      case 'captcha': return json_(captcha_());
      default: return json_({ ok: true, service: DISTRICT + '公眾通行道路圖資系統' });
    }
  } catch (err) {
    return json_({ ok: false, error: '系統錯誤' });
  }
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '格式錯誤' }); }
  if (d && d.events) return lineWebhook_(d);       // LINE Messaging API Webhook
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);                             // 所有寫入序列化，確保案號與雜湊鏈不衝突
  try {
    switch (d.action) {
      case 'report': return json_(report_(d));
      case 'comment': return json_(comment_(d));
      case 'rate': return json_(rate_(d));
      case 'login': return json_(login_(d));
      case 'adminList': return json_(adminList_(auth_(d.token, 'viewer')));
      case 'adminPhoto': return json_(filePayload_(auth_(d.token, 'viewer'), d));
      case 'adminUpdate': return json_(adminUpdate_(auth_(d.token, 'handler'), d));
      case 'adminCreate': return json_(adminCreate_(auth_(d.token, 'handler'), d));
      case 'adminDispatch': return json_(adminDispatch_(auth_(d.token, 'handler'), d));
      case 'adminAccept': return json_(adminAccept_(auth_(d.token, 'handler'), d));
      case 'adminReturn': return json_(adminReturn_(auth_(d.token, 'handler'), d));
      case 'adminReply': return json_(adminReply_(auth_(d.token, 'handler'), d));
      case 'adminHideComment': return json_(adminHideComment_(auth_(d.token, 'handler'), d));
      case 'adminComments': return json_(adminComments_(auth_(d.token, 'viewer'), d));
      case 'adminContracts': return json_(contracts_(auth_(d.token, 'viewer')));
      case 'adminSaveContract': return json_(saveContract_(auth_(d.token, 'admin'), d));
      case 'adminAccounts': return json_(adminAccounts_(auth_(d.token, 'admin')));
      case 'adminSaveAccount': return json_(adminSaveAccount_(auth_(d.token, 'admin'), d));
      case 'adminDeleteAccount': return json_(adminDeleteAccount_(auth_(d.token, 'admin'), d));
      case 'adminSettings': return json_(adminSettings_(auth_(d.token, 'admin'), d));
      case 'adminLog': return json_(adminLog_(auth_(d.token, 'admin'), d));
      case 'vendorList': return json_(vendorList_(auth_(d.token, 'vendor', true)));
      case 'vendorPhoto': return json_(filePayload_(auth_(d.token, 'vendor', true), d));
      case 'vendorUpload': return json_(vendorUpload_(auth_(d.token, 'vendor', true), d));
      default: return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: err.authError || err.userError ? err.message : '系統錯誤', auth: !!err.authError });
  } finally {
    lock.releaseLock();
  }
}

/* ===================== 階段一：民眾線上通報 ===================== */

function report_(d) {
  checkCaptcha_(d.captcha, d.answer);
  const lat = Number(d.lat), lng = Number(d.lng);
  if (!(lat > 23.0 && lat < 23.2 && lng > 120.1 && lng < 120.35)) return { ok: false, error: '位置超出範圍' };
  if (TYPES.indexOf(d.type) < 0) return { ok: false, error: '類別錯誤' };
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email))) return { ok: false, error: 'Email 格式錯誤' };
  const cache = CacheService.getScriptCache();
  const burst = Number(cache.get('report:burst') || 0);
  if (burst > 60) return { ok: false, error: '系統忙碌，請稍後再試' };
  cache.put('report:burst', String(burst + 1), 600);
  return createCase_(d, '網路通報', 'public');
}

/** 階段二：系統自動立案（給號、存照片、雜湊鏈、雙軌通知民眾、通知本所多組信箱） */
function createCase_(d, source, by) {
  const id = nextCaseId_();
  const key = randomCode_(8);
  const ids = saveImages_(d.photos, id + '_民眾', 3);   // 照片已在民眾裝置端完成 AI 去識別化
  const now = new Date();
  append_('cases', {
    '案號': id, '立案時間': now, '來源': source, '類別': d.type, '說明': clean_(d.desc, 500),
    '緯度': Number(d.lat), '經度': Number(d.lng), '里別': clean_(d.village, 20), '鄰近道路': clean_(d.road, 60),
    '聯絡方式': clean_(d.contact, 60), 'Email': clean_(d.email, 120), '民眾照片': ids.map(function (x) { return x.id + ':' + x.sha; }).join(','),
    '查詢碼雜湊': sha256hex_(key + '|' + id), '狀態': ST.NEW, '更新時間': now,
  });
  const near = nearby_(Number(d.lat), Number(d.lng), id);
  chain_(by, '立案', id, { source: source, type: d.type, lat: d.lat, lng: d.lng, photos: ids.map(function (x) { return x.sha; }), nearby: near.length });
  const link = siteUrl_() + '#case=' + id;
  notifyCitizen_({ '案號': id, 'Email': d.email }, '【' + DISTRICT + '道路通報】已立案 ' + id,
    '您的道路通報已立案。\n案號：' + id + '\n查詢碼：' + key + '\n類別：' + d.type + '\n\n查詢進度：' + link +
    '\n\n加入公所 LINE 官方帳號並傳送「追蹤 ' + id + ' ' + key + '」即可接收 LINE 進度通知。');
  notifyStaff_('【新通報】' + id + ' ' + d.type + '（' + (d.village || '') + '）',
    '來源：' + source + '\n類別：' + d.type + '\n位置：' + (d.village || '') + ' ' + (d.road || '') + '\n說明：' + (d.desc || '') +
    (near.length ? '\n\n⚠ 3 年內方圓 50 公尺內已有 ' + near.length + ' 件案件，派工前須辦理會勘並簽奉核可。' : '') + '\n\n' + link);
  return { ok: true, id: id, key: key, nearby: near };
}

/* ===================== 公開查詢 ===================== */

function publicItem_(r) {
  const ph = photoMeta_(r['施工照片']);
  return {
    id: r['案號'], date: dateStr_(r['立案時間']), time: iso_(r['立案時間']), type: r['類別'],
    lat: r['緯度'], lng: r['經度'], village: r['里別'], road: r['鄰近道路'], status: r['狀態'], reply: r['處理說明'],
    dispatchDate: dateStr_(r['派工日期']), finishDate: dateStr_(r['完工日期']), acceptDate: dateStr_(r['驗收日期']),
    vendor: r['廠商'], amount: r['派工金額'] === '' ? '' : Number(r['派工金額']), rating: r['評分'] === '' ? '' : Number(r['評分']),
    photos: { before: ph.before.length, during: ph.during.length, after: ph.after.length },
  };
}

function publicList_() {
  return { ok: true, items: rows_('cases').map(publicItem_), statuses: STATUSES };
}

function publicCase_(id) {
  const r = findRow_('cases', id);
  if (!r) return { ok: false, error: '查無此案件' };
  const item = publicItem_(r);
  item.ratingText = r['評語'];
  item.comments = rows_('comments').filter(function (c) { return c['案號'] === id && !c['隱藏']; })
    .map(function (c) { return { time: iso_(c['時間']), role: c['身分'], name: c['名稱'], text: c['內容'] }; });
  item.timeline = rows_('chain').filter(function (c) { return c['案號'] === id; })
    .map(function (c) { return { time: c['時間'], event: c['事件'] }; })
    .filter(function (c) { return ['立案', '派工', '完工回報', '驗收', '退回', '狀態更新', '評分'].indexOf(c.event) >= 0; });
  return { ok: true, item: item };
}

function publicPhoto_(id, kind, n) {
  if (PHOTO_KINDS.indexOf(kind) < 0) return { ok: false, error: '不公開' };   // 民眾照片與履約文件不公開
  const r = findRow_('cases', id);
  if (!r) return { ok: false, error: '查無此案件' };
  return fileData_(photoMeta_(r['施工照片'])[kind][Number(n) || 0]);
}

/** 時間及空間雙重演算法：3 年內、方圓 50 公尺內的既有案件 */
function nearby_(lat, lng, excludeId) {
  if (!isFinite(lat) || !isFinite(lng)) return [];
  const since = Date.now() - DUP_YEARS * 365.25 * 864e5;
  return rows_('cases').filter(function (r) {
    if (r['案號'] === excludeId || r['狀態'] === ST.REJECTED) return false;
    const t = new Date(r['立案時間']).getTime();
    return t >= since && distM_(lat, lng, Number(r['緯度']), Number(r['經度'])) <= DUP_RADIUS_M;
  }).map(function (r) {
    return { id: r['案號'], date: dateStr_(r['立案時間']), type: r['類別'], status: r['狀態'],
      dist: Math.round(distM_(lat, lng, Number(r['緯度']), Number(r['經度']))) };
  });
}

/* ===================== 階段五：民眾回饋 ===================== */

function comment_(d) {
  checkCaptcha_(d.captcha, d.answer);
  const r = findRow_('cases', d.id);
  if (!r) return { ok: false, error: '查無此案件' };
  const text = clean_(d.text, 300).trim();
  if (text.length < 2) return { ok: false, error: '請輸入留言內容' };
  const cid = 'C' + Date.now().toString(36).toUpperCase();
  append_('comments', { '留言編號': cid, '時間': new Date(), '案號': d.id, '身分': '民眾', '名稱': clean_(d.name, 20) || '民眾', '內容': text, '隱藏': '' });
  chain_('public', '留言', d.id, { cid: cid, text: text });
  notifyStaff_('【案件留言】' + d.id, (d.name || '民眾') + '：' + text + '\n\n' + siteUrl_() + 'admin.html');
  return { ok: true };
}

function rate_(d) {
  const r = findRow_('cases', d.id);
  if (!r) return { ok: false, error: '查無此案件' };
  if (!safeEqual_(sha256hex_(String(d.key || '').toUpperCase() + '|' + d.id), r['查詢碼雜湊'])) return { ok: false, error: '查詢碼錯誤' };
  if ([ST.DONE, ST.ACCEPTED].indexOf(r['狀態']) < 0) return { ok: false, error: '完工後才能評分' };
  const stars = Math.round(Number(d.stars));
  if (!(stars >= 1 && stars <= 5)) return { ok: false, error: '評分須為 1–5 星' };
  update_('cases', r, { '評分': stars, '評語': clean_(d.text, 200), '評分時間': new Date() });
  chain_('public', '評分', d.id, { stars: stars });
  notifyStaff_('【民眾評分】' + d.id + ' ' + stars + ' 星', clean_(d.text, 200));
  return { ok: true };
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
  const ok = acc && !acc.disabled ? safeEqual_(hash_(String(d.pwd || ''), acc.salt), acc.hash) : (hash_(String(d.pwd || ''), 'x'), false);
  if (!ok) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    cache.put('fail:*', String(allFails + 1), LOCK_SECONDS);
    chain_(user || '(空白)', '登入失敗', '', {});
    return { ok: false, error: '帳號或密碼錯誤' };
  }
  cache.remove(failKey);
  const exp = Date.now() + TOKEN_HOURS * 3600e3;
  const payload = b64_(JSON.stringify({ u: user, r: acc.role, v: acc.ver, exp: exp }));
  chain_(user, '登入', '', { role: acc.role });
  return { ok: true, token: payload + '.' + sign_(payload), user: user, role: acc.role, vendor: acc.vendor || '', exp: exp };
}

/** need：所需最低角色；vendorOnly：限廠商帳號（廠商與公所人員功能完全分開） */
function auth_(token, need, vendorOnly) {
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
  if (!acc || acc.disabled || acc.ver !== p.v) fail('帳號已變更，請重新登入');
  if (vendorOnly ? acc.role !== 'vendor' : (acc.role === 'vendor' || ROLE_LEVEL[acc.role] < ROLE_LEVEL[need])) fail('權限不足');
  return { user: p.u, role: acc.role, vendor: acc.vendor || '' };
}

/* ===================== 階段三：後台審核派工 ===================== */

function adminList_(who) {
  const full = ROLE_LEVEL[who.role] >= ROLE_LEVEL.handler;
  const comments = rows_('comments');
  const items = rows_('cases').map(function (r) {
    const it = publicItem_(r);
    it.source = r['來源']; it.desc = r['說明'];
    it.contact = full ? r['聯絡方式'] : mask_(r['聯絡方式']);
    it.email = full ? r['Email'] : mask_(r['Email']);
    it.line = !!r['LINE'];
    it.citizenPhotos = r['民眾照片'] ? String(r['民眾照片']).split(',').length : 0;
    it.handler = r['承辦人']; it.updated = iso_(r['更新時間']);
    it.contractId = r['契約編號']; it.dispatcher = r['派工人']; it.landChecked = !!r['地籍確認']; it.approvalNo = r['會勘簽核文號'];
    it.hasDoc = !!r['履約文件']; it.reportTime = iso_(r['回報時間']); it.docCode = r['驗收碼']; it.setHash = r['照片組雜湊'];
    it.acceptor = r['驗收人']; it.ratingText = r['評語'];
    it.photoHashes = photoMeta_(r['施工照片']);
    it.comments = comments.filter(function (c) { return c['案號'] === it.id; }).length;
    return it;
  });
  return { ok: true, items: items, role: who.role, user: who.user, statuses: STATUSES, types: TYPES };
}

function adminUpdate_(who, d) {
  const r = mustCase_(d.id);
  if (d.status && [ST.NEW, ST.REJECTED].indexOf(d.status) < 0) userError_('派工、驗收請使用專用功能');
  const patch = { '處理說明': clean_(d.reply, 300), '承辦人': who.user, '更新時間': new Date() };
  if (d.status) patch['狀態'] = d.status;
  update_('cases', r, patch);
  chain_(who.user, '狀態更新', d.id, { status: d.status || r['狀態'], reply: patch['處理說明'] });
  if (d.status && d.status !== r['狀態']) notifyCase_(r, '案件狀態更新為「' + d.status + '」' + (patch['處理說明'] ? '\n公所說明：' + patch['處理說明'] : ''));
  return { ok: true };
}

/** 電話輔助、里幹事協助：承辦人代為登錄（確保數位弱勢不被排除） */
function adminCreate_(who, d) {
  if (TYPES.indexOf(d.type) < 0) userError_('類別錯誤');
  if (!(Number(d.lat) > 23.0 && Number(d.lat) < 23.2 && Number(d.lng) > 120.1 && Number(d.lng) < 120.35)) userError_('位置超出範圍');
  const source = ['電話通報', '里幹事協助', '臨櫃通報', '巡查發現'].indexOf(d.source) >= 0 ? d.source : '電話通報';
  const res = createCase_(d, source, who.user);
  return res;
}

function adminDispatch_(who, d) {
  const r = mustCase_(d.id);
  if ([ST.NEW, ST.DISPATCHED].indexOf(r['狀態']) < 0) userError_('此案件狀態無法派工');
  // 防線一：地籍圖比對防私路公修
  if (d.landChecked !== true) userError_('請先套疊地籍圖，確認屬公眾通行道路後再派工');
  // 防線二：時間及空間雙重演算法警示 → 須會勘並簽奉核可
  const near = nearby_(Number(r['緯度']), Number(r['經度']), r['案號']);
  const approvalNo = clean_(d.approvalNo, 60).trim();
  if ((near.length || d.clientDup) && !approvalNo) userError_('此位置 3 年內方圓 50 公尺內有其他案件，須辦理會勘並填寫簽奉核可文號後始得派工');
  // 防線三：預算控管，超額派工自動阻斷
  const c = rows_('contracts').filter(function (x) { return x['契約編號'] === d.contractId; })[0];
  if (!c || c['狀態'] === '停用') userError_('請選擇有效的開口契約');
  const amount = Math.round(Number(d.amount));
  if (!(amount > 0)) userError_('請輸入派工金額');
  const used = contractUsed_(c['契約編號'], r['案號']);
  if (used + amount > Number(c['契約限額'])) userError_('派工金額超過契約限額（剩餘 ' + (Number(c['契約限額']) - used).toLocaleString() + ' 元），已自動阻斷');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) userError_('請選擇派工（排程）日期');
  update_('cases', r, {
    '狀態': ST.DISPATCHED, '契約編號': c['契約編號'], '廠商': c['廠商'], '派工金額': amount, '派工日期': d.date,
    '派工人': who.user, '地籍確認': 'Y', '會勘簽核文號': approvalNo, '處理說明': clean_(d.reply, 300) || r['處理說明'],
    '承辦人': who.user, '更新時間': new Date(),
  });
  chain_(who.user, '派工', r['案號'], { contract: c['契約編號'], vendor: c['廠商'], amount: amount, date: d.date, approvalNo: approvalNo, nearby: near.length });
  notifyCase_(r, '已派工，預定施工日期 ' + d.date + '，施工廠商：' + c['廠商']);
  return { ok: true, used: used + amount, limit: Number(c['契約限額']) };
}

function adminAccept_(who, d) {
  const r = mustCase_(d.id);
  if (r['狀態'] !== ST.DONE) userError_('廠商完工回報後才能驗收');
  update_('cases', r, { '狀態': ST.ACCEPTED, '驗收日期': new Date(), '驗收人': who.user, '處理說明': clean_(d.reply, 300) || '已完成修繕並驗收結案', '更新時間': new Date() });
  chain_(who.user, '驗收', r['案號'], { docCode: r['驗收碼'], setHash: r['照片組雜湊'] });
  notifyCase_(r, '已完成驗收結案，感謝您的通報！歡迎到案件頁給予評分：' + siteUrl_() + '#case=' + r['案號']);
  return { ok: true };
}

function adminReturn_(who, d) {
  const r = mustCase_(d.id);
  if (r['狀態'] !== ST.DONE) userError_('僅能退回已完工待驗收的案件');
  const reason = clean_(d.reason, 300).trim();
  if (!reason) userError_('請填寫退回原因');
  update_('cases', r, { '狀態': ST.DISPATCHED, '處理說明': '驗收退回：' + reason, '驗收碼': '', '照片組雜湊': '', '更新時間': new Date() });
  chain_(who.user, '退回', r['案號'], { reason: reason, voidDocCode: r['驗收碼'] });
  return { ok: true };
}

function adminReply_(who, d) {
  mustCase_(d.id);
  const text = clean_(d.text, 300).trim();
  if (!text) userError_('請輸入回覆內容');
  const cid = 'C' + Date.now().toString(36).toUpperCase();
  append_('comments', { '留言編號': cid, '時間': new Date(), '案號': d.id, '身分': '公所', '名稱': '安定區公所', '內容': text, '隱藏': '' });
  chain_(who.user, '公所回覆', d.id, { cid: cid, text: text });
  notifyCase_(findRow_('cases', d.id), '公所回覆：' + text);
  return { ok: true };
}

function adminHideComment_(who, d) {
  const c = findRow_('comments', d.cid, '留言編號');
  if (!c) userError_('找不到留言');
  update_('comments', c, { '隱藏': d.hidden ? 'Y' : '' });
  chain_(who.user, d.hidden ? '隱藏留言' : '顯示留言', c['案號'], { cid: d.cid });
  return { ok: true };
}

function adminComments_(who, d) {
  return { ok: true, items: rows_('comments').filter(function (c) { return c['案號'] === d.id; })
    .map(function (c) { return { cid: c['留言編號'], time: iso_(c['時間']), role: c['身分'], name: c['名稱'], text: c['內容'], hidden: !!c['隱藏'] }; }),
    events: rows_('chain').filter(function (c) { return c['案號'] === d.id; })
      .map(function (c) { return { seq: c['序號'], time: c['時間'], user: c['帳號'], event: c['事件'], detail: c['內容'], hash: c['雜湊'] }; }) };
}

/* ---------- 開口契約與預算控管 ---------- */

function contractUsed_(contractId, excludeCaseId) {
  return rows_('cases').reduce(function (s, r) {
    if (r['契約編號'] !== contractId || r['案號'] === excludeCaseId || r['狀態'] === ST.REJECTED) return s;
    return s + (Number(r['派工金額']) || 0);
  }, 0);
}

function contracts_(who) {
  return { ok: true, items: rows_('contracts').map(function (c) {
    const used = contractUsed_(c['契約編號']);
    return { id: c['契約編號'], name: c['契約名稱'], vendor: c['廠商'], year: c['年度'], limit: Number(c['契約限額']), used: used,
      remaining: Number(c['契約限額']) - used, status: c['狀態'] || '啟用' };
  }) };
}

function saveContract_(who, d) {
  const limit = Math.round(Number(d.limit));
  if (!String(d.name || '').trim() || !String(d.vendor || '').trim() || !(limit > 0)) userError_('請填寫契約名稱、廠商與限額');
  const existing = d.id ? findRow_('contracts', d.id, '契約編號') : null;
  if (existing) {
    const used = contractUsed_(existing['契約編號']);
    if (limit < used) userError_('限額不可低於已派工金額 ' + used.toLocaleString() + ' 元');
    update_('contracts', existing, { '契約名稱': clean_(d.name, 80), '廠商': clean_(d.vendor, 60), '年度': String(d.year || '').replace(/\D/g, '').slice(0, 3), '契約限額': limit, '狀態': d.status === '停用' ? '停用' : '啟用' });
    chain_(who.user, '修改契約', '', { id: existing['契約編號'], limit: limit, vendor: d.vendor });
    return { ok: true, id: existing['契約編號'] };
  }
  const year = String(d.year || '').replace(/\D/g, '').slice(0, 3);
  if (year.length !== 3) userError_('年度請填民國年 3 碼');
  const id = 'K' + year + '-' + ('0' + (rows_('contracts').filter(function (c) { return String(c['年度']) === year; }).length + 1)).slice(-2);
  append_('contracts', { '契約編號': id, '契約名稱': clean_(d.name, 80), '廠商': clean_(d.vendor, 60), '年度': year, '契約限額': limit, '狀態': '啟用', '建立時間': new Date() });
  chain_(who.user, '新增契約', '', { id: id, limit: limit, vendor: d.vendor });
  return { ok: true, id: id };
}

/* ---------- 帳號、設定、數位軌跡（管理者） ---------- */

function adminAccounts_(who) {
  const a = accounts_();
  return { ok: true, items: Object.keys(a).map(function (u) { return { user: u, role: a[u].role, vendor: a[u].vendor || '', disabled: !!a[u].disabled }; }) };
}

function adminSaveAccount_(who, d) {
  const user = String(d.user || '').trim().toLowerCase();
  if (user === who.user && d.role !== 'admin') userError_('不能變更自己的管理者權限');
  if (d.disabled && user === who.user) userError_('不能停用自己');
  try { setupAccount_(user, d.password || '', d.role, d.vendor); } catch (err) { userError_(err.message); }
  if (d.disabled) { const a = accounts_(); a[user].disabled = true; a[user].ver++; saveAccounts_(a); }
  chain_(who.user, '帳號設定', '', { user: user, role: d.role, vendor: d.vendor || '', pwdChanged: !!d.password, disabled: !!d.disabled });
  return { ok: true };
}

function adminDeleteAccount_(who, d) {
  const user = String(d.user || '').toLowerCase();
  if (user === who.user) userError_('不能刪除自己');
  const a = accounts_();
  delete a[user];
  saveAccounts_(a);
  chain_(who.user, '刪除帳號', '', { user: user });
  return { ok: true };
}

function adminSettings_(who, d) {
  const s = settings_();
  if (d.save) {
    s.notifyEmails = String(d.notifyEmails || '').split(/[,\s;]+/).filter(function (x) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x); }).slice(0, 10);
    s.siteUrl = /^https:\/\//.test(d.siteUrl || '') ? String(d.siteUrl).replace(/\/?$/, '/') : SITE_URL_DEFAULT;
    if (d.lineToken) s.lineToken = String(d.lineToken).trim();
    if (d.clearLineToken) s.lineToken = '';
    PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(s));
    chain_(who.user, '系統設定', '', { notifyEmails: s.notifyEmails.length, lineToken: !!s.lineToken });
  }
  return { ok: true, notifyEmails: (s.notifyEmails || []).join(', '), siteUrl: siteUrl_(), lineTokenSet: !!s.lineToken };
}

function adminLog_(who, d) {
  const rows = rows_('chain');
  return { ok: true, verify: verifyChain_(rows),
    items: rows.slice(-300).reverse().map(function (c) { return { seq: c['序號'], time: c['時間'], user: c['帳號'], event: c['事件'], id: c['案號'], detail: c['內容'], hash: c['雜湊'] }; }) };
}

/* ===================== 階段四：廠商施工驗收 ===================== */

function vendorList_(who) {
  const items = rows_('cases').filter(function (r) { return r['廠商'] === who.vendor && [ST.DISPATCHED, ST.DONE, ST.ACCEPTED].indexOf(r['狀態']) >= 0; })
    .map(function (r) {
      const it = publicItem_(r);
      it.desc = r['說明']; it.citizenPhotos = r['民眾照片'] ? String(r['民眾照片']).split(',').length : 0;
      it.docCode = r['驗收碼']; it.setHash = r['照片組雜湊']; it.reportTime = iso_(r['回報時間']);
      it.photoHashes = photoMeta_(r['施工照片']); it.hasDoc = !!r['履約文件'];
      return it;
    });
  return { ok: true, items: items, vendor: who.vendor, user: who.user };
}

function vendorUpload_(who, d) {
  const r = mustCase_(d.id);
  if (r['廠商'] !== who.vendor) userError_('權限不足');
  if (r['狀態'] !== ST.DISPATCHED) userError_('此案件目前無法回報');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.finishDate || ''))) userError_('請填寫完工日期');
  const valid = function (k) { return (d[k] || []).filter(function (x) { return /^data:image\//.test(String(x)); }).length; };
  if (!valid('before') || !valid('after')) userError_('施工前、施工後照片至少各 1 張');
  const meta = { before: [], during: [], after: [] };
  PHOTO_KINDS.forEach(function (k) { meta[k] = saveImages_(d[k], r['案號'] + '_' + KIND_NAME[k], 4); });
  if (!meta.before.length || !meta.after.length) userError_('施工前、施工後照片至少各 1 張');
  let docId = '';
  if (d.doc) {
    const m = String(d.doc).match(/^data:(application\/pdf|image\/jpeg|image\/png);base64,(.+)$/);
    if (!m || m[2].length > 7e6) userError_('履約文件須為 5MB 內的 PDF 或圖片');
    const bytes = Utilities.base64Decode(m[2]);
    docId = folder_().createFile(Utilities.newBlob(bytes, m[1], r['案號'] + '_履約文件')).getId() + ':' + sha256bytes_(bytes);
  }
  // QR-Code 數位防偽驗收鏈：文件產製當下即生成唯一驗收碼，並與照片組雜湊綁定
  const code = randomCode_(10);
  const setHash = sha256hex_([r['案號'], d.finishDate, code].concat(
    PHOTO_KINDS.map(function (k) { return meta[k].map(function (x) { return x.sha; }).join(','); }), [docId.split(':')[1] || '']).join('|'));
  update_('cases', r, { '狀態': ST.DONE, '施工照片': JSON.stringify(meta), '履約文件': docId, '完工日期': d.finishDate,
    '處理說明': String(r['處理說明']).indexOf('驗收退回') === 0 ? '廠商已依退回意見重新回報' : r['處理說明'],
    '回報時間': new Date(), '驗收碼': code, '照片組雜湊': setHash, '更新時間': new Date() });
  chain_(who.user, '完工回報', r['案號'], { code: code, setHash: setHash,
    photos: PHOTO_KINDS.reduce(function (o, k) { o[k] = meta[k].map(function (x) { return x.sha; }); return o; }, {}) });
  notifyCase_(r, '廠商已完工回報（完工日期 ' + d.finishDate + '），施工前後照片已公開於案件頁供全民檢視：' + siteUrl_() + '#case=' + r['案號']);
  notifyStaff_('【完工待驗收】' + r['案號'] + '（' + who.vendor + '）', '請至後台驗收：' + siteUrl_() + 'admin.html');
  return { ok: true, code: code, setHash: setHash, photoHashes: meta };
}

/** 驗證頁：掃描 QR-Code 後比對資料庫原始紀錄 */
function verifyDoc_(code) {
  code = String(code || '').toUpperCase();
  if (!/^[A-Z2-9]{10}$/.test(code)) return { ok: false, error: '驗收碼格式錯誤' };
  const r = rows_('cases').filter(function (x) { return x['驗收碼'] === code; })[0];
  if (!r) return { ok: false, error: '查無此驗收碼：文件可能遭偽造，或已被退回作廢' };
  const meta = photoMeta_(r['施工照片']);
  return { ok: true, item: publicItem_(r), code: code, setHash: r['照片組雜湊'], reportTime: iso_(r['回報時間']),
    photoHashes: { before: meta.before.map(function (x) { return x.sha; }), during: meta.during.map(function (x) { return x.sha; }), after: meta.after.map(function (x) { return x.sha; }) } };
}

/* ===================== 檔案 ===================== */

function saveImages_(list, prefix, max) {
  const out = [];
  (list || []).slice(0, max).forEach(function (dataUrl, i) {
    const m = String(dataUrl).match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (!m || m[2].length > 4e6) return;
    const bytes = Utilities.base64Decode(m[2]);
    const id = folder_().createFile(Utilities.newBlob(bytes, 'image/' + m[1], prefix + '_' + (i + 1) + '.jpg')).getId();
    out.push({ id: id, sha: sha256bytes_(bytes) });
  });
  return out;
}

function photoMeta_(json) {
  try { const m = JSON.parse(json || '{}'); return { before: m.before || [], during: m.during || [], after: m.after || [] }; }
  catch (err) { return { before: [], during: [], after: [] }; }
}

/** 後台／廠商讀檔：只能讀取案件本身登記的檔案，無法藉此讀取雲端硬碟其他檔案 */
function filePayload_(who, d) {
  const r = mustCase_(d.id);
  if (who.role === 'vendor' && r['廠商'] !== who.vendor) userError_('權限不足');
  const n = Number(d.n) || 0;
  if (d.kind === 'citizen') {
    const x = String(r['民眾照片'] || '').split(',').filter(String)[n];
    return fileData_(x ? { id: x.split(':')[0], sha: x.split(':')[1] } : null);
  }
  if (d.kind === 'doc') {
    const x = String(r['履約文件'] || '');
    return fileData_(x ? { id: x.split(':')[0], sha: x.split(':')[1] } : null);
  }
  if (PHOTO_KINDS.indexOf(d.kind) < 0) userError_('檔案類別錯誤');
  return fileData_(photoMeta_(r['施工照片'])[d.kind][n]);
}

function fileData_(x) {
  if (!x || !x.id) return { ok: false, error: '無此檔案' };
  const blob = DriveApp.getFileById(x.id).getBlob();
  return { ok: true, sha: x.sha, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function folder_() {
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

/* ===================== 通知（電子郵件／LINE 雙軌） ===================== */

function notifyCase_(r, msg) {
  notifyCitizen_(r, '【' + DISTRICT + '道路通報】' + r['案號'] + ' 進度更新', '案號：' + r['案號'] + '\n' + msg + '\n\n案件頁：' + siteUrl_() + '#case=' + r['案號']);
}

function notifyCitizen_(r, subject, body) {
  try { if (r['Email']) MailApp.sendEmail(String(r['Email']), subject, body + '\n\n（本信由系統自動發送，請勿直接回覆）'); } catch (err) { /* 配額不足不影響主流程 */ }
  if (r['LINE']) linePush_(String(r['LINE']), subject + '\n' + body);
}

function notifyStaff_(subject, body) {
  const list = settings_().notifyEmails || [];
  list.forEach(function (to) { try { MailApp.sendEmail(to, subject, body); } catch (err) { /* 略過 */ } });
}

function linePush_(userId, text) {
  const token = settings_().lineToken;
  if (!token) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
      payload: JSON.stringify({ to: userId, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }) });
  } catch (err) { /* 略過 */ }
}

function lineReply_(replyToken, text) {
  const token = settings_().lineToken;
  if (!token || !replyToken) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
      payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }) });
  } catch (err) { /* 略過 */ }
}

/** 民眾在官方帳號傳送「追蹤 案號 查詢碼」即綁定該案 LINE 通知（須有查詢碼，他人無法冒綁） */
function lineWebhook_(d) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    (d.events || []).forEach(function (ev) {
      const uid = ev.source && ev.source.userId;
      if (ev.type === 'follow') return lineReply_(ev.replyToken, '歡迎使用' + DISTRICT + '道路通報！\n請傳送「追蹤 案號 查詢碼」接收案件進度通知。');
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !uid) return;
      const m = String(ev.message.text).toUpperCase().match(/(AD\d{7}-\d{3})\s*([A-Z2-9]{8})/);
      if (!m) return lineReply_(ev.replyToken, '請傳送「追蹤 案號 查詢碼」，例如：追蹤 AD1151008-001 ABCD2345');
      const r = findRow_('cases', m[1]);
      if (!r || !safeEqual_(sha256hex_(m[2] + '|' + m[1]), r['查詢碼雜湊'])) return lineReply_(ev.replyToken, '案號或查詢碼錯誤，請再確認。');
      update_('cases', r, { 'LINE': uid });
      chain_('line', 'LINE綁定', m[1], {});
      lineReply_(ev.replyToken, '已綁定案件 ' + m[1] + '，目前狀態：' + r['狀態'] + '。之後的處理進度將以 LINE 通知您。');
    });
  } finally { lock.releaseLock(); }
  return json_({ ok: true });
}

/* ===================== 防機器人驗證碼 ===================== */

const STROKES = {   // 3×5 格點筆畫字型
  0: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]], 1: [[[0, 1], [1, 0], [1, 4]], [[0, 4], [2, 4]]],
  2: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 4], [2, 4]]], 3: [[[0, 0], [2, 0], [2, 4], [0, 4]], [[0, 2], [2, 2]]],
  4: [[[0, 0], [0, 2], [2, 2]], [[2, 0], [2, 4]]], 5: [[[2, 0], [0, 0], [0, 2], [2, 2], [2, 4], [0, 4]]],
  6: [[[2, 0], [0, 0], [0, 4], [2, 4], [2, 2], [0, 2]]], 7: [[[0, 0], [2, 0], [1, 4]]],
  8: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]], [[0, 2], [2, 2]]], 9: [[[2, 2], [0, 2], [0, 0], [2, 0], [2, 4], [0, 4]]],
};

function captcha_() {
  const digits = [];
  for (let i = 0; i < 4; i++) digits.push(String(Math.floor(Math.random() * 10)));
  const answer = digits.join('');
  const nonce = Utilities.getUuid();
  const payload = b64_(JSON.stringify({ h: sha256hex_(answer + '|' + nonce), n: nonce, exp: Date.now() + 10 * 60e3 }));
  const colors = ['#1B2A4A', '#1C5FC4', '#E3001B', '#2E7D32', '#8A4B00'];
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="54" viewBox="0 0 150 54"><rect width="150" height="54" rx="8" fill="#FFF8E7"/>';
  for (let i = 0; i < 6; i++) {
    svg += '<path d="M' + rnd_(0, 150) + ' ' + rnd_(0, 54) + ' Q' + rnd_(0, 150) + ' ' + rnd_(0, 54) + ' ' + rnd_(0, 150) + ' ' + rnd_(0, 54) +
      '" stroke="' + colors[i % 5] + '" stroke-width="' + rnd_(1, 2) + '" fill="none" opacity=".45"/>';
  }
  // 數字以筆畫路徑繪製（非文字節點），每點隨機抖動與旋轉，程式無法直接讀出答案
  digits.forEach(function (ch, i) {
    const ox = 14 + i * 33 + rnd_(-3, 3), oy = 10 + rnd_(-3, 3), rot = rnd_(-22, 22), sx = rnd_(8, 11), sy = rnd_(7, 9);
    const d = STROKES[ch].map(function (line) {
      return 'M' + line.map(function (pt) { return (pt[0] * sx + rnd_(-1, 1)) + ' ' + (pt[1] * sy + rnd_(-1, 1)); }).join(' L');
    }).join(' ');
    svg += '<path transform="translate(' + ox + ' ' + oy + ') rotate(' + rot + ' ' + sx + ' ' + (2 * sy) + ')" d="' + d + '" stroke="' + colors[Math.floor(Math.random() * 5)] +
      '" stroke-width="' + rnd_(3, 4) + '" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  });
  for (let i = 0; i < 30; i++) svg += '<circle cx="' + rnd_(0, 150) + '" cy="' + rnd_(0, 54) + '" r="1.2" fill="#1B2A4A" opacity=".35"/>';
  svg += '</svg>';
  return { ok: true, svg: svg, token: payload + '.' + sign_(payload) };
}

function checkCaptcha_(token, answer) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !safeEqual_(sign_(parts[0]), parts[1])) userError_('驗證碼錯誤，請重新輸入');
  let p;
  try { p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0] + '==='.slice((parts[0].length + 3) % 4))).getDataAsString()); }
  catch (err) { userError_('驗證碼錯誤，請重新輸入'); }
  if (Date.now() > p.exp) userError_('驗證碼已過期，請重新取得');
  const cache = CacheService.getScriptCache();
  if (cache.get('cap:' + p.n)) userError_('驗證碼已使用，請重新取得');
  cache.put('cap:' + p.n, '1', 900);                    // 一次性：用過即失效
  if (!safeEqual_(sha256hex_(String(answer || '').trim() + '|' + p.n), p.h)) userError_('驗證碼錯誤，請重新輸入');
}

/* ===================== 數位軌跡（雜湊鏈） ===================== */

function chain_(user, event, caseId, detail) {
  const props = PropertiesService.getScriptProperties();
  const head = JSON.parse(props.getProperty('CHAIN_HEAD') || '{"seq":0,"hash":"GENESIS"}');
  const seq = head.seq + 1, time = new Date().toISOString(), content = JSON.stringify(detail || {}).slice(0, 5000);
  user = String(user).replace(/[^a-z0-9._()一-鿿-]/gi, '').slice(0, 40) || '(空白)';
  const hash = sha256hex_([head.hash, seq, time, user, event, caseId || '', content].join('|'));
  // 全部以文字寫入（避免試算表把時間、雜湊自動轉成日期或數字），讀回時即為原值
  append_('chain', { '序號': seq, '時間': time, '帳號': user, '事件': event, '案號': caseId || '', '內容': content, '前一雜湊': head.hash, '雜湊': hash });
  props.setProperty('CHAIN_HEAD', JSON.stringify({ seq: seq, hash: hash }));
}

/** 重新計算整條雜湊鏈；任一列被修改、刪除或插入都會在該處斷鏈 */
function verifyChain_(rows) {
  rows = rows || rows_('chain');
  let prev = 'GENESIS';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const h = sha256hex_([prev, r['序號'], r['時間'], r['帳號'], r['事件'], r['案號'], r['內容']].join('|'));
    if (String(r['前一雜湊']) !== prev || String(r['雜湊']) !== h || Number(r['序號']) !== i + 1) return { ok: false, count: rows.length, brokenAt: i + 1 };
    prev = h;
  }
  const head = JSON.parse(PropertiesService.getScriptProperties().getProperty('CHAIN_HEAD') || '{"seq":0,"hash":"GENESIS"}');
  if (head.hash !== prev || head.seq !== rows.length) return { ok: false, count: rows.length, brokenAt: rows.length, tail: true };
  return { ok: true, count: rows.length, head: prev };
}

/* ===================== 試算表存取（以欄名對應，欄位順序可調整） ===================== */

function table_(key) {
  const def = SHEETS[key];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(def.name);
  if (!sh) { sh = ss.insertSheet(def.name); sh.appendRow(def.headers); sh.setFrozenRows(1); }
  let headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  const missing = def.headers.filter(function (h) { return headers.indexOf(h) < 0; });
  if (missing.length) {   // 自動補上新欄位（系統升級時）
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }
  return { sh: sh, headers: headers };
}

function cellValue_(v) { return v === undefined || v === null ? '' : typeof v === 'string' ? txt_(v) : v; }

function rows_(key) {
  const t = table_(key);
  const vals = t.sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const o = { _row: i + 1, _key: key };
    t.headers.forEach(function (h, j) { o[h] = vals[i][j] === undefined ? '' : vals[i][j]; });
    out.push(o);
  }
  return out;
}

function findRow_(key, id, col) {
  col = col || '案號';
  return rows_(key).filter(function (r) { return String(r[col]) === String(id); })[0] || null;
}

function mustCase_(id) {
  const r = findRow_('cases', id);
  if (!r) userError_('找不到案件');
  return r;
}

function append_(key, obj) {
  const t = table_(key);
  t.sh.appendRow(t.headers.map(function (h) { return cellValue_(obj[h]); }));
}

function update_(key, row, patch) {
  const t = table_(key);
  Object.keys(patch).forEach(function (k) {
    const j = t.headers.indexOf(k);
    if (j >= 0) { t.sh.getRange(row._row, j + 1, 1, 1).setValues([[cellValue_(patch[k])]]); row[k] = patch[k]; }
  });
}

/** 案號：AD + 民國年月日 + 當日流水號（例 AD1151008-001），鎖定下產生，唯一且寫入雜湊鏈 */
function nextCaseId_() {
  const now = new Date();
  const ymd = Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd');
  const prefix = 'AD' + (Number(ymd.slice(0, 4)) - 1911) + ymd.slice(4) + '-';
  const n = rows_('cases').filter(function (r) { return String(r['案號']).indexOf(prefix) === 0; }).length + 1;
  return prefix + ('00' + n).slice(-3);
}

/* ===================== 工具 ===================== */

function accounts_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('ACCOUNTS') || '{}'); }
function saveAccounts_(a) { PropertiesService.getScriptProperties().setProperty('ACCOUNTS', JSON.stringify(a)); }
function settings_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('SETTINGS') || '{}'); }
function siteUrl_() { return settings_().siteUrl || SITE_URL_DEFAULT; }

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

function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function sha256hex_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)); }
function sha256bytes_(bytes) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)); }
function sign_(payload) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_())).replace(/=+$/, ''); }
function b64_(s) { return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8).replace(/=+$/, ''); }
function rnd_(a, b) { return Math.round(a + Math.random() * (b - a)); }

function randomCode_(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now() + Math.random());
  let s = '';
  for (let i = 0; i < n; i++) s += chars[(bytes[i] & 255) % chars.length];
  return s;
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function distM_(lat1, lng1, lat2, lng2) {
  const k = Math.PI / 180, x = (lng2 - lng1) * k * Math.cos((lat1 + lat2) / 2 * k), y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * 6371008.8;
}

function mask_(s) {
  s = String(s || '');
  if (!s) return '';
  if (s.indexOf('@') > 0) return s.replace(/^(.)[^@]*/, '$1＊＊＊');
  return s.replace(/\d(?=\d{3})/g, '＊').replace(/^(\S)\S+/, '$1＊＊');
}

/** 使用者輸入：轉成字串並截斷長度（寫入試算表時再由 append_／update_ 統一強制為文字） */
function clean_(s, max) { return String(s == null ? '' : s).slice(0, max); }
/** 強制為文字：防公式注入，也避免電話 09xx、日期、雜湊被試算表自動轉成數字或日期 */
function txt_(s) { s = String(s == null ? '' : s); return s && /^([=+\-@']|[\d\s.,:\/-]+$|\d+e\d+$|\d{4}-\d{2}-\d{2}T|[0-9a-f]{64}$)/i.test(s) ? "'" + s : s; }
function userError_(msg) { const e = new Error(msg); e.userError = true; throw e; }
function iso_(v) { return v instanceof Date ? v.toISOString() : (v || ''); }
function dateStr_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
