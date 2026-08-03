/**
 * SalesLogManager.gs — 車屋提携 営業ログ v2（店マスター＋訪問履歴）
 *
 * 【責務】
 *   - 車屋（中古車販売店・整備工場・修理工場）の店マスターと訪問履歴を
 *     v7 Database（顧客系スプレッドシート）の「店マスター」「営業ログ」タブで管理
 *   - v1（1訪問=1行のフラットログ）からの自動移行（店名でグルーピング→shop_id 付与）
 *   - ミニアプリ向け API: 店一覧（マップ用GPS付き）/ 店詳細（訪問タイムライン）/
 *     訪問記録・追記 / 訪問編集 / 店情報編集
 *
 * 【設計方針（要件 v1 + v2 プラン 2026-07-25 Daisuke 裁可）】
 *   - 実験段階につき最小構成。通知・集計画面・複数ユーザー対応はしない
 *   - タブは V7_SPREADSHEET_ID 側。v7 GAS の関数は呼ばず openById で直接読み書き
 *   - タブ・列は無ければ自動作成/自動追加（Setup 実行不要のゼロタッチ運用）
 *   - 列参照はヘッダー名ベース（列順変更に追随。v1 の列位置固定を廃止）
 *   - GPS はミニアプリ側で Telegram LocationManager API により取得
 *   - 店の集計列（最新反応・訪問回数・初回/最終訪問日）は営業ログから導出した
 *     非正規化キャッシュ（GSS を直接見る日本側管理者の可読性のため）。正は営業ログ
 *
 * 【シート列】
 *   営業ログ（1訪問=1行）:
 *     visit_id / 日時 / 緯度 / 経度 / 緯度経度結合("lat,lng") / 店名 / オーナー名 /
 *     電話 / 反応(A-D) / メモ / 最終更新日時 / shop_id
 *   店マスター（1店=1行）:
 *     shop_id / 店名 / 緯度 / 経度 / 緯度経度結合 / オーナー名 / 電話 / 最新反応 /
 *     ステータス(営業中/提携済/見送り) / パートナーID / 訪問回数 / 初回訪問日 /
 *     最終訪問日 / メモ
 *   ※ 緯度経度結合は Looker Studio マップ用。パートナーID は Phase 4（キャッシュ
 *     バック管理・パートナープログラム連携）用の予約列（今は空）
 */

// ====== 定数 ======

const SALESLOG_SHEET_NAME = '営業ログ';
const SALESLOG_HEADERS = [
  'visit_id', '日時', '緯度', '経度', '緯度経度結合',
  '店名', 'オーナー名', '電話', '反応', '反応内容', 'メモ', '最終更新日時', 'shop_id'
];

const SALESLOG_SHOP_SHEET_NAME = '店マスター';
const SALESLOG_SHOP_HEADERS = [
  'shop_id', '店名', '業種', '緯度', '経度', '緯度経度結合', 'オーナー名', '電話', 'Facebook',
  '最新反応', '最新反応内容', 'デモ予定日', 'デモ実施日', 'ステータス', 'パートナーID', '訪問回数', '初回訪問日', '最終訪問日', 'メモ'
];

// 車屋の業種（複数選択・カンマ区切りで保存。今後の提案先セグメントの基礎データ）
// ※ 暫定セット（2026-07-25 Daisuke 指示）。ロン君ヒアリング後に見直す — 変更はこの1箇所
const SALESLOG_SHOP_TYPES = ['中古車販売', '整備・修理', '洗車', 'パーツ', 'タイヤ', '板金・塗装', 'その他'];

/**
 * 業種配列をカンマ区切り文字列に正規化。
 * 定義外の値は**捨てずに保持**する（ラベルセット見直し後の旧データが、店情報の
 * 保存操作で無警告消失するのを防ぐ。ラベル改名時はリネームマイグレーションで対応）
 */
function normalizeShopTypes_(types) {
  if (!types || !types.length) return '';
  const seen = {};
  const out = [];
  (Array.isArray(types) ? types : [types]).forEach(function(t) {
    const v = String(t || '').trim();
    if (!v || seen[v]) return;
    seen[v] = true;
    if (SALESLOG_SHOP_TYPES.indexOf(v) < 0) Logger.log('⚠️ 業種: 定義外の値を保持: ' + v);
    out.push(v);
  });
  return out.join(', ');
}

const SALESLOG_REACTIONS = ['A', 'B', 'C', 'D'];
// GSS を直接見る管理者向けの日本語ラベル（「A だけだと分からない」2026-07-25 Daisuke 指摘）
const SALESLOG_REACTION_LABELS = { A: 'デモ決定', B: '興味あり', C: '保留', D: '断り' };
const SALESLOG_SHOP_STATUSES = ['営業中', '提携済', '見送り'];

function reactionLabel_(r) {
  return SALESLOG_REACTION_LABELS[String(r || '').trim().toUpperCase()] || '';
}

// ====== 公開 API（Router からディスパッチ） ======

/**
 * 店一覧（マップ・一覧ビュー用）。v1 データの自動移行もここで実行
 * @return {Object} { ok, shops: [{ shopId, shopName, lat, lng, ownerName, phone,
 *                    lastReaction, status, partnerId, visitCount, firstVisit, lastVisit, memo }] }
 */
function salesLogShops(chatId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  ensureSalesLogV2Migration_();

  const shops = readSheetObjects_(getShopSheet_())
    .map(function(r) { return shopRowToApi_(r.obj); })
    .filter(function(s) { return s.shopId; });

  // 最終訪問日の新しい順（空は最後）
  shops.sort(function(a, b) {
    return String(b.lastVisit || '').localeCompare(String(a.lastVisit || ''));
  });

  return { ok: true, shops: shops };
}

/**
 * 店詳細（訪問タイムライン付き）
 */
function salesLogShopDetail(chatId, shopId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const shopSheet = getShopSheet_();
  const found = findSheetRow_(shopSheet, 'shop_id', shopId);
  if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };

  const visits = readSheetObjects_(getSalesLogSheet_())
    .map(function(r) { return visitRowToApi_(r.obj); })
    .filter(function(v) { return v.visitId && v.shopId === String(shopId); });
  visits.sort(function(a, b) { return String(b.datetime).localeCompare(String(a.datetime)); });

  return { ok: true, shop: shopRowToApi_(found.obj), visits: visits };
}

/**
 * 訪問記録（新規店 or 既存店への追記）
 * @param {Object} p - { shopId?, shopName, ownerName, phone, reaction, memo, gps }
 * @return {Object} { ok, visitId, shopId }
 */
function salesLogCreate(chatId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const gps = normalizeSalesLogGps_(p.gps);
  const nowStr = salesLogNow_();
  let shopId = String(p.shopId || '').trim();
  let visitShopName;

  if (shopId) {
    // 既存店への訪問追記
    const found = findSheetRow_(getShopSheet_(), 'shop_id', shopId);
    if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };
    visitShopName = String(found.obj['店名'] || '');
  } else {
    // 新規店＋初回訪問
    const shopName = String(p.shopName || '').trim();
    if (!shopName) return { ok: false, error: 'MISSING_SHOP_NAME' };
    visitShopName = shopName;
    shopId = createShopRow_({
      '店名':       shopName,
      '業種':       normalizeShopTypes_(p.shopTypes),
      '緯度':       gps ? gps.lat : '',
      '経度':       gps ? gps.lng : '',
      '緯度経度結合': gps ? (gps.lat + ',' + gps.lng) : '',
      'オーナー名':  String(p.ownerName || '').trim(),
      '電話':       String(p.phone || '').trim(),
      'Facebook':   String(p.facebook || '').trim(),
      'ステータス':  SALESLOG_SHOP_STATUSES[0],
      'メモ':       ''
    });
  }

  // 同一秒の同時投稿でも衝突しないよう UUID 断片を付与
  const visitId = generateDateTimeId('SL') + '-' + Utilities.getUuid().slice(0, 8);
  appendSheetRow_(getSalesLogSheet_(), {
    'visit_id':     visitId,
    '日時':         nowStr,
    '緯度':         gps ? gps.lat : '',
    '経度':         gps ? gps.lng : '',
    '緯度経度結合':  gps ? (gps.lat + ',' + gps.lng) : '',
    '店名':         visitShopName,
    'オーナー名':    String(p.ownerName || '').trim(),
    '電話':         String(p.phone || '').trim(),
    '反応':         normalizeSalesLogReaction_(p.reaction),
    '反応内容':     reactionLabel_(p.reaction),
    'メモ':         String(p.memo || ''),
    '最終更新日時':  nowStr,
    'shop_id':      shopId
  });

  refreshShopAggregates_(shopId);
  return { ok: true, visitId: visitId, shopId: shopId };
}

/**
 * 訪問の修正・追記（反応・メモが主。GPS・日時は変更しない）
 */
function salesLogUpdate(chatId, visitId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const sheet = getSalesLogSheet_();
  const found = findSheetRow_(sheet, 'visit_id', visitId);
  if (!found) return { ok: false, error: 'VISIT_NOT_FOUND' };

  const updates = {
    '反応':        normalizeSalesLogReaction_(p.reaction),
    '反応内容':    reactionLabel_(p.reaction),
    'メモ':        String(p.memo || ''),
    '最終更新日時': salesLogNow_()
  };
  // v1 互換: 店名/オーナー名/電話は「非空で送られた時のみ」上書き
  // （クリアは店マスター編集 saleslog_shop_update 側で行う）
  if (String(p.shopName || '').trim())  updates['店名']      = String(p.shopName).trim();
  if (String(p.ownerName || '').trim()) updates['オーナー名'] = String(p.ownerName).trim();
  if (String(p.phone || '').trim())     updates['電話']      = String(p.phone).trim();

  updateSheetRow_(sheet, found.row, updates);

  const shopId = String(found.obj['shop_id'] || '');
  if (shopId) refreshShopAggregates_(shopId);

  return { ok: true, visitId: String(visitId) };
}

/**
 * 店情報の編集（店名・オーナー名・電話・ステータス・メモ）
 */
function salesLogShopUpdate(chatId, shopId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const shopName = String(p.shopName || '').trim();
  if (!shopName) return { ok: false, error: 'MISSING_SHOP_NAME' };

  const sheet = getShopSheet_();
  const found = findSheetRow_(sheet, 'shop_id', shopId);
  if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };

  // ※ 営業ログ側の「店名」列は訪問時点のスナップショットとして意図的に据え置く
  //   （現在の正式店名は店マスターが正。過去の訪問記録は当時の呼び名のまま残す）
  const status = String(p.status || '').trim();
  const updates = {
    '店名':       shopName,
    '業種':       normalizeShopTypes_(p.shopTypes),
    'オーナー名':  String(p.ownerName || '').trim(),
    '電話':       String(p.phone || '').trim(),
    'Facebook':   String(p.facebook || '').trim(),
    'メモ':       String(p.memo || '')
  };
  if (SALESLOG_SHOP_STATUSES.indexOf(status) >= 0) updates['ステータス'] = status;

  // デモ予定日・実施日（YYYY-MM-DD のみ受付。'' は消去、undefined/不正値は変更しない）
  const demoPlanned = normalizeSalesLogDateStr_(p.demoPlanned);
  if (demoPlanned !== null) updates['デモ予定日'] = demoPlanned;
  const demoDone = normalizeSalesLogDateStr_(p.demoDone);
  if (demoDone !== null) updates['デモ実施日'] = demoDone;

  // GPS（「今の場所をこの店の位置にする」ボタン用。gps が送られた時のみ上書き）
  const gps = normalizeSalesLogGps_(p.gps);
  if (gps) {
    updates['緯度'] = gps.lat;
    updates['経度'] = gps.lng;
    updates['緯度経度結合'] = gps.lat + ',' + gps.lng;
  }

  updateSheetRow_(sheet, found.row, updates);
  return { ok: true, shopId: String(shopId) };
}

/**
 * 日付文字列の正規化: 'YYYY-MM-DD'→そのまま / ''→''（消去） / それ以外→null（変更しない）
 */
function normalizeSalesLogDateStr_(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ====== v1 → v2 自動移行 ======

/**
 * shop_id 未付与の営業ログ行を店名でグルーピングし、店マスターを生成して backfill する。
 * 冪等（orphan が無ければ何もしない）。salesLogShops（アプリ起動時に必ず呼ばれる）から実行。
 * 2名同時アクセスの初回移行で店が二重生成されないよう LockService で保護
 * （PartnerManager.gs の採番保護と同パターン）
 */
function ensureSalesLogV2Migration_() {
  // 通常パス（移行・ラベル補完とも不要）はロックなしで即 return
  const rows = readSheetObjects_(getSalesLogSheet_());
  const hasOrphan = rows.some(function(r) {
    return String(r.obj['visit_id'] || '') && !String(r.obj['shop_id'] || '');
  });
  const hasMissingLabel = rows.some(function(r) {
    return String(r.obj['visit_id'] || '') && String(r.obj['反応'] || '') && !String(r.obj['反応内容'] || '');
  });
  const shopsMissingLabel = readSheetObjects_(getShopSheet_())
    .filter(function(r) {
      return String(r.obj['shop_id'] || '') && String(r.obj['最新反応'] || '') && !String(r.obj['最新反応内容'] || '');
    })
    .map(function(r) { return String(r.obj['shop_id']); });
  if (!hasOrphan && !hasMissingLabel && !shopsMissingLabel.length) return;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (e) {
    Logger.log('⚠️ 営業ログ移行 lock 取得失敗（先行実行が処理中の可能性）: ' + e);
    return;
  }
  try {
    runSalesLogV2Migration_(shopsMissingLabel);
  } finally {
    lock.releaseLock();
  }
}

function runSalesLogV2Migration_(extraShopIdsToRefresh) {
  // ロック取得後に再読（先行実行が移行済みなら orphan は消えている）
  const visitSheet = getSalesLogSheet_();
  const rows = readSheetObjects_(visitSheet);
  const orphans = rows.filter(function(r) {
    return String(r.obj['visit_id'] || '') && !String(r.obj['shop_id'] || '');
  });

  // 反応内容ラベルの後追い補完（列一括書き込み）
  backfillReactionLabels_(visitSheet, rows);

  if (orphans.length === 0) {
    refreshShopAggregatesBulk_(extraShopIdsToRefresh || []);
    return;
  }

  const shopSheet = getShopSheet_();
  const shopsByName = {};
  readSheetObjects_(shopSheet).forEach(function(r) {
    const name = String(r.obj['店名'] || '').trim();
    if (name) shopsByName[name] = String(r.obj['shop_id'] || '');
  });

  // 店名でグルーピング
  const groups = {};
  orphans.forEach(function(r) {
    const name = String(r.obj['店名'] || '').trim() || '(店名なし)';
    if (!groups[name]) groups[name] = [];
    groups[name].push(r);
  });

  const assignments = []; // { row, shopId }
  const touchedShopIds = [];

  Object.keys(groups).forEach(function(name) {
    const group = groups[name];
    let shopId = shopsByName[name];
    if (!shopId) {
      // グループ先頭の GPS / 最後の非空オーナー・電話で店を生成
      let lat = '', lng = '', owner = '', phone = '';
      group.forEach(function(r) {
        if (lat === '' && r.obj['緯度'] !== '' && r.obj['緯度'] !== null) {
          lat = r.obj['緯度']; lng = r.obj['経度'];
        }
        if (String(r.obj['オーナー名'] || '').trim()) owner = String(r.obj['オーナー名']).trim();
        if (String(r.obj['電話'] || '').trim())      phone = String(r.obj['電話']).trim();
      });
      shopId = createShopRow_({
        '店名': name,
        '緯度': lat, '経度': lng,
        '緯度経度結合': (lat !== '' && lng !== '') ? (lat + ',' + lng) : '',
        'オーナー名': owner, '電話': phone,
        'ステータス': SALESLOG_SHOP_STATUSES[0],
        'メモ': ''
      });
      shopsByName[name] = shopId;
    }
    group.forEach(function(r) { assignments.push({ row: r.row, shopId: shopId }); });
    touchedShopIds.push(shopId);
  });

  // shop_id backfill は列一括書き込み（1行ずつ setValue すると初回アクセスが
  // タイムアウトしうるため。読んだ範囲と同一範囲に書き戻す）
  const headers = getSheetHeaders_(visitSheet);
  const shopIdCol = headers.indexOf('shop_id') + 1;
  const numRows = rows.length;
  if (numRows > 0) {
    const colVals = visitSheet.getRange(2, shopIdCol, numRows, 1).getValues();
    assignments.forEach(function(a) {
      if (a.row - 2 >= 0 && a.row - 2 < numRows) colVals[a.row - 2][0] = a.shopId;
    });
    visitSheet.getRange(2, shopIdCol, numRows, 1).setValues(colVals);
  }

  refreshShopAggregatesBulk_(touchedShopIds.concat(extraShopIdsToRefresh || []));
  Logger.log('🔄 営業ログ v2 移行: ' + orphans.length + '訪問 → ' + touchedShopIds.length + '店');
}

/**
 * 「反応」があるのに「反応内容」が空の行へラベルを一括補完
 * （反応内容 列は 2026-07-25 Daisuke 指摘で後付けしたため、既存行の補完が必要）
 */
function backfillReactionLabels_(visitSheet, rows) {
  const targets = rows.filter(function(r) {
    return String(r.obj['visit_id'] || '') && String(r.obj['反応'] || '') && !String(r.obj['反応内容'] || '');
  });
  if (!targets.length) return;
  const headers = getSheetHeaders_(visitSheet);
  const labelCol = headers.indexOf('反応内容') + 1;
  if (labelCol <= 0 || !rows.length) return;
  const colVals = visitSheet.getRange(2, labelCol, rows.length, 1).getValues();
  targets.forEach(function(r) {
    if (r.row - 2 >= 0 && r.row - 2 < rows.length) {
      colVals[r.row - 2][0] = reactionLabel_(r.obj['反応']);
    }
  });
  visitSheet.getRange(2, labelCol, rows.length, 1).setValues(colVals);
  Logger.log('🏷️ 反応内容ラベル補完: ' + targets.length + '行');
}

// ====== 店マスター 内部実装 ======

/**
 * 店行を作成して shop_id を返す
 * 同時実行でも衝突しないよう UUID 断片を付与（実行内カウンタでは別インスタンスと衝突しうる）
 */
function createShopRow_(fields) {
  const shopId = generateDateTimeId('SHOP') + '-' + Utilities.getUuid().slice(0, 8);
  const dict = {};
  Object.keys(fields).forEach(function(k) { dict[k] = fields[k]; });
  dict['shop_id'] = shopId;
  dict['最新反応'] = dict['最新反応'] || '';
  dict['パートナーID'] = '';
  dict['訪問回数'] = 0;
  dict['初回訪問日'] = '';
  dict['最終訪問日'] = '';
  appendSheetRow_(getShopSheet_(), dict);
  return shopId;
}

/**
 * 店の集計列（最新反応・訪問回数・初回/最終訪問日）を営業ログから再計算
 */
function refreshShopAggregates_(shopId) {
  refreshShopAggregatesBulk_([String(shopId)]);
}

/**
 * 複数店の集計を一括再計算（シート読み取りは店・訪問それぞれ1回だけ。
 * 移行時に店数ぶん全件読みを繰り返してタイムアウトするのを防ぐ）
 */
function refreshShopAggregatesBulk_(shopIds) {
  if (!shopIds || !shopIds.length) return;
  const shopSheet = getShopSheet_();
  const rowByShopId = {};
  readSheetObjects_(shopSheet).forEach(function(r) {
    rowByShopId[String(r.obj['shop_id'])] = r.row;
  });

  const byShop = {};
  readSheetObjects_(getSalesLogSheet_()).forEach(function(r) {
    const v = visitRowToApi_(r.obj);
    if (!v.visitId || !v.shopId) return;
    if (!byShop[v.shopId]) byShop[v.shopId] = [];
    byShop[v.shopId].push(v);
  });

  shopIds.forEach(function(id) {
    const rowNum = rowByShopId[String(id)];
    if (!rowNum) return;
    updateSheetRow_(shopSheet, rowNum, computeShopAggregates_(byShop[String(id)] || []));
  });
}

function computeShopAggregates_(visits) {
  visits.sort(function(a, b) { return String(a.datetime).localeCompare(String(b.datetime)); });
  let lastReaction = '';
  for (let i = visits.length - 1; i >= 0; i--) {
    if (visits[i].reaction) { lastReaction = visits[i].reaction; break; }
  }
  return {
    '最新反応':     lastReaction,
    '最新反応内容': reactionLabel_(lastReaction),
    '訪問回数':     visits.length,
    '初回訪問日':   visits.length ? String(visits[0].datetime).substring(0, 10) : '',
    '最終訪問日':   visits.length ? String(visits[visits.length - 1].datetime).substring(0, 10) : ''
  };
}

// ====== シート取得（自動作成・列自動追加） ======

let _salesLogSsCache_ = null;
function getSalesLogSs_() {
  if (_salesLogSsCache_) return _salesLogSsCache_;
  const cfg = getConfig();
  if (!cfg.v7SpreadsheetId) {
    throw new Error('❌ V7_SPREADSHEET_ID 未設定（営業ログ/店マスターは v7 Database 側のタブです）');
  }
  _salesLogSsCache_ = SpreadsheetApp.openById(cfg.v7SpreadsheetId);
  return _salesLogSsCache_;
}

/**
 * 「営業ログ」タブ（無ければヘッダー付きで自動作成。v1 由来なら shop_id 列を自動追加）
 * ★ 実行内キャッシュ: スキーマ整備（列の自動追加）は1実行に1回で十分。
 *   毎回やると1リクエストで十数回の往復になり体感数十秒まで悪化する（2026-08-03 実測）
 */
let _salesLogSheetCache_ = null;
function getSalesLogSheet_() {
  if (_salesLogSheetCache_) return _salesLogSheetCache_;
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(SALESLOG_SHEET_NAME);
  if (!sheet) {
    sheet = createHeaderedSheet_(ss, SALESLOG_SHEET_NAME, SALESLOG_HEADERS);
    setColumnTextFormat_(sheet, SALESLOG_HEADERS, '電話');
  } else {
    // 旧版シートへの列追加（コードはヘッダー名参照なので挿入位置による破綻はない）
    const headers = getSheetHeaders_(sheet);
    if (headers.indexOf('shop_id') < 0) {
      sheet.getRange(1, headers.length + 1).setValue('shop_id').setFontWeight('bold');
    }
    ensureColumnAfter_(sheet, '反応', '反応内容');
  }
  _salesLogSheetCache_ = sheet;
  return sheet;
}

/**
 * 「店マスター」タブ（無ければヘッダー付きで自動作成）
 * ★ 実行内キャッシュ: 理由は getSalesLogSheet_ と同じ
 */
let _shopSheetCache_ = null;
function getShopSheet_() {
  if (_shopSheetCache_) return _shopSheetCache_;
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(SALESLOG_SHOP_SHEET_NAME);
  if (!sheet) {
    sheet = createHeaderedSheet_(ss, SALESLOG_SHOP_SHEET_NAME, SALESLOG_SHOP_HEADERS);
    setColumnTextFormat_(sheet, SALESLOG_SHOP_HEADERS, '電話');
    Logger.log('🆕 v7 Database に「' + SALESLOG_SHOP_SHEET_NAME + '」タブを新規作成');
  } else {
    ensureColumnAfter_(sheet, '最新反応', '最新反応内容');
    ensureColumnAfter_(sheet, '店名', '業種');
    ensureColumnAfter_(sheet, '電話', 'Facebook');
    // デモ予定日・実施日（2026-08-03 追加。順に挿入して「最新反応内容」の直後に並べる）
    ensureColumnAfter_(sheet, '最新反応内容', 'デモ予定日');
    ensureColumnAfter_(sheet, 'デモ予定日', 'デモ実施日');
  }
  _shopSheetCache_ = sheet;
  return sheet;
}

/**
 * 指定ヘッダー列の直後に新列を挿入（既にあれば何もしない）
 * ※ GSS を直接見る管理者の可読性のため、末尾でなく関連列の隣に置く
 * ※ 列挿入はスキーマ変更なので LockService で排他（2名同時アクセスの初回に
 *   二重挿入されるレース対策・ダブルチェックロッキング）
 */
function ensureColumnAfter_(sheet, afterHeader, newHeader) {
  if (getSheetHeaders_(sheet).indexOf(newHeader) >= 0) return; // 通常パスはロックなし

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (e) {
    Logger.log('⚠️ ensureColumnAfter_ lock取得失敗（先行実行が処理中の可能性）: ' + e);
    return;
  }
  try {
    // ロック内で再確認（先行実行が挿入済みなら何もしない）
    const headers = getSheetHeaders_(sheet);
    if (headers.indexOf(newHeader) >= 0) return;
    const afterIdx = headers.indexOf(afterHeader);
    if (afterIdx < 0) {
      sheet.getRange(1, headers.length + 1).setValue(newHeader).setFontWeight('bold');
      return;
    }
    sheet.insertColumnAfter(afterIdx + 1);
    sheet.getRange(1, afterIdx + 2).setValue(newHeader).setFontWeight('bold');
  } finally {
    lock.releaseLock();
  }
}

function createHeaderedSheet_(ss, name, headers) {
  const sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * 指定ヘッダー列全体をテキスト書式に（電話番号の先頭ゼロ保持）
 * ※ タブ自動作成時のみ適用。手動作成タブには入らない（ゼロタッチ自動作成が前提）
 */
function setColumnTextFormat_(sheet, headers, headerName) {
  const idx = headers.indexOf(headerName);
  if (idx < 0) return;
  const colLetter = String.fromCharCode(65 + idx); // A=0（Z超えは本シートでは発生しない）
  sheet.getRange(colLetter + '2:' + colLetter).setNumberFormat('@');
}

// ====== 汎用シートヘルパー（ヘッダー名ベース・v7 Database 用） ======

function getSheetHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

/**
 * 全データ行を { row, obj } の配列で返す
 */
function readSheetObjects_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = getSheetHeaders_(sheet);
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function(row, i) {
    const obj = {};
    headers.forEach(function(h, j) { obj[h] = row[j]; });
    return { row: i + 2, obj: obj };
  });
}

function findSheetRow_(sheet, columnName, value) {
  const rows = readSheetObjects_(sheet);
  const target = String(value);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].obj[columnName]) === target) return rows[i];
  }
  return null;
}

function appendSheetRow_(sheet, dict) {
  const headers = getSheetHeaders_(sheet);
  const row = headers.map(function(h) {
    return dict.hasOwnProperty(h) ? dict[h] : '';
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function updateSheetRow_(sheet, rowNumber, updates) {
  const headers = getSheetHeaders_(sheet);
  Object.keys(updates).forEach(function(col) {
    const idx = headers.indexOf(col);
    if (idx < 0) {
      Logger.log('⚠️ updateSheetRow_: 列 ' + col + ' 未発見、スキップ');
      return;
    }
    sheet.getRange(rowNumber, idx + 1).setValue(updates[col]);
  });
}

// ====== 行→API オブジェクト変換 ======

function visitRowToApi_(obj) {
  return {
    visitId:   String(obj['visit_id'] || ''),
    shopId:    String(obj['shop_id'] || ''),
    datetime:  formatSalesLogDateCell_(obj['日時']),
    lat:       obj['緯度'] === '' || obj['緯度'] === null ? null : Number(obj['緯度']),
    lng:       obj['経度'] === '' || obj['経度'] === null ? null : Number(obj['経度']),
    shopName:  String(obj['店名'] || ''),
    ownerName: String(obj['オーナー名'] || ''),
    phone:     String(obj['電話'] || ''),
    reaction:  String(obj['反応'] || ''),
    memo:      String(obj['メモ'] || ''),
    updatedAt: formatSalesLogDateCell_(obj['最終更新日時'])
  };
}

function shopRowToApi_(obj) {
  return {
    shopId:       String(obj['shop_id'] || ''),
    shopName:     String(obj['店名'] || ''),
    shopTypes:    String(obj['業種'] || '').split(',')
                    .map(function(s) { return s.trim(); })
                    .filter(function(s) { return s; }),
    lat:          obj['緯度'] === '' || obj['緯度'] === null ? null : Number(obj['緯度']),
    lng:          obj['経度'] === '' || obj['経度'] === null ? null : Number(obj['経度']),
    ownerName:    String(obj['オーナー名'] || ''),
    phone:        String(obj['電話'] || ''),
    facebook:     String(obj['Facebook'] || ''),
    lastReaction: String(obj['最新反応'] || ''),
    demoPlanned:  formatSalesLogDateCell_(obj['デモ予定日']).substring(0, 10),
    demoDone:     formatSalesLogDateCell_(obj['デモ実施日']).substring(0, 10),
    status:       String(obj['ステータス'] || ''),
    partnerId:    String(obj['パートナーID'] || ''),
    visitCount:   Number(obj['訪問回数']) || 0,
    firstVisit:   formatSalesLogDateCell_(obj['初回訪問日']).substring(0, 10),
    lastVisit:    formatSalesLogDateCell_(obj['最終訪問日']).substring(0, 10),
    memo:         String(obj['メモ'] || '')
  };
}

// ====== 入力正規化・日時 ======

function normalizeSalesLogGps_(gps) {
  if (!gps) return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

function normalizeSalesLogReaction_(reaction) {
  const r = String(reaction || '').trim().toUpperCase();
  return SALESLOG_REACTIONS.indexOf(r) >= 0 ? r : '';
}

function salesLogNow_() {
  return Utilities.formatDate(new Date(), getSalesLogTz_(), 'yyyy-MM-dd HH:mm');
}

/**
 * 日時セルを 'yyyy-MM-dd HH:mm' 文字列に正規化
 * ★ Sheets が Date に変換したセルはシートの TZ で解釈（OPS_LESSONS #5 の TZ ズレ対策）
 */
function formatSalesLogDateCell_(cell) {
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, getSalesLogTz_(), 'yyyy-MM-dd HH:mm');
  }
  return String(cell || '').trim();
}

/**
 * v7 Database の TZ を取得（失敗時は OPS_TZ にフォールバック・実行中キャッシュ）
 */
let _salesLogTzCache_ = null;
function getSalesLogTz_() {
  if (_salesLogTzCache_) return _salesLogTzCache_;
  try {
    const id = getConfig().v7SpreadsheetId;
    const tz = SpreadsheetApp.openById(id).getSpreadsheetTimeZone();
    _salesLogTzCache_ = tz || OPS_TZ;
  } catch (e) {
    Logger.log('⚠️ getSalesLogTz_ failed: ' + e);
    _salesLogTzCache_ = OPS_TZ;
  }
  return _salesLogTzCache_;
}

// ====== デバッグ用 ======

function debugSalesLogShops() {
  const res = salesLogShops('7500384947'); // ロンの chatId
  Logger.log(JSON.stringify(res, null, 2));
}

function debugSalesLogCreate() {
  const res = salesLogCreate('7500384947', {
    shopName: 'テスト車屋',
    ownerName: 'テストオーナー',
    phone: '012345678',
    reaction: 'B',
    memo: 'debugSalesLogCreate からのテスト行',
    gps: { lat: 11.556374, lng: 104.928207 }
  });
  Logger.log(JSON.stringify(res, null, 2));
}
