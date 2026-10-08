/* 系統設定：公所可直接修改此檔，不需動到 app.js */
window.APP_CONFIG = {
  district: '臺南市安定區',
  center: [23.1005, 120.2285],
  zoom: 13,

  /* 道路通報後端（Google Apps Script Web App 網址）
     部署方式見 gas/README.md；留空時通報僅暫存於使用者瀏覽器並可下載通報單。 */
  reportEndpoint: '',

  /* LINE 官方帳號 ID（例：'@123abcde'）。設定後，通報成功頁會出現「LINE 接收進度」按鈕；
     另需在後台「設定」填入 Messaging API Channel Access Token，並把 Webhook URL 設為後端網址。 */
  lineOaId: '',

  /* 公所聯絡資訊（留空則不顯示） */
  officePhone: '',
  officeEmail: '',

  /* 通報類別 */
  issueTypes: ['路面坑洞', '路面破損/龜裂', '邊坡坍方', '路樹倒塌', '雜草遮蔽', '排水阻塞/積水', '護欄/號誌損壞', '其他'],

  /* 道路等級顏色（扁平插畫配色） */
  roadClasses: {
    main:  { name: '省道/市道',   color: '#E3001B', weight: 6 },
    dist:  { name: '區道',        color: '#1C5FC4', weight: 5 },
    local: { name: '一般道路',    color: '#5B6B8C', weight: 3.5 },
    farm:  { name: '農路/產業道路', color: '#F39200', weight: 3.5 },
    lane:  { name: '巷道',        color: '#9AA3B5', weight: 2 }
  }
};
