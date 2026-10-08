# 臺南市安定區公眾通行道路圖資系統

🔗 **線上版**：https://maxchin18.github.io/Tainan-Anding-District-road-map/

查詢安定區 13 里的農路、產業道路、區道，讓民眾回報路面問題，並公開施工／維修案件。
純靜態網站（GitHub Pages），手機、電腦都能用，也可「加入主畫面」當 App 使用。

| 功能 | 說明 |
|---|---|
| 🛣️ 道路 | 770 條道路依等級分色；可用關鍵字（路名／里別／編號）即時搜尋、依里篩選；點選即顯示長度、鋪面、行經里別，並提供導航與分享連結 |
| 🚧 施工 | 依年度勾選維修案件，顏色表示完工時間遠近；民眾通報看板；各里道路長度統計圖 |
| 📣 通報 | 四步驟：照片（自動讀取 GPS）→ 位置（GPS／點地圖／可拖曳微調）→ 狀況類別 → 送出 |
| 🧭 工具 | TWD97／WGS84 座標批次定位＋半徑圈（登革熱孳生源查詢）、點地圖查座標與鄰近道路、距離量測、地籍圖疊加、開放資料下載、列印 |
| 📰 公告 | 讀取 `data/news.json` |

---

## 參考網站分析與改進

參考對象：[臺南市山上區公眾通行道路圖資](https://smalldeer22-cpu.github.io/Tainana-Shanshang-District-farm-road-map/)

### 優點（保留）

- 依角色分流（民眾通報／公開查詢／廠商回報／巡查）
- 維修案件依年度分層公開，有里別統計，透明度高
- 座標工具支援 TWD97，貼近公所實務（登革熱半徑查詢、案件定位）
- 通報流程有照片與 GPS
- PWA，可加入手機主畫面

### 缺點與本系統的改進

| 參考網站的問題 | 安定區版的做法 |
|---|---|
| 單一 480 KB HTML，樣式大量 `!important`，難維護 | 拆成 `index.html`／`css`／`js`／`data`，設定集中在 `js/config.js` |
| 後端金鑰 `appKey` 寫在前端、密碼放在網址參數 | 前端不放任何密鑰；後端以白名單、範圍與大小限制過濾（見 `gas/`） |
| 每次開啟都載入 TensorFlow（約 1 MB 以上），手機很慢 | 只載入 Leaflet、proj4、exifr-lite，首頁輕量 |
| CDN 未鎖版本（`unpkg.com/leaflet`），哪天更新就可能壞掉 | 所有套件鎖定版本 |
| 道路選單是 100 多項的下拉清單，難找 | 即時搜尋＋關鍵字高亮、依等級晶片與里別篩選、依長度／名稱排序 |
| 所有道路同一個藍色，沒有圖例 | 五級道路分色＋白色描邊（插畫風）、常駐圖例、粗細隨縮放調整 |
| 開啟時有遮擋地圖的選單 | 首次導覽可關閉、可「不再顯示」；之後直接進入地圖 |
| `user-scalable=no` 禁止縮放，不利長者與視障 | 允許縮放、鍵盤可操作、ARIA 標記 |
| 登革熱分頁與座標工具功能重複 | 合併為「座標定位／半徑查詢」 |
| 選取道路後無法分享 | 每條道路有固定網址（`#road=AD07-001`），可直接傳 LINE |
| 手機上側欄佔滿畫面 | 底部抽屜（三段：收合／半開／全開），拖曳地圖時自動收合 |

### 視覺風格

以扁平插畫資訊圖表為參考：米白紙底、粗墨色描邊與實心陰影、品牌藍標題、紅色重點、
橘色蜿蜒道路、藍色河流與綠色田野（頁首插畫即安定區曾文溪畔的意象）。

---

## 資料來源

| 圖資 | 來源 | 授權 |
|---|---|---|
| 道路、里界、區界 | © [OpenStreetMap](https://www.openstreetmap.org/copyright) 貢獻者 | ODbL |
| 底圖、正射影像、地籍 | 內政部國土測繪中心 WMTS | 政府資料開放授權 |
| 淺灰底圖 | Esri World Light Gray | Esri 條款 |

> 道路名稱以 OSM 為準；**未命名道路暫以「○○里農路 07」編號**，請公所依實際名稱校正。
> 本系統圖資僅供參考，實際道路權屬與範圍以權管機關現場鑑界為準。

## 維護

```
index.html            頁面
css/style.css         樣式（配色變數在 :root）
js/config.js          設定（後端網址、通報類別、道路配色）
js/app.js             主程式
data/roads.geojson    道路（由 scripts/build_data.py 產生）
data/villages.geojson 里界＋各里道路統計
data/boundary.geojson 區界
data/cases/           施工／維修案件（格式見該資料夾 README）
data/news.json        公告
data/raw/             OSM 原始資料
gas/                  通報後端（Google Apps Script）
scripts/              資料處理腳本
```

### 更新道路圖資

```bash
# 1. 重新下載 OSM 原始資料（Overpass API）
curl -o data/raw/roads_osm.json --data-urlencode "data@scripts/q_roads.txt" https://overpass-api.de/api/interpreter
curl -o data/raw/vil_osm.json  --data-urlencode "data@scripts/q_vil.txt"  https://overpass-api.de/api/interpreter
# 2. 重新產生 GeoJSON
python scripts/build_data.py
```

### 新增施工案件

```bash
python scripts/cases_csv_to_geojson.py 115養護.csv --year 115 --label "115年道路及公共設施養護維修"
```

### 新增公告

編輯 `data/news.json`，加一筆 `{ "date": "2026-10-08", "title": "…", "body": "…" }`。

### 啟用民眾通報後端

依 [`gas/README.md`](gas/README.md) 部署 Apps Script，把網址填入 `js/config.js` 的 `reportEndpoint`。
未設定時，通報會暫存在使用者手機並產生可列印的通報單。

### 本機預覽

```bash
python -m http.server 8765
```
