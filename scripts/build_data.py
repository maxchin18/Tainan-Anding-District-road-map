"""
安定區道路圖資建置腳本
將 OpenStreetMap (Overpass) 原始資料轉為前端使用的 GeoJSON：
  data/boundary.geojson   安定區界
  data/villages.geojson   各里界（含面積、道路統計）
  data/roads.geojson      公眾通行道路（依名稱/連通性合併、分級、計算長度）

用法：
  python scripts/build_data.py            # 使用 data/raw/*.json
重新抓取原始資料請見 README「更新圖資」。
"""
import json, math, os, collections, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
OUT = os.path.join(ROOT, 'data')
DISTRICT_REL = 2222077  # OSM relation：臺南市安定區

sys.stdout.reconfigure(encoding='utf-8')


def load(name):
    with open(os.path.join(RAW, name), encoding='utf-8') as f:
        return json.load(f)


def dump(obj, name):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  寫入 {name} ({os.path.getsize(os.path.join(OUT, name)) // 1024} KB)')


R = 6371008.8


def dist_m(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    dx = math.radians(b[0] - a[0]) * math.cos(lat)
    dy = math.radians(b[1] - a[1])
    return R * math.hypot(dx, dy)


def line_len(coords):
    return sum(dist_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def ring_area_m2(ring):
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    pts = [(math.radians(p[0]) * math.cos(lat0) * R, math.radians(p[1]) * R) for p in ring]
    s = 0
    for i in range(len(pts) - 1):
        s += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
    return abs(s) / 2


def stitch(ways):
    """把 relation 的 outer way 片段接成封閉環"""
    segs = [list(w) for w in ways if len(w) > 1]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s + cur[1:]
                elif s[0] == cur[0]:
                    cur = s[::-1] + cur[1:]
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if cur[0] != cur[-1]:
            cur.append(cur[0])
        if len(cur) >= 4:
            rings.append(cur)
    return rings


def rel_polygon(rel):
    outer = [[(round(p['lon'], 7), round(p['lat'], 7)) for p in m['geometry']]
             for m in rel['members'] if m['type'] == 'way' and m.get('role') in ('outer', '') and 'geometry' in m]
    rings = [[list(p) for p in r] for r in stitch(outer)]
    rings.sort(key=ring_area_m2, reverse=True)
    return rings


def pip(pt, ring):
    x, y = pt
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def in_rings(pt, rings):
    return any(pip(pt, r) for r in rings)


def midpoint(coords):
    total = line_len(coords)
    if total == 0:
        return coords[0]
    half, acc = total / 2, 0
    for i in range(len(coords) - 1):
        d = dist_m(coords[i], coords[i + 1])
        if acc + d >= half:
            t = (half - acc) / d if d else 0
            return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
                    coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t]
        acc += d
    return coords[-1]


def bbox_of(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return [min(xs), min(ys), max(xs), max(ys)]


# ---------- 區界與里界 ----------
print('處理行政界…')
adm = load('vil_osm.json')['elements']
district = next(e for e in adm if e['id'] == DISTRICT_REL)
d_rings = rel_polygon(district)
d_ring = d_rings[0]
dump({'type': 'FeatureCollection', 'features': [{
    'type': 'Feature',
    'properties': {'name': '安定區', 'area_km2': round(ring_area_m2(d_ring) / 1e6, 2)},
    'geometry': {'type': 'Polygon', 'coordinates': [d_ring]}}]}, 'boundary.geojson')

villages = []
for e in adm:
    if e['tags'].get('admin_level') != '9':
        continue
    rings = rel_polygon(e)
    if not rings:
        continue
    # 以最大環的重心判斷是否位於安定區內
    big = rings[0]
    cx = sum(p[0] for p in big[:-1]) / (len(big) - 1)
    cy = sum(p[1] for p in big[:-1]) / (len(big) - 1)
    if not pip((cx, cy), d_ring):
        continue
    villages.append({'name': e['tags']['name'], 'rings': rings, 'osm': e['id']})
villages.sort(key=lambda v: v['name'])
print('  安定區各里：', '、'.join(v['name'] for v in villages), f'（共 {len(villages)} 里）')


def village_of(pt):
    for v in villages:
        if in_rings(pt, v['rings']):
            return v['name']
    return None


# ---------- 道路 ----------
print('處理道路…')
ways = load('roads_osm.json')['elements']

CLASSES = {
    'main':  '省道/市道',
    'dist':  '區道',
    'local': '一般道路',
    'farm':  '農路/產業道路',
    'lane':  '巷道',
}


def classify(t):
    hw = t['highway']
    ref = t.get('ref', '')
    if hw in ('trunk', 'primary', 'secondary') or (ref and not ref.startswith('南')):
        return 'main'
    if hw == 'tertiary' or ref.startswith('南'):
        return 'dist'
    if hw == 'service' and t.get('service') == 'alley':
        return 'lane'
    if hw in ('residential', 'living_street'):
        return 'local' if t.get('name') else 'lane'
    if hw == 'unclassified':
        return 'local' if t.get('name') else 'farm'
    return 'farm'  # track / 一般 service


def ref_label(ref, name=''):
    if '高速' in name or '國道' in name:
        return '、'.join(f'國道{r.strip()}號' for r in ref.split(';') if r.strip())
    out = []
    for r in ref.split(';'):
        r = r.strip()
        if not r:
            continue
        if r.startswith('南'):
            out.append(r)
        elif (m := re.match(r'^(\d+)(\D*)$', r)) and int(m.group(1)) < 100:
            out.append(f'台{r}線')
        else:
            out.append(f'市道{r}')
    return '、'.join(out)


segs = []
for w in ways:
    t = w.get('tags', {})
    if t.get('access') in ('private', 'no') or t.get('service') in ('driveway', 'parking_aisle'):
        continue
    if t.get('area') == 'yes':
        continue
    coords = [[round(p['lon'], 7), round(p['lat'], 7)] for p in w['geometry']]
    if len(coords) < 2:
        continue
    mid = midpoint(coords)
    if not pip(mid, d_ring):
        continue
    cls = classify(t)
    length = line_len(coords)
    if cls in ('farm', 'lane') and length < 25:
        continue  # 過短的私人出入口片段
    segs.append({
        'osm': w['id'], 'nodes': (tuple(coords[0]), tuple(coords[-1])), 'coords': coords,
        'cls': cls, 'name': t.get('name', '').strip(), 'ref': t.get('ref', '').strip(),
        'surface': t.get('surface', ''), 'width': t.get('width', ''), 'lanes': t.get('lanes', ''),
        'village': village_of(mid), 'len': length, 'hw': t['highway'],
    })
print(f'  區內道路片段 {len(segs)} 段')

# 名稱鍵：有名稱以名稱合併；只有編號以編號合併；皆無則依「同里、同級、端點相連」合併
groups = collections.OrderedDict()
parent = {}


def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


unnamed = [i for i, s in enumerate(segs) if not s['name'] and not s['ref']]
for i in unnamed:
    parent[i] = i
by_node = collections.defaultdict(list)
for i in unnamed:
    for n in segs[i]['nodes']:
        by_node[(n, segs[i]['village'], segs[i]['cls'])].append(i)
for lst in by_node.values():
    for j in lst[1:]:
        a, b = find(lst[0]), find(j)
        if a != b:
            parent[b] = a

for i, s in enumerate(segs):
    if s['name']:
        key = ('n', s['name'])
    elif s['ref']:
        key = ('r', s['ref'])
    else:
        key = ('u', find(i))
    groups.setdefault(key, []).append(s)

order = {'main': 0, 'dist': 1, 'local': 2, 'farm': 3, 'lane': 4}
roads = []
for key, items in groups.items():
    cls = min((s['cls'] for s in items), key=order.get)
    vills = collections.Counter()
    for s in items:
        if s['village']:
            vills[s['village']] += s['len']
    vlist = [v for v, _ in vills.most_common()]
    refs = sorted({s['ref'] for s in items if s['ref']})
    roads.append({
        'key': key, 'items': items, 'cls': cls, 'villages': vlist,
        'name': items[0]['name'], 'ref': '；'.join(refs),
        'len': sum(s['len'] for s in items),
        'surface': collections.Counter(s['surface'] for s in items if s['surface']).most_common(1),
    })

# 無名道路命名：「○○里 農路 07」，依長度排序編號
counter = collections.defaultdict(int)
roads.sort(key=lambda r: (r['villages'][0] if r['villages'] else '~', order[r['cls']], -r['len']))
SURF = {'asphalt': '瀝青', 'concrete': '混凝土', 'paved': '鋪面', 'unpaved': '未鋪面', 'gravel': '碎石',
        'dirt': '土路', 'ground': '土路', 'compacted': '夯實土石', 'paving_stones': '連鎖磚'}
features = []
for r in roads:
    vmain = r['villages'][0] if r['villages'] else '安定區'
    if r['name']:
        name = r['name']
    elif r['ref']:
        name = ref_label(r['ref'], r['name'])
    else:
        counter[(vmain, r['cls'])] += 1
        short = {'farm': '農路', 'lane': '巷道', 'local': '道路', 'dist': '區道', 'main': '道路'}[r['cls']]
        name = f'{vmain}{short} {counter[(vmain, r["cls"])]:02d}'
    lines = [s['coords'] for s in r['items']]
    xs = [p[0] for l in lines for p in l]
    ys = [p[1] for l in lines for p in l]
    features.append({
        'type': 'Feature',
        'properties': {
            'name': name,
            'named': bool(r['name'] or r['ref']),
            'ref': ref_label(r['ref'], r['name']) if r['ref'] else '',
            'cls': r['cls'],
            'clsName': CLASSES[r['cls']],
            'villages': r['villages'],
            'length_m': round(r['len']),
            'surface': SURF.get(r['surface'][0][0], r['surface'][0][0]) if r['surface'] else '',
            'segments': len(lines),
            'osm': [s['osm'] for s in r['items']],
            'bbox': [round(min(xs), 6), round(min(ys), 6), round(max(xs), 6), round(max(ys), 6)],
        },
        'geometry': {'type': 'MultiLineString', 'coordinates': lines} if len(lines) > 1
        else {'type': 'LineString', 'coordinates': lines[0]},
    })

# 編號：AD-里序-流水
vidx = {v['name']: i + 1 for i, v in enumerate(villages)}
seq = collections.defaultdict(int)
for f in features:
    v = f['properties']['villages'][0] if f['properties']['villages'] else None
    k = vidx.get(v, 0)
    seq[k] += 1
    f['properties']['id'] = f'AD{k:02d}-{seq[k]:03d}'

dump({'type': 'FeatureCollection',
      'metadata': {'source': 'OpenStreetMap contributors (ODbL)', 'district': '臺南市安定區'},
      'features': features}, 'roads.geojson')

# 里界與統計
stats = collections.defaultdict(lambda: collections.Counter())
for s in segs:
    if s['village']:
        stats[s['village']][s['cls']] += s['len']
vf = []
for v in villages:
    rings = v['rings']
    vf.append({'type': 'Feature', 'properties': {
        'name': v['name'],
        'area_km2': round(sum(ring_area_m2(r) for r in rings) / 1e6, 2),
        'road_m': {k: round(stats[v['name']][k]) for k in CLASSES},
        'bbox': [round(x, 6) for x in bbox_of(rings)],
    }, 'geometry': {'type': 'Polygon', 'coordinates': [rings[0]]} if len(rings) == 1
        else {'type': 'MultiPolygon', 'coordinates': [[r] for r in rings]}})
dump({'type': 'FeatureCollection', 'features': vf}, 'villages.geojson')

cnt = collections.Counter(f['properties']['cls'] for f in features)
tot = collections.Counter()
for f in features:
    tot[f['properties']['cls']] += f['properties']['length_m']
for k in CLASSES:
    print(f'  {CLASSES[k]}：{cnt[k]} 條，{tot[k] / 1000:.1f} km')
print(f'  合計 {len(features)} 條道路')
