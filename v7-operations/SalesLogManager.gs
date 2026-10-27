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
  '最新反応', '最新反応内容', 'ステータス', 'パートナーID', '訪問回数', '初回訪問日', '最終訪問日', 'メモ'
];

// 車屋の業種（複数選択・カンマ区切りで保存。今後の提案先セグメントの基礎データ）
// ※ 暫定セット（2026-07-25 Daisuke 指示）。ロン君ヒアリング後に見直す — 変更はこの1箇所
// 2026-10-20: 車屋以外の施設（商談計算の「施設」モード）向けに ゴルフ場・レストラン・ホテル・商業施設 を追加
const SALESLOG_SHOP_TYPES = ['中古車販売', '整備・修理', '洗車', 'パーツ', 'タイヤ', '板金・塗装', 'レジデンス',
  'ゴルフ場', 'レストラン', 'ホテル', '商業施設', 'その他'];

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
// 未訪問 = 見込みリストから移した、まだ一度も行っていない店（2026-10-20 一本化）。初めて訪問を記録すると営業中になる
// ※ 先頭（営業中）は新規店の既定値として [0] で参照しているので、追加は末尾に
const SALESLOG_SHOP_STATUSES = ['営業中', '提携済', '見送り', '未訪問'];
const SALESLOG_UNVISITED = '未訪問';
// 店マスター末尾に足す列（見込みリストからの引き継ぎ情報）
const SALESLOG_SHOP_EXTRA_HEADERS = ['Tier', '住所', '出典'];
// 営業ログ末尾に足す列（訪問後のフォロー管理。2026-10-20）
const SALESLOG_FOLLOW_HEADERS = ['次にやること', '期日'];
// 電波がない時にスマホに貯めた記録を、あとで送り直しても二重にならないための番号（2026-10-20 オフライン対策）
const SALESLOG_CLIENT_HEADER = 'client_id';

/** その番号の行が既にあれば { row, obj } を返す（送り直しの二重登録防止） */
function findByClientId_(sheet, clientId) {
  clientId = String(clientId || '').trim();
  if (!clientId) return null;
  return findSheetRow_(sheet, SALESLOG_CLIENT_HEADER, clientId);
}

/** 'yyyy-MM-dd' だけを通す（それ以外は空） */
function normalizeSalesLogDue_(s) {
  s = String(s || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

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

  // v1→v2 移行は 2026-07 に完了済み。安全網として1時間に1回だけ確認する（毎回だと全件読み2回分遅い）
  runAtMostEvery_('saleslog_v2_migration', 60 * 60, ensureSalesLogV2Migration_);

  const shops = readSheetObjects_(getShopSheet_())
    .map(function(r) { return shopRowToApi_(r.obj); })
    .filter(function(s) { return s.shopId; });

  // 地図のピン・一覧で「前回どうだったか」をすぐ見せるため、各店の直近の訪問メモを添える
  // （2026-10-20 Daisuke「2回目の訪問で前回の状況が確認できる営業支援に」）
  const lastByShop = {};
  readSheetObjects_(getSalesLogSheet_()).forEach(function(r) {
    const v = visitRowToApi_(r.obj);
    if (!v.visitId || !v.shopId) return;
    const cur = lastByShop[v.shopId];
    if (!cur || String(v.datetime) >= String(cur.datetime)) lastByShop[v.shopId] = v; // 同じ分なら後の行
  });
  let potentials = {}, lastNotes = {};
  try { potentials = salesHearingLatestByShop_(); } catch (e) { Logger.log('⚠️ salesHearingLatestByShop_: ' + e); }
  try { lastNotes = salesNotesLatestByShop_(); } catch (e) { Logger.log('⚠️ salesNotesLatestByShop_: ' + e); }
  shops.forEach(function(s) {
    const v = lastByShop[s.shopId];
    // 「前回」= 訪問のメモとヒアリングメモのうち新しい方（こまめ保存の画面ではメモをヒアリングメモに書くため）
    const nt = lastNotes[s.shopId];
    const useNote = nt && (!v || !v.memo || String(nt.datetime) >= String(v.datetime));
    s.lastMemo = useNote ? nt.text.substring(0, 200) : (v ? v.memo.substring(0, 200) : '');
    s.lastVisitAt = v ? v.datetime : '';
    s.nextAction = v ? v.nextAction : '';     // 直近の訪問で決めた「次にやること」と期日（ホームの「今日のフォロー」）
    s.nextDue = v ? v.nextDue : '';
    const pt = potentials[s.shopId];
    s.potential = pt ? pt.potential : '';      // 最新の商談計算の見込み評価（S/A/B/C・未計算は空）
    s.potentialMine = pt ? pt.mine : null;     // そのときの紹介料（月・USD）
  });

  // 最終訪問日の新しい順（空は最後）
  shops.sort(function(a, b) {
    return String(b.lastVisit || '').localeCompare(String(a.lastVisit || ''));
  });

  // 商談計算の料金（メニュータブ）。読めなくても店一覧は返す
  let prices = [];
  try { prices = salesHearingPrices_(); } catch (e) { Logger.log('⚠️ salesHearingPrices_: ' + e); }

  return { ok: true, shops: shops, prices: prices };
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

  let hearings = [], notes = [];
  try { hearings = salesHearingsForShop_(shopId); } catch (e) { Logger.log('⚠️ salesHearingsForShop_: ' + e); }
  try { notes = salesNotesForShop_(shopId); } catch (e) { Logger.log('⚠️ salesNotesForShop_: ' + e); }

  // 🔗 QRシール・お店のグループ（ShopQrSticker.gs）。取れなくても店の画面は出す
  const qr = shopQrInfoSafe_(String(shopId), found.obj);

  return { ok: true, shop: shopRowToApi_(found.obj), visits: visits, hearings: hearings, notes: notes, qr: qr };
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

  // 送り直し（オフラインで貯めた記録の再送）なら、前に入った行をそのまま返す。新しい店も二重に作らない
  const dup = findByClientId_(getSalesLogSheet_(), p.clientId);
  if (dup) return { ok: true, visitId: String(dup.obj['visit_id']), shopId: String(dup.obj['shop_id']), duplicate: true };

  if (shopId) {
    // 既存店への訪問追記
    const shopSheet = getShopSheet_();
    const found = findSheetRow_(shopSheet, 'shop_id', shopId);
    if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };
    visitShopName = String(found.obj['店名'] || '');
    // 見込みリストから移した「未訪問」の店は、初めての訪問で営業中にする。位置が無ければ訪問時の GPS を店の位置にする
    const shopUpd = {};
    if (String(found.obj['ステータス']) === SALESLOG_UNVISITED) shopUpd['ステータス'] = SALESLOG_SHOP_STATUSES[0];
    if (gps && (found.obj['緯度'] === '' || found.obj['緯度'] === null)) {
      shopUpd['緯度'] = gps.lat; shopUpd['経度'] = gps.lng; shopUpd['緯度経度結合'] = gps.lat + ',' + gps.lng;
    }
    if (Object.keys(shopUpd).length) updateSheetRow_(shopSheet, found.row, shopUpd);
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
    'shop_id':      shopId,
    '次にやること':  String(p.nextAction || '').trim().substring(0, 300),
    '期日':         normalizeSalesLogDue_(p.nextDue),
    'client_id':    String(p.clientId || '').trim().substring(0, 80)
  });

  refreshShopAggregates_(shopId);
  // 訪問記録と一緒に書いたヒアリングメモ（何件でも・任意）。失敗しても訪問記録は成功のまま
  let notesAdded = 0;
  try { notesAdded = salesNotesAppend_(shopId, visitShopName, staff, p.notes, visitId, gps, p.clientId); }
  catch (e) { Logger.log('⚠️ salesNotesAppend_: ' + e); }
  return { ok: true, visitId: visitId, shopId: shopId, notesAdded: notesAdded };
}

/**
 * 訪問の修正・追記（反応・メモが主。GPS・日時は変更しない）
 */
function salesLogUpdate(chatId, visitId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const sheet = getSalesLogSheet_();
  const found = visitId ? findSheetRow_(sheet, 'visit_id', visitId) : findByClientId_(sheet, p.visitClientId);
  if (!found) return { ok: false, error: 'VISIT_NOT_FOUND' };

  // 送られてきた項目だけを直す（古い画面は反応・メモを毎回送ってくるので、従来どおり上書きになる）
  const updates = { '最終更新日時': salesLogNow_() };
  if (p.hasOwnProperty('reaction')) {
    updates['反応'] = normalizeSalesLogReaction_(p.reaction);
    updates['反応内容'] = reactionLabel_(p.reaction);
  }
  if (p.hasOwnProperty('memo')) updates['メモ'] = String(p.memo || '');
  // v1 互換: 店名/オーナー名/電話は「非空で送られた時のみ」上書き
  // （クリアは店マスター編集 saleslog_shop_update 側で行う）
  if (String(p.shopName || '').trim())  updates['店名']      = String(p.shopName).trim();
  if (String(p.ownerName || '').trim()) updates['オーナー名'] = String(p.ownerName).trim();
  if (String(p.phone || '').trim())     updates['電話']      = String(p.phone).trim();
  // 次にやること・期日（空で送られたら消す＝フォロー完了）。古い画面は送ってこないので、その時は触らない
  if (p.hasOwnProperty('nextAction')) updates['次にやること'] = String(p.nextAction || '').trim().substring(0, 300);
  if (p.hasOwnProperty('nextDue'))    updates['期日'] = normalizeSalesLogDue_(p.nextDue);

  updateSheetRow_(sheet, found.row, updates);

  const shopId = String(found.obj['shop_id'] || '');
  if (shopId) refreshShopAggregates_(shopId);

  return { ok: true, visitId: String(found.obj['visit_id'] || visitId) };
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

  updateSheetRow_(sheet, found.row, updates);
  return { ok: true, shopId: String(shopId) };
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
  if (!hasOrphan && !hasMissingLabel && !shopsMissingLabel.length) return true;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (e) {
    Logger.log('⚠️ 営業ログ移行 lock 取得失敗（先行実行が処理中の可能性）: ' + e);
    return false; // 未確認（runAtMostEvery_ はフラグを立てず次回再確認）
  }
  try {
    runSalesLogV2Migration_(shopsMissingLabel);
    return true;
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
  // 読み戻した値は ' が外れているので、書き戻す前に safeCellValue_ を通す（2026-10-27）
  const headers = getSheetHeaders_(visitSheet);
  const shopIdCol = headers.indexOf('shop_id') + 1;
  const numRows = rows.length;
  if (numRows > 0) {
    const colVals = visitSheet.getRange(2, shopIdCol, numRows, 1).getValues();
    assignments.forEach(function(a) {
      if (a.row - 2 >= 0 && a.row - 2 < numRows) colVals[a.row - 2][0] = a.shopId;
    });
    visitSheet.getRange(2, shopIdCol, numRows, 1).setValues(colVals.map(function(r) { return [safeCellValue_(r[0])]; }));
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
  // 触らない行も読み戻した値を書き戻すので safeCellValue_ を通す（2026-10-27）
  visitSheet.getRange(2, labelCol, rows.length, 1).setValues(colVals.map(function(r) { return [safeCellValue_(r[0])]; }));
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
let _salesLogSheetCache_ = {};
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
 * fn を「key ごとに ttlSec 秒に1回」だけ実行する（CacheService のフラグで判定）。
 * 列チェック・移行チェックのような「毎回やる必要のない確認」をリクエスト経路から外すため。
 *   - key には確認対象の列名一覧などを含める → 列を足すとキーが変わり、次のリクエストで即確認される
 *   - fn が false を返した（ロック取得失敗など）時はフラグを立てず、次回また確認する
 *   - CacheService の障害時は毎回 fn を実行して続行（以前と同じ挙動に戻るだけ）
 */
function runAtMostEvery_(key, ttlSec, fn) {
  let cache = null, k = '';
  try {
    cache = CacheService.getScriptCache();
    k = 'once_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key, Utilities.Charset.UTF_8));
    if (cache.get(k)) return;
  } catch (e) {
    Logger.log('⚠️ runAtMostEvery_ cache 読み取り失敗（毎回確認で続行）: ' + e);
    cache = null;
  }
  if (fn() === false || !cache) return;
  try {
    cache.put(k, '1', ttlSec);
  } catch (e) {
    Logger.log('⚠️ runAtMostEvery_ cache 書き込み失敗（次回も確認）: ' + e);
  }
}

/**
 * 「営業ログ」タブ（無ければヘッダー付きで自動作成。v1 由来なら shop_id 列を自動追加）
 */
function getSalesLogSheet_() {
  if (_salesLogSheetCache_[SALESLOG_SHEET_NAME]) return _salesLogSheetCache_[SALESLOG_SHEET_NAME];
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(SALESLOG_SHEET_NAME);
  if (!sheet) {
    sheet = createHeaderedSheet_(ss, SALESLOG_SHEET_NAME, SALESLOG_HEADERS);
    setColumnTextFormat_(sheet, SALESLOG_HEADERS, '電話');
  } else {
    // 旧版シートへの列追加（コードはヘッダー名参照なので挿入位置による破綻はない）
    runAtMostEvery_(['schema', SALESLOG_SHEET_NAME, 'shop_id', '反応内容', SALESLOG_CLIENT_HEADER].concat(SALESLOG_FOLLOW_HEADERS).join('|'), 6 * 60 * 60, function() {
      const headers = getSheetHeaders_(sheet);
      if (headers.indexOf('shop_id') < 0) {
        sheet.getRange(1, headers.length + 1).setValue('shop_id').setFontWeight('bold');
      }
      return ensureColumnAfter_(sheet, '反応', '反応内容') &&
             ensureColumnsAtEnd_(sheet, SALESLOG_FOLLOW_HEADERS.concat([SALESLOG_CLIENT_HEADER]));
    });
  }
  _salesLogSheetCache_[SALESLOG_SHEET_NAME] = sheet;
  return sheet;
}

/**
 * 「店マスター」タブ（無ければヘッダー付きで自動作成）
 */
function getShopSheet_() {
  if (_salesLogSheetCache_[SALESLOG_SHOP_SHEET_NAME]) return _salesLogSheetCache_[SALESLOG_SHOP_SHEET_NAME];
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(SALESLOG_SHOP_SHEET_NAME);
  const ensureShopColumns = function() {
    return [
      ensureColumnAfter_(sheet, '最新反応', '最新反応内容'),
      ensureColumnAfter_(sheet, '店名', '業種'),
      ensureColumnAfter_(sheet, '電話', 'Facebook'),
      // 提携先ごとの紹介料条件（CommissionManager.gs）。既存の手動列の位置を動かさないよう末尾に追加
      ensureColumnsAtEnd_(sheet, SHOP_TERMS_HEADERS),
      // 提携の種別（個人提携 等・IndividualPartnerOps.gs・2026-10-26）。v7 は列が無いと個人提携か判定できず止める側に倒す
      ensureColumnsAtEnd_(sheet, [INDIVIDUAL_PARTNER_KIND_COL]),
      ensureColumnsAtEnd_(sheet, SALESLOG_SHOP_EXTRA_HEADERS),
      // グループへの通知の言語（プルダウン付き・PartnerLangOps.gs・2026-10-26）。列が無い間は v7 も標準の言語で送る
      ensurePartnerLangColumn_(sheet),
      // 個人提携の配分・本人登録・紹介チラシ（IndividualPartnerOps.gs・2026-10-27）。v7 は列が無いと書かないだけ
      ensureColumnsAtEnd_(sheet, INDIVIDUAL_PARTNER_MASTER_COLS)
    ].every(Boolean);
  };
  if (!sheet) {
    sheet = createHeaderedSheet_(ss, SALESLOG_SHOP_SHEET_NAME, SALESLOG_SHOP_HEADERS);
    setColumnTextFormat_(sheet, SALESLOG_SHOP_HEADERS, '電話');
    Logger.log('🆕 v7 Database に「' + SALESLOG_SHOP_SHEET_NAME + '」タブを新規作成');
    ensureShopColumns(); // 作成直後はフラグに関係なく必ず列を揃える
  } else {
    runAtMostEvery_(['schema', SALESLOG_SHOP_SHEET_NAME, '最新反応内容', '業種', 'Facebook']
      .concat(SHOP_TERMS_HEADERS).concat(SALESLOG_SHOP_EXTRA_HEADERS).concat([PARTNER_GROUP_LANG_COL]).concat(INDIVIDUAL_PARTNER_MASTER_COLS).join('|'), 6 * 60 * 60, ensureShopColumns);
  }
  _salesLogSheetCache_[SALESLOG_SHOP_SHEET_NAME] = sheet;
  return sheet;
}

/**
 * 不足しているヘッダー列をシート末尾にまとめて追加（既にあれば何もしない・冪等）
 * ※ 既存列の位置を一切動かしたくない時用（ensureColumnAfter_ は関連列の隣へ挿入する）
 * ※ ensureColumnAfter_ と同じくダブルチェックロッキングで二重追加を防ぐ
 */
function ensureColumnsAtEnd_(sheet, newHeaders) {
  const isMissing = function(hs) {
    return newHeaders.filter(function(h) { return hs.indexOf(h) < 0; });
  };
  if (!isMissing(getSheetHeaders_(sheet)).length) return true; // 通常パスはロックなし

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (e) {
    Logger.log('⚠️ ensureColumnsAtEnd_ lock取得失敗（先行実行が処理中の可能性）: ' + e);
    return false; // 未確認（runAtMostEvery_ はフラグを立てず次回再確認）
  }
  try {
    const headers = getSheetHeaders_(sheet);
    const missing = isMissing(headers);
    if (!missing.length) return true;
    const startCol = headers.length + 1;
    const needCols = startCol + missing.length - 1 - sheet.getMaxColumns();
    if (needCols > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols);
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]).setFontWeight('bold');
    Logger.log('🆕 ' + sheet.getName() + ' に列を追加: ' + missing.join(', '));
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 指定ヘッダー列の直後に新列を挿入（既にあれば何もしない）
 * ※ GSS を直接見る管理者の可読性のため、末尾でなく関連列の隣に置く
 * ※ 列挿入はスキーマ変更なので LockService で排他（2名同時アクセスの初回に
 *   二重挿入されるレース対策・ダブルチェックロッキング）
 */
function ensureColumnAfter_(sheet, afterHeader, newHeader) {
  if (getSheetHeaders_(sheet).indexOf(newHeader) >= 0) return true; // 通常パスはロックなし

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (e) {
    Logger.log('⚠️ ensureColumnAfter_ lock取得失敗（先行実行が処理中の可能性）: ' + e);
    return false; // 未確認（runAtMostEvery_ はフラグを立てず次回再確認）
  }
  try {
    // ロック内で再確認（先行実行が挿入済みなら何もしない）
    const headers = getSheetHeaders_(sheet);
    if (headers.indexOf(newHeader) >= 0) return true;
    const afterIdx = headers.indexOf(afterHeader);
    if (afterIdx < 0) {
      sheet.getRange(1, headers.length + 1).setValue(newHeader).setFontWeight('bold');
      return true;
    }
    sheet.insertColumnAfter(afterIdx + 1);
    sheet.getRange(1, afterIdx + 2).setValue(newHeader).setFontWeight('bold');
    return true;
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
  // 1回の読み取りでヘッダー＋データ（以前は4回に分けて読んでいた。範囲は同一）
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) return [];
  const headers = all[0].map(String);
  return all.slice(1).map(function(row, i) {
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

/**
 * appendSheetRow_ / updateSheetRow_ が1セルに書く値（2026-10-27）。
 * 店名・メモ・オーナー名などはミニアプリ（スタッフ）・フォームから届くか、v7 Database から読み戻した値なので
 * 全部 sheetCellValue_（SheetHelpers.gs・先頭が = + - @ なら '）に通す。
 * 電話は従来どおり safeCellText_: 「+85512345678」のように + で始まれば数字だけでも ' を付けて文字にする
 * （safeCellValue_ だと数値になって + が落ちる。「+855 …」が数式あつかいで #ERROR! になるのも防ぐ）
 */
function salesLogCellValue_(header, v) {
  if (header === '電話' && !(v instanceof SheetRawValue_)) return safeCellText_(v);
  return sheetCellValue_(v);
}

function appendSheetRow_(sheet, dict) {
  const headers = getSheetHeaders_(sheet);
  const row = headers.map(function(h) {
    return dict.hasOwnProperty(h) ? salesLogCellValue_(h, dict[h]) : '';
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
    sheet.getRange(rowNumber, idx + 1).setValue(salesLogCellValue_(col, updates[col]));
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
    updatedAt: formatSalesLogDateCell_(obj['最終更新日時']),
    nextAction: String(obj['次にやること'] || ''),
    nextDue:   formatSalesLogDateCell_(obj['期日']).substring(0, 10)
  };
}

function shopRowToApi_(obj) {
  const terms = shopCommissionTerms_(obj);
  return {
    // 紹介料条件（空欄は既定値で補完済み。コミッション記帳フォームの初期値に使う）
    commissionRate:   terms.rate,
    defaultCollector: terms.collector,
    introducerName:   terms.introducerName,
    introducerRate:   terms.introducerRate,
    introducerUntil:  terms.introducerUntil,
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
    status:       String(obj['ステータス'] || ''),
    partnerId:    String(obj['パートナーID'] || ''),
    visitCount:   Number(obj['訪問回数']) || 0,
    firstVisit:   formatSalesLogDateCell_(obj['初回訪問日']).substring(0, 10),
    lastVisit:    formatSalesLogDateCell_(obj['最終訪問日']).substring(0, 10),
    memo:         String(obj['メモ'] || ''),
    tier:         String(obj['Tier'] || ''),
    address:      String(obj['住所'] || ''),
    source:       String(obj['出典'] || '')
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
    const tz = getSalesLogSs_().getSpreadsheetTimeZone();
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
