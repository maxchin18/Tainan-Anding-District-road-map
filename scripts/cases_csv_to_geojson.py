"""
施工／維修案件 CSV → GeoJSON 轉檔，並自動登錄到 data/cases/index.json

CSV 欄位（第一列為標題，UTF-8 或 Big5 皆可；Excel 另存 CSV 即可）：
  標題, 類別, 里別, 派工日期, 完工日期, 廠商, 金額, X, Y, 備註
  - X, Y 可填 TWD97（例 171183, 2556083）或 WGS84 經緯度（例 120.2306, 23.1047）
  - 日期格式 2026-03-15 或 115/03/15（民國年會自動轉換）

用法：
  python scripts/cases_csv_to_geojson.py 檔案.csv --year 115 --label "115年道路養護維修"
"""
import argparse, csv, json, math, os, re, sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = os.path.join(ROOT, 'data', 'cases')


def twd97_to_wgs84(x, y):
    """TWD97 TM2 (中央經線 121°) 反算 WGS84，精度約公分級"""
    a, b = 6378137.0, 6356752.314245
    lon0, k0, dx = math.radians(121), 0.9999, 250000
    e = math.sqrt(1 - (b / a) ** 2)
    x -= dx
    M = y / k0
    mu = M / (a * (1 - e ** 2 / 4 - 3 * e ** 4 / 64 - 5 * e ** 6 / 256))
    e1 = (1 - math.sqrt(1 - e ** 2)) / (1 + math.sqrt(1 - e ** 2))
    J1, J2 = 3 * e1 / 2 - 27 * e1 ** 3 / 32, 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32
    J3, J4 = 151 * e1 ** 3 / 96, 1097 * e1 ** 4 / 512
    fp = mu + J1 * math.sin(2 * mu) + J2 * math.sin(4 * mu) + J3 * math.sin(6 * mu) + J4 * math.sin(8 * mu)
    e2 = (e * a / b) ** 2
    C1, T1 = e2 * math.cos(fp) ** 2, math.tan(fp) ** 2
    R1 = a * (1 - e ** 2) / (1 - e ** 2 * math.sin(fp) ** 2) ** 1.5
    N1 = a / math.sqrt(1 - e ** 2 * math.sin(fp) ** 2)
    D = x / (N1 * k0)
    Q1, Q2 = N1 * math.tan(fp) / R1, D ** 2 / 2
    Q3 = (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * e2) * D ** 4 / 24
    Q4 = (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 3 * C1 ** 2 - 252 * e2) * D ** 6 / 720
    lat = fp - Q1 * (Q2 - Q3 + Q4)
    Q6 = (1 + 2 * T1 + C1) * D ** 3 / 6
    Q7 = (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * e2 + 24 * T1 ** 2) * D ** 5 / 120
    lon = lon0 + (D - Q6 + Q7) / math.cos(fp)
    return math.degrees(lon), math.degrees(lat)


def to_lnglat(x, y):
    x, y = float(x), float(y)
    if x > 1000 and y > 1000:
        if x > y:
            x, y = y, x
        return twd97_to_wgs84(x, y)
    if x < y:  # 緯度在前
        x, y = y, x
    return x, y


def norm_date(s):
    s = (s or '').strip()
    m = re.match(r'^(\d{2,4})[/.-](\d{1,2})[/.-](\d{1,2})$', s)
    if not m:
        return s
    y = int(m.group(1))
    if y < 1911:
        y += 1911
    return f'{y:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'


def read_csv(path):
    for enc in ('utf-8-sig', 'cp950'):
        try:
            with open(path, encoding=enc, newline='') as f:
                return list(csv.DictReader(f))
        except UnicodeDecodeError:
            continue
    raise SystemExit('無法辨識 CSV 編碼，請另存為 UTF-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv')
    ap.add_argument('--year', required=True, help='民國年度，例如 115')
    ap.add_argument('--label', required=True, help='顯示名稱，例如「115年道路養護維修」')
    ap.add_argument('--out', help='輸出檔名（預設依 CSV 檔名）')
    a = ap.parse_args()

    feats = []
    for i, r in enumerate(read_csv(a.csv), 1):
        try:
            lng, lat = to_lnglat(r['X'], r['Y'])
        except (KeyError, ValueError):
            print(f'  第 {i} 筆座標錯誤，略過：{r}')
            continue
        feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(lng, 6), round(lat, 6)]},
                      'properties': {
                          'title': r.get('標題', '').strip(), 'type': r.get('類別', '').strip(),
                          'village': r.get('里別', '').strip(), 'dispatchDate': norm_date(r.get('派工日期')),
                          'finishDate': norm_date(r.get('完工日期')), 'vendor': r.get('廠商', '').strip(),
                          'amount': r.get('金額', '').replace(',', '').strip(), 'note': r.get('備註', '').strip()}})

    out = a.out or os.path.splitext(os.path.basename(a.csv))[0] + '.geojson'
    with open(os.path.join(CASES, out), 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f, ensure_ascii=False, indent=1)

    idx_path = os.path.join(CASES, 'index.json')
    with open(idx_path, encoding='utf-8') as f:
        idx = json.load(f)
    g = next((g for g in idx['groups'] if str(g['year']) == str(a.year)), None)
    if not g:
        g = {'year': str(a.year), 'items': []}
        idx['groups'].append(g)
        idx['groups'].sort(key=lambda g: -int(g['year']))
    g['items'] = [it for it in g['items'] if it['file'] != out] + [{'label': a.label, 'file': out}]
    with open(idx_path, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)
    print(f'完成：{len(feats)} 筆 → data/cases/{out}，已登錄於 {a.year} 年度「{a.label}」')


if __name__ == '__main__':
    main()
