/**
 * PortalToday.gs — 日本側の入口（スタッフ名鑑の「入口」画面）に出す「今日の数字」（2026-11-22）
 *
 * Daisuke「日本サイドは1つのダッシュボードがほしい…数字も。権限でどこまで見れるかを設定」
 *
 * 【流れ】
 *   名鑑の入口（samurai-staff-app）が、ログイン中の人の通行証（Supabase のアクセストークン）を付けて action=portal_today を呼ぶ
 *   → ここで Supabase に「この通行証の人の役割は？」と聞く（my_role。通行証が偽物・期限切れなら答えが返らない）
 *   → 役割に出してよい分だけ返す
 *       admin（全部）・exec（経営）… 売上 ＋ 出勤 ＋ そうじ ＋ 日本語
 *       member（メンバー）……………… 出勤 ＋ そうじ ＋ 日本語（売上は出さない）
 *       staff・それ以外 ………………… 何も出さない
 *
 * 【守り】
 *   - 聞きに行く先は下の PORTAL_SB_URL_ だけ（呼ぶ側が送ってきた宛先は使わない）
 *   - 鍵はここに置かない。apikey は名鑑の画面に載っている公開用の鍵で、呼ぶ側が一緒に送ってくる
 *   - 通行証そのものは保存しない（照合用の文字だけを5分キャッシュ）。中身は日報と同じ欄を読むだけで、書き込みはしない
 */

const PORTAL_SB_URL_ = 'https://vavtrzewmldmpwmtogef.supabase.co';   // スタッフ名鑑の Supabase（公開されている宛先・鍵ではない）
const PORTAL_ROLE_TTL_ = 300;   // 役割のキャッシュ（秒）
const PORTAL_DATA_TTL_ = 180;   // 数字のキャッシュ（秒）

/** 通行証 → 役割（'admin' | 'exec' | 'member' | 'staff' | ''）。だめな時は '' */
function portalRoleOf_(token, apikey) {
  if (!/^[A-Za-z0-9._-]{40,4096}$/.test(token) || !/^[A-Za-z0-9._-]{20,1024}$/.test(apikey)) return '';
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'portal-role-v1:' + token, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  const key = 'ptl_r_' + digest.substring(0, 40);
  const hit = cache.get(key);
  if (hit !== null) return hit === '-' ? '' : hit;
  let role = '';
  try {
    const res = UrlFetchApp.fetch(PORTAL_SB_URL_ + '/rest/v1/rpc/my_role', {
      method: 'post', contentType: 'application/json', payload: '{}', muteHttpExceptions: true,
      headers: { apikey: apikey, Authorization: 'Bearer ' + token }
    });
    if (res.getResponseCode() === 200) {
      const v = JSON.parse(res.getContentText());
      if (v === 'admin' || v === 'exec' || v === 'member' || v === 'staff') role = v;
    }
  } catch (err) {
    Logger.log('⚠️ 入口: 役割を確かめられませんでした');   // 通行証や宛先はログに出さない
    return '';   // 通信の失敗はキャッシュしない
  }
  cache.put(key, role || '-', role ? PORTAL_ROLE_TTL_ : 60);
  return role;
}

/** 日報用の文（HTML）→ 画面用のふつうの文の行 */
function portalLines_(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .split('\n').map(function (s) { return s.replace(/^[\s　]+/, ''); }).filter(function (s) { return s; });
}

/** 今日の出勤（プノンペンの日付）: ['Navin 7:02〜', 'Ron 7:55〜18:03'] */
function portalAttendanceLines_(ppToday) {
  const rows = getAllRows('勤怠記録');
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < 12; i--) {
    const r = rows[i];
    const d = r['日付'];
    const ds = Object.prototype.toString.call(d) === '[object Date]' ? Utilities.formatDate(d, getSheetTz_(), 'yyyy-MM-dd') : String(d || '').trim().substring(0, 10);
    if (ds !== ppToday) { if (ds && ds < ppToday) break; continue; }
    const name = String(r['氏名(JP)'] || r['スタッフID'] || '').substring(0, 30);
    const cin = formatTimeCell_(r['出勤時刻']), cout = formatTimeCell_(r['退勤時刻']);
    out.push(name + '　' + (cin || '–') + '〜' + (cout || ''));
  }
  return out.reverse();
}

/** 役割に合わせた「今日」のカード */
function portalBuildCards_(role, ppToday) {
  const cards = [];
  const add = function (icon, title, fn) {
    try { const lines = fn(); cards.push({ icon: icon, title: title, lines: lines.length ? lines : ['まだありません'] }); }
    catch (err) { Logger.log('⚠️ 入口: ' + title + ' を読めませんでした: ' + err); cards.push({ icon: icon, title: title, lines: ['読めませんでした'] }); }
  };
  if (role === 'admin' || role === 'exec') {
    add('💰', '売上', function () { return portalLines_(buildSalesSection_(ppToday)).filter(function (s) { return !/^💰/.test(s); }).slice(0, 12); });
  }
  add('🕘', '出勤', function () { return portalAttendanceLines_(ppToday); });
  add('🧹', 'そうじ', function () { return portalLines_(buildOsoujiSection_(ppToday)).map(function (s) { return s.replace(/^🧹\s*そうじ\s*/, ''); }); });
  add('📚', '日本語', function () { return portalLines_(buildNihongoSection_(ppToday)).map(function (s) { return s.replace(/^📚\s*日本語/, ''); }).filter(function (s) { return s; }); });
  return cards;
}

/**
 * 入口の「今日」
 * @param {Object} body - { token: Supabase のアクセストークン, apikey: 名鑑の公開用の鍵 }
 * @return {{ok:boolean, date?:string, cards?:Array, error?:string}}
 */
function portalToday_(body) {
  try {
    const role = portalRoleOf_(String((body && body.token) || ''), String((body && body.apikey) || ''));
    if (role !== 'admin' && role !== 'exec' && role !== 'member') return { ok: false, error: 'FORBIDDEN' };
    const level = role === 'member' ? 'member' : 'exec';   // admin と exec は同じ中身
    const ppToday = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
    const cache = CacheService.getScriptCache();
    const key = 'ptl_d_' + level + '_' + ppToday;
    const hit = cache.get(key);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* 作り直す */ } }
    const out = { ok: true, date: ppToday, at: Utilities.formatDate(new Date(), OPS_TZ, 'H:mm'), cards: portalBuildCards_(level, ppToday) };
    try { cache.put(key, JSON.stringify(out), PORTAL_DATA_TTL_); } catch (e) { /* 大きすぎる時はキャッシュしない */ }
    return out;
  } catch (err) {
    Logger.log('❌ 入口: ' + String(err).substring(0, 200));
    return { ok: false, error: 'SERVER' };
  }
}
