/**
 * 安定區道路通報後端（Google Apps Script）
 * 部署：見 gas/README.md
 * - POST {action:'report', ...}  新增通報（照片存入雲端硬碟資料夾）
 * - GET  ?action=list            取得公開通報清單（不含聯絡方式）
 * 公所人員直接在試算表「狀態」欄改為 待處理／處理中／已完成 即可同步到地圖看板。
 */
const SHEET_NAME = '通報';
const PHOTO_FOLDER_NAME = '安定區道路通報照片';
const HEADERS = ['案號', '通報時間', '類別', '說明', '緯度', '經度', '里別', '鄰近道路', '聯絡方式', '照片', '狀態', '處理說明'];
const TYPES = ['路面坑洞', '路面破損/龜裂', '邊坡坍方', '路樹倒塌', '雜草遮蔽', '排水阻塞/積水', '護欄/號誌損壞', '其他'];

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function folder_() {
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const d = JSON.parse(e.postData.contents);
    if (d.action !== 'report') return json_({ ok: false, error: 'unknown action' });
    const lat = Number(d.lat), lng = Number(d.lng);
    // 只接受安定區附近座標與既定類別，避免濫用
    if (!(lat > 23.0 && lat < 23.2 && lng > 120.1 && lng < 120.35)) return json_({ ok: false, error: '位置超出範圍' });
    if (TYPES.indexOf(d.type) < 0) return json_({ ok: false, error: '類別錯誤' });

    const id = 'AD' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyMMddHHmmss');
    const links = [];
    (d.photos || []).slice(0, 3).forEach(function (dataUrl, i) {
      const m = String(dataUrl).match(/^data:(image\/\w+);base64,(.+)$/);
      if (!m || m[2].length > 4e6) return;
      const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], id + '_' + (i + 1) + '.jpg');
      links.push(folder_().createFile(blob).getUrl());
    });

    sheet_().appendRow([
      id, new Date(), d.type, String(d.desc || '').slice(0, 300), lat, lng,
      String(d.village || ''), String(d.road || ''), String(d.contact || '').slice(0, 60),
      links.join('\n'), '待處理', ''
    ]);
    return json_({ ok: true, id: id });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  if ((e.parameter.action || '') !== 'list') return json_({ ok: true, service: '安定區道路通報' });
  const rows = sheet_().getDataRange().getValues().slice(1);
  const items = rows.slice(-300).map(function (r) {
    // 不輸出聯絡方式與照片連結（個資）
    return { id: r[0], time: r[1] instanceof Date ? r[1].toISOString() : r[1], type: r[2], desc: r[3],
             lat: r[4], lng: r[5], village: r[6], road: r[7], status: r[10], reply: r[11] };
  });
  return json_({ ok: true, items: items });
}
