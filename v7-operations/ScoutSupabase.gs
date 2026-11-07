/**
 * ScoutSupabase.gs — SAMURAI SCOUT（saleslog-internal.html）を速く開くための「読み取り用の写し」（2026-11-07）
 *
 * Daisuke「読み込み遅いから supabase に移行できないかな？無料でできれば」→ 案 B（SCOUT だけ・無料の Supabase）
 *
 * 考え方: 台帳は今までどおりシート（v7 Database）の1つだけ。Supabase はその「写し」で、SCOUT は写しを読む。
 *   - 書き込み（訪問・メモ・店の情報・QR）は今までどおり GAS → シート。書いた直後は、その店の詳細の写しを消すだけ
 *     （重い作り直しはしない。次に開いた時は GAS から読み、その結果をまた写す）
 *   - お店の一覧は、GAS で一覧を作った時（SCOUT が書いたあとに読み直す時など）と、
 *     10分ごとのトリガー（scoutSbSync）で丸ごと写す（シートを手で直した分もここで届く）
 *     → この定期の書き込みが Supabase の「利用」になるので、無料版の「7日使わないと止まる」にもかからない
 *   - 店の詳細（訪問の履歴など）は、GAS で詳細を作った時と書いた時に、その店の分だけ写す
 *   - SCOUT は「通行証」（scout_token・7日）で写しを読む。通行証は GAS がスタッフを確かめてから渡す。
 *     Supabase 側は通行証のハッシュだけを持ち、写しの表は直接読めない（RLS・読むのは関数 scout_read だけ）
 *
 * 設定（Script Properties・3つ。無ければこの仕組みは丸ごと止まり、SCOUT は今までどおり GAS から読む）
 *   SUPABASE_URL              https://xxxx.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY  sb_publishable_…（または旧 anon キー）。SCOUT に渡す（公開してよい鍵）
 *   SUPABASE_SECRET_KEY       sb_secret_…（または旧 service_role キー）。GAS の中だけで使う（絶対に外へ出さない）
 *
 * Supabase 側の表と関数: supabase/scout.sql（SQL Editor で1回実行）。手順: docs/SCOUT_SUPABASE.md
 * 失敗しても業務は止めない: ここの関数はすべて例外を外に出さない（ログだけ）。
 */

const SCOUT_SB_TOKEN_DAYS_ = 7;          // 通行証の期限（スタッフを外した時に残る期間を短く）。残り2日を切ると SCOUT が取り直す
const SCOUT_SB_TOKEN_MAX_PER_6H_ = 6;    // 1人あたり6時間で出す通行証の上限（叩かれても Supabase と UrlFetch を食い尽くさない）
const SCOUT_SB_TIMEOUT_LOG_ = '⚠️ ScoutSupabase: ';

/** 設定（3つ揃っていなければ null = 仕組みを止める） */
function scoutSbConfig_() {
  try {
    const p = PropertiesService.getScriptProperties();
    const url = String(p.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
    const pub = String(p.getProperty('SUPABASE_PUBLISHABLE_KEY') || '').trim();
    const sec = String(p.getProperty('SUPABASE_SECRET_KEY') || '').trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !pub || !sec) return null;
    return { url: url, pub: pub, sec: sec };
  } catch (e) {
    Logger.log(SCOUT_SB_TIMEOUT_LOG_ + 'config ' + e);
    return null;
  }
}

/** 鍵のヘッダー。新しい鍵（sb_…）は apikey だけ、旧 JWT の鍵は Authorization にも入れる */
function scoutSbHeaders_(key) {
  const h = { apikey: key };
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  return h;
}

/** Supabase REST を秘密鍵で呼ぶ。成功なら true（例外は出さない） */
function scoutSbRequest_(cfg, method, path, body, extraHeaders) {
  try {
    const headers = Object.assign(scoutSbHeaders_(cfg.sec), extraHeaders || {});
    const opt = { method: method, headers: headers, muteHttpExceptions: true, contentType: 'application/json' };
    if (body !== undefined) opt.payload = JSON.stringify(body);
    const res = UrlFetchApp.fetch(cfg.url + path, opt);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return true;
    Logger.log(SCOUT_SB_TIMEOUT_LOG_ + method + ' ' + path + ' → ' + code + ' ' + String(res.getContentText()).substring(0, 300));
    return false;
  } catch (e) {
    Logger.log(SCOUT_SB_TIMEOUT_LOG_ + method + ' ' + path + ' ' + e);
    return false;
  }
}

/** 写しの表（scout_cache）に1件または複数件を上書き保存 */
function scoutSbPut_(cfg, items) {
  const now = new Date().toISOString();
  const rows = items.map(function(it) { return { key: it.key, data: it.data, updated_at: now }; });
  return scoutSbRequest_(cfg, 'post', '/rest/v1/scout_cache?on_conflict=key', rows,
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

/** お店の一覧を写す（10分ごと・書いた直後）。成功なら true */
function scoutSbPushShops_(cfg) {
  cfg = cfg || scoutSbConfig_();
  if (!cfg) return false;
  try {
    return scoutSbPut_(cfg, [{ key: 'shops', data: salesLogShopsData_() }]);
  } catch (e) {
    Logger.log(SCOUT_SB_TIMEOUT_LOG_ + 'pushShops ' + e);
    return false;
  }
}

/** 1店の詳細（salesLogShopDetail の結果）を写す */
function scoutSbPushDetail_(cfg, shopId, detail) {
  cfg = cfg || scoutSbConfig_();
  if (!cfg || !shopId || !detail || !detail.ok) return false;
  // 訪問の位置（緯度経度）は写さない。画面は「GPS あり」の印にしか使っていないので、あり/なしだけ残す
  const visits = (detail.visits || []).map(function(v) {
    const o = Object.assign({}, v);
    const has = v.lat !== null && v.lat !== undefined && v.lat !== '';
    o.lat = has ? 0 : null; o.lng = has ? 0 : null;
    return o;
  });
  const data = { shop: detail.shop, visits: visits, hearings: detail.hearings, notes: detail.notes, qr: detail.qr };
  return scoutSbPut_(cfg, [{ key: 'detail:' + String(shopId), data: data }]);
}

/** GAS で一覧を作った時（saleslog_shops）: 結果をそのまま写しへ。応答は変えない */
function scoutSbAfterList_(res) {
  try {
    const cfg = scoutSbConfig_();
    if (cfg && res && res.ok && Array.isArray(res.shops) && res.shops.length) scoutSbPut_(cfg, [{ key: 'shops', data: res.shops }]);
  } catch (e) { Logger.log(SCOUT_SB_TIMEOUT_LOG_ + 'afterList ' + e); }
  return res;
}

/**
 * 店の詳細を GAS で作った時（saleslog_shop_detail）: 結果をそのまま写しへ。応答は変えない
 */
function scoutSbAfterDetail_(shopId, detail) {
  try {
    const cfg = scoutSbConfig_();
    if (cfg) scoutSbPushDetail_(cfg, shopId, detail);
  } catch (e) { Logger.log(SCOUT_SB_TIMEOUT_LOG_ + 'afterDetail ' + e); }
  return detail;
}

/**
 * 書き込みのあと（訪問・メモ・店の情報・QR）: その店の詳細の写しを消す（1回の通信だけ・重い作り直しはしない）。
 * 次にその店を開くと GAS から読み、その結果がまた写される。一覧は SCOUT が書いたあと GAS から読み直す時に写る
 * @param {Object} res - 書き込みの応答（ok でなければ何もしない）。応答はそのまま返す
 * @param {string} shopId - 分かっている時だけ（無ければ res.shopId）
 */
function scoutSbAfterWrite_(res, shopId) {
  try {
    if (!res || !res.ok) return res;
    const id = String(shopId || res.shopId || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res;
    const cfg = scoutSbConfig_();
    if (cfg) scoutSbRequest_(cfg, 'delete', '/rest/v1/scout_cache?key=eq.' + encodeURIComponent('detail:' + id));
  } catch (e) { Logger.log(SCOUT_SB_TIMEOUT_LOG_ + 'afterWrite ' + e); }
  return res;
}

/**
 * SCOUT に通行証を渡す（action: scout_token）
 * @return {Object} { ok, url, key, token, exp } / { ok:false, error }
 */
function scoutSbIssueToken(chatId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  const cfg = scoutSbConfig_();
  if (!cfg) return { ok: false, error: 'SCOUT_SB_OFF' };
  if (!scoutSbTokenQuotaOk_(chatId)) return { ok: false, error: 'SCOUT_SB_RATE' };
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const exp = new Date(Date.now() + SCOUT_SB_TOKEN_DAYS_ * 24 * 3600 * 1000);
  const ok = scoutSbRequest_(cfg, 'post', '/rest/v1/scout_tokens',
    [{ token_hash: scoutSbSha256Hex_(token), chat_id: String(chatId), expires_at: exp.toISOString() }],
    { Prefer: 'return=minimal' });
  if (!ok) return { ok: false, error: 'SCOUT_SB_UNAVAILABLE' };
  return { ok: true, url: cfg.url, key: cfg.pub, token: token, exp: exp.getTime() };
}

/** 1人あたり6時間で SCOUT_SB_TOKEN_MAX_PER_6H_ 回まで（CacheService が使えない時は通す＝業務を止めない） */
function scoutSbTokenQuotaOk_(chatId) {
  try {
    const cache = CacheService.getScriptCache();
    const k = 'scout_tok_n_' + String(chatId);
    const n = Number(cache.get(k) || 0);
    if (n >= SCOUT_SB_TOKEN_MAX_PER_6H_) return false;
    cache.put(k, String(n + 1), 6 * 3600);
    return true;
  } catch (e) {
    Logger.log(SCOUT_SB_TIMEOUT_LOG_ + 'quota ' + e);
    return true;
  }
}

/**
 * スタッフマスターにいない（外した）人の通行証を消す。1日1回（scoutSbSync から）
 */
function scoutSbRevokeRemovedStaff_(cfg) {
  try {
    const res = UrlFetchApp.fetch(cfg.url + '/rest/v1/scout_tokens?select=chat_id', {
      method: 'get', headers: scoutSbHeaders_(cfg.sec), muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return false;
    const ids = {};
    JSON.parse(res.getContentText()).forEach(function(r) { ids[String(r.chat_id)] = true; });
    Object.keys(ids).forEach(function(id) {
      if (!findStaffByChatId(id)) scoutSbRevoke(id);
    });
    return true;
  } catch (e) {
    Logger.log(SCOUT_SB_TIMEOUT_LOG_ + 'revokeRemoved ' + e);
    return false;
  }
}

/** エディタでも実行可: その人の通行証をすべて消す（スタッフを外した時・スマホをなくした時） */
function scoutSbRevoke(chatId) {
  const cfg = scoutSbConfig_();
  if (!cfg || !chatId) return false;
  return scoutSbRequest_(cfg, 'delete', '/rest/v1/scout_tokens?chat_id=eq.' + encodeURIComponent(String(chatId)));
}

function scoutSbSha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/**
 * 10分ごとのトリガー: お店の一覧を写す。6時間に1回、期限の切れた通行証と、外したスタッフの通行証を消す
 * （トリガーは scoutSbInstallTrigger をエディタで1回実行して作る）
 */
function scoutSbSync() {
  const cfg = scoutSbConfig_();
  if (!cfg) return;
  scoutSbPushShops_(cfg);
  runAtMostEvery_('scout_sb_token_cleanup', 6 * 3600, function() {
    const a = scoutSbRequest_(cfg, 'delete', '/rest/v1/scout_tokens?expires_at=lt.' + encodeURIComponent(new Date().toISOString()));
    const b = scoutSbRevokeRemovedStaff_(cfg);
    return a && b;
  });
}

/** エディタで1回だけ実行: 10分ごとのトリガーを作る（何度実行しても1つだけ） */
function scoutSbInstallTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'scoutSbSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scoutSbSync').timeBased().everyMinutes(10).create();
  scoutSbSync();
  Logger.log('✅ scoutSbSync を10分ごとに設定し、1回実行しました（設定: ' + (scoutSbConfig_() ? 'あり' : 'なし') + '）');
}

/** エディタで実行: 設定と接続の確認（鍵の中身はログに出さない） */
function scoutSbStatus() {
  const cfg = scoutSbConfig_();
  if (!cfg) { Logger.log('❌ 設定が足りません（SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY）'); return; }
  const ok = scoutSbPushShops_(cfg);
  const n = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'scoutSbSync'; }).length;
  Logger.log((ok ? '✅' : '❌') + ' お店の一覧を写す: ' + (ok ? '成功' : '失敗（上のログを確認）') + ' / 10分ごとのトリガー: ' + n + '個');
}
