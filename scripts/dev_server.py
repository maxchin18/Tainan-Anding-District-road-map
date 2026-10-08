"""
本機開發測試伺服器：提供網站靜態檔，並以 /api 模擬 gas/Code.gs 的通報與後台 API。
僅供本機測試，資料存在記憶體，關閉即消失。正式環境請部署 gas/Code.gs。

  python scripts/dev_server.py            # http://localhost:8766
測試帳號（僅本機）：demo-admin / demo-handler / demo-viewer，密碼皆為 local-test-only
"""
import base64, hashlib, hmac, json, os, secrets, sys, time, uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', 8766))
SECRET = secrets.token_bytes(32)
TYPES = ['路面坑洞', '路面破損/龜裂', '邊坡坍方', '路樹倒塌', '雜草遮蔽', '排水阻塞/積水', '護欄/號誌損壞', '其他']
STATUSES = ['待處理', '處理中', '已完成', '不受理']
LEVEL = {'viewer': 1, 'handler': 2, 'admin': 3}
PWD = 'local-test-only'
ACCOUNTS = {u: {'role': r, 'ver': 1} for u, r in [('demo-admin', 'admin'), ('demo-handler', 'handler'), ('demo-viewer', 'viewer')]}
FAILS = {}
LOG = []
# 1x1 PNG 作為示範照片
PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
REPORTS = [
    {'id': 'TEST001', 'time': '2026-10-01T02:10:00Z', 'type': '路面坑洞', 'desc': '【測試資料】坑洞約一公尺', 'lat': 23.104681, 'lng': 120.230568,
     'village': '港尾里', 'road': '港尾里農路 09', 'contact': '測試者 0912345678', 'photos': [PIXEL], 'status': '待處理', 'reply': '', 'handler': '', 'updated': ''},
    {'id': 'TEST002', 'time': '2026-10-03T05:30:00Z', 'type': '路樹倒塌', 'desc': '【測試資料】樹倒擋路', 'lat': 23.1007, 'lng': 120.2141,
     'village': '海寮里', 'road': '海寮里農路 11', 'contact': '', 'photos': [], 'status': '處理中', 'reply': '已派員', 'handler': 'demo-handler', 'updated': '2026-10-03T08:00:00Z'},
    {'id': 'TEST003', 'time': '2026-09-20T01:00:00Z', 'type': '排水阻塞/積水', 'desc': '=HYPERLINK("x") 公式注入測試', 'lat': 23.112, 'lng': 120.22,
     'village': '文科里', 'road': '', 'contact': '', 'photos': [], 'status': '已完成', 'reply': '已清淤', 'handler': 'demo-handler', 'updated': '2026-09-22T01:00:00Z'},
]


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def b64(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')


def sign(payload):
    return b64(hmac.new(SECRET, payload.encode(), hashlib.sha256).digest())


def mask(s):
    import re
    s = s or ''
    s = re.sub(r'\d(?=\d{3})', '＊', s)
    return re.sub(r'^(\S)\S+', r'\1＊＊', s)


class AuthError(Exception):
    pass


def auth(token, need):
    try:
        p64, sig = str(token or '').split('.')
        if not hmac.compare_digest(sign(p64), sig):
            raise AuthError('請重新登入')
        p = json.loads(base64.urlsafe_b64decode(p64 + '=' * (-len(p64) % 4)))
    except AuthError:
        raise
    except Exception:
        raise AuthError('請重新登入')
    if time.time() * 1000 > p['exp']:
        raise AuthError('登入逾時，請重新登入')
    acc = ACCOUNTS.get(p['u'])
    if not acc or acc['ver'] != p['v']:
        raise AuthError('帳號已變更，請重新登入')
    if LEVEL[acc['role']] < LEVEL[need]:
        raise AuthError('權限不足')
    return {'user': p['u'], 'role': acc['role']}


def handle_post(d):
    a = d.get('action')
    if a == 'report':
        lat, lng = float(d.get('lat', 0)), float(d.get('lng', 0))
        if not (23.0 < lat < 23.2 and 120.1 < lng < 120.35):
            return {'ok': False, 'error': '位置超出範圍'}
        if d.get('type') not in TYPES:
            return {'ok': False, 'error': '類別錯誤'}
        rid = 'AD' + datetime.now().strftime('%y%m%d%H%M%S')
        REPORTS.append({'id': rid, 'time': now(), 'type': d['type'], 'desc': str(d.get('desc', ''))[:300], 'lat': lat, 'lng': lng,
                        'village': d.get('village', ''), 'road': d.get('road', ''), 'contact': str(d.get('contact', ''))[:60],
                        'photos': [p for p in (d.get('photos') or [])[:3] if str(p).startswith('data:image/')],
                        'status': '待處理', 'reply': '', 'handler': '', 'updated': ''})
        return {'ok': True, 'id': rid}
    if a == 'login':
        user = str(d.get('user', '')).strip().lower()
        if FAILS.get(user, 0) >= 5:
            return {'ok': False, 'error': '嘗試次數過多，請 15 分鐘後再試'}
        acc = ACCOUNTS.get(user)
        if not acc or not hmac.compare_digest(str(d.get('pwd', '')), PWD):
            FAILS[user] = FAILS.get(user, 0) + 1
            LOG.append({'time': now(), 'user': user, 'action': 'loginFail', 'detail': ''})
            return {'ok': False, 'error': '帳號或密碼錯誤'}
        FAILS.pop(user, None)
        exp = int(time.time() * 1000 + 8 * 3600e3)
        payload = b64(json.dumps({'u': user, 'r': acc['role'], 'v': acc['ver'], 'exp': exp}).encode())
        LOG.append({'time': now(), 'user': user, 'action': 'login', 'detail': ''})
        return {'ok': True, 'token': payload + '.' + sign(payload), 'user': user, 'role': acc['role'], 'exp': exp}
    if a == 'adminList':
        who = auth(d.get('token'), 'viewer')
        full = LEVEL[who['role']] >= LEVEL['handler']
        items = [{**{k: v for k, v in r.items() if k != 'photos'}, 'photos': len(r['photos']),
                  'contact': r['contact'] if full else mask(r['contact'])} for r in REPORTS]
        return {'ok': True, 'items': items, 'role': who['role'], 'user': who['user'], 'statuses': STATUSES}
    if a == 'adminPhoto':
        auth(d.get('token'), 'viewer')
        r = next((r for r in REPORTS if r['id'] == d.get('id')), None)
        n = int(d.get('n') or 0)
        if not r or n >= len(r['photos']):
            return {'ok': False, 'error': '無此照片'}
        return {'ok': True, 'data': r['photos'][n]}
    if a == 'adminUpdate':
        who = auth(d.get('token'), 'handler')
        if d.get('status') not in STATUSES:
            return {'ok': False, 'error': '狀態錯誤'}
        r = next((r for r in REPORTS if r['id'] == d.get('id')), None)
        if not r:
            return {'ok': False, 'error': '找不到案件'}
        r.update(status=d['status'], reply=str(d.get('reply', ''))[:300], handler=who['user'], updated=now())
        LOG.append({'time': now(), 'user': who['user'], 'action': 'update', 'detail': f"{r['id']} → {d['status']}"})
        return {'ok': True, 'updated': r['updated'], 'handler': who['user']}
    if a == 'adminLog':
        auth(d.get('token'), 'admin')
        return {'ok': True, 'items': LOG[::-1][:200]}
    return {'ok': False, 'error': 'unknown action'}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/js/config.js':
            src = open(os.path.join(ROOT, 'js', 'config.js'), encoding='utf-8').read()
            b = (src + f"\nwindow.APP_CONFIG.reportEndpoint = 'http://localhost:{PORT}/api';\n").encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.end_headers()
            self.wfile.write(b)
            return
        if u.path == '/api':
            if parse_qs(u.query).get('action') == ['list']:
                return self._json({'ok': True, 'items': [{k: r[k] for k in ('id', 'time', 'type', 'lat', 'lng', 'village', 'road', 'status', 'reply')} for r in REPORTS]})
            return self._json({'ok': True})
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != '/api':
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        try:
            d = json.loads(body)
            self._json(handle_post(d))
        except AuthError as e:
            self._json({'ok': False, 'error': str(e), 'auth': True})
        except Exception:
            self._json({'ok': False, 'error': '系統錯誤'})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    print(f'開發伺服器：http://localhost:{PORT}  （後台 /admin.html，帳號 demo-admin / demo-handler / demo-viewer，密碼 {PWD}）')
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
