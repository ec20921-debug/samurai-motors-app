// 現場アプリの動作確認用の偽サーバー（本番には一切つながない・2026-11-13）
//   使い方: node tests/mock_field_server.js <このリポジトリのフォルダ> 8795 → http://localhost:8795/ を開く
//   ※ 自動テスト（*.test.js）ではない。画面を手で触って「撮る → 開始 → 終了」を確かめる時に使う
//   - /field/ … 作業用フォルダの現場アプリを出す。本番の GAS の宛先 2つを、この偽サーバーの /gas・/ops に置き換えて出す
//   - /gas   … 予約Bot側の代わり（menu_prices / booking_today / field_partner_shops / job_* を受けて記録する）
//   - /ops   … 勤務Bot側の代わり（whoami だけ）
//   - /log   … 受けた送信の一覧（時刻・種類・大きさ・写真の番号）／ /ctl?delay=ms&down=1|0 … 応答の遅れと通信断の切り替え
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
const PORT = Number(process.argv[3] || 8795);
const log = [];
let delay = 1200, down = false, seq = 0;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
                '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg' };

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/log') return send(res, 200, log);
  if (u.pathname === '/ctl') {
    if (u.searchParams.has('delay')) delay = Number(u.searchParams.get('delay'));
    if (u.searchParams.has('down')) down = u.searchParams.get('down') === '1';
    if (u.searchParams.has('clear')) log.length = 0;
    return send(res, 200, { delay, down, n: log.length });
  }
  if (u.pathname === '/gas' || u.pathname === '/ops') {
    if (req.method === 'GET') {
      const a = u.searchParams.get('action');
      if (a === 'booking_today') return send(res, 200, { status: 'ok', bookings: [], calendar: [], caps: { pre_photo: 1 } });
      if (a === 'field_partner_shops') return send(res, 200, { status: 'ok', shops: [{ id: 'SHOP-MOCK', name: 'MOCK Auto（偽のお店）', rate: 30, linked: true }], residences: [] });
      return send(res, 200, { status: 'error', message: 'mock: ' + a });
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) {}
      if (down) { req.socket.destroy(); return; }   // 通信断のふり
      if (u.pathname === '/ops') {
        if (body.action === 'whoami') return send(res, 200, { ok: true, keyOk: true, staff: { staffId: 'STAFF-MOCK', nameJp: 'テスト', nameEn: 'Tester', role: 'admin' } });
        return send(res, 200, { ok: true, status: 'ok', client_id: body.client_id || '' });
      }
      const rec = { at: new Date().toISOString().slice(11, 23), action: body.action, size: raw.length, slot: body.slot || '', phase: body.phase || '',
                    inline: (body.beforePhotos || body.afterPhotos || []).length, refs: body.photo_refs || null, late: body.late || 0 };
      log.push(rec);
      const out = { status: 'ok', client_id: body.client_id || '' };
      if (body.action === 'job_photo') out.file_id = 'MOCKFILE' + String(++seq).padStart(4, '0') + '_' + body.slot;
      setTimeout(() => send(res, 200, out), delay);
    });
    return;
  }
  // 静的ファイル
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' ) { res.writeHead(302, { Location: '/field/?u=999&k=mock' }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '/field/sw.js') return send(res, 404, 'no service worker in mock', 'text/plain');   // 画面を端末に保存させない（確認のたびに最新を出す）
  const file = path.join(ROOT, rel);
  if (!file.startsWith(path.resolve(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
  let buf = fs.readFileSync(file);
  if (rel === '/field/index.html') {
    let s = buf.toString('utf8');
    const before = s;
    s = s.replace(/var GAS_URL = '[^']+';/, "var GAS_URL = 'http://localhost:" + PORT + "/gas';")
         .replace(/var OPS_URL = '[^']+';/, "var OPS_URL = 'http://localhost:" + PORT + "/ops';");
    if (s === before || /script\.google\.com\/macros/.test(s)) return send(res, 500, '宛先を置き換えられませんでした（本番につながないよう止めました）', 'text/plain; charset=utf-8');
    buf = Buffer.from(s, 'utf8');
  }
  send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, () => console.log('mock field server on http://localhost:' + PORT + ' root=' + ROOT));
