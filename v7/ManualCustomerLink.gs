/**
 * ManualCustomerLink.gs — 手入力ジョブ × 顧客Telegram連携（QRディープリンク）
 *
 * 【背景】2026-08-28 Daisuke 指示
 *   ミニアプリの手入力（手動登録・キャンペーン売上）で受けたお客さんは
 *   予約行にチャットIDが無く、Before/After 写真の顧客送信がスキップされていた
 *   （JobManager.gs の顧客送信は チャットID がある時のみ動く）。
 *   現場で QR（t.me/<予約Bot>?start=link_... / bk_...）をスキャンしてもらい
 *   BookingBot に流入させることで:
 *     - Before/After 写真の3方向配信（顧客 / 管理トピック / シート）に乗せる
 *     - 顧客台帳（CUSTOMERS）＋管理グループの顧客トピックで一元管理する
 *
 * 【ディープリンク payload】
 *   - link_<連携コード> : 手動ジョブ（予約なし）。ミニアプリがジョブ毎に生成し、
 *                         job_start / job_end / job のボディ(linkToken)で送信 →
 *                         作業記録「連携コード」列に保存される
 *   - bk_<予約ID>       : 予約行が既にあるもの（キャンペーン売上・手動特価予約）
 *
 * 【スキャン先行の競合】
 *   お客さんのスキャンが job_start の到着より早い場合は ScriptProperties に
 *   待避（pendlink_<code>）し、apiJobStart 側が consumePendingLink_ で解決する。
 *
 * 【関連】
 *   - BookingBot.gs handleCustomerMessage（/start ルーティング）
 *   - JobManager.gs apiJobStart / apiJobEnd / apiJobFinal（linkToken 対応）
 *   - ManualSales.gs recordManualJobSaleIfNeeded_（売上行への チャットID 引き継ぎ）
 *   - ShopRouting.gs handleShopStart_（同型のディープリンク前例 shop_）
 */

// ====== 定数 ======

// 作業記録シートに追加する列（ensureJobsLinkColumns_ が冪等に確保）
var JOBS_COL_LINK_TOKEN    = '連携コード';
var JOBS_COL_CUSTOMER_CHAT = '顧客チャットID';

// スキャンが job_start より先に届いた場合の待避キー（ScriptProperties）
var PENDING_LINK_PREFIX = 'pendlink_';
var PENDING_LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24時間で無効扱い

// 顧客向け接続完了メッセージ（Panha 校閲済み 2026-08-28・មុនលាង／ក្រោយលាង は glossary 確定構造）
var MANUAL_LINK_CONNECTED_MSG_ =
  '✅ បានភ្ជាប់ជាមួយ SAMURAI MOTORS ហើយ!\n' +
  'រូបថតរថយន្តរបស់អ្នក មុនលាង／ក្រោយលាង នឹងផ្ញើមកទីនេះ។\n' +
  '\n' +
  'Connected to SAMURAI MOTORS!\n' +
  'Your car wash Before/After photos will arrive here.';

// キャッチアップ送信のキャプション（既存の job_start / job_end 文言と統一）
var MANUAL_LINK_BEFORE_CAPTION_ = '📸 រូបថតមុនពេលលាង / Before photos ↓';
var MANUAL_LINK_AFTER_CAPTION_  = '📸 រូបថតក្រោយពេលលាង / After photos ↓';

// ====== Bot エントリポイント ======

/**
 * /start link_<連携コード> / bk_<予約ID> を処理する
 * BookingBot.gs handleCustomerMessage から呼ばれる
 *
 * @param {Object} msg  - Telegram message
 * @param {string} text - '/start link_xxx' 等
 * @return {boolean} 処理した場合 true（以降の通常転送をスキップ）
 */
function handleManualLinkStart_(msg, text) {
  var m = text.match(/^\/start\s+(link|bk)_([A-Za-z0-9_\-]+)$/);
  if (!m) return false;
  var kind = m[1];
  var key = m[2];
  var chatId = String(msg.chat.id);

  try {
    // Booking メニューボタンを確保（新規客の取りこぼし防止・/start と同等）
    if (typeof ensureBookingMenuButton_ === 'function') {
      try { ensureBookingMenuButton_(chatId); } catch (eBtn) { /* best-effort */ }
    }

    // 顧客台帳登録＋管理グループの顧客トピック確保（1顧客=1トピック基盤に乗せる）
    var customer = extractCustomerFromMessage(msg);
    var topic = null;
    try {
      topic = getOrCreateTopic(customer);
    } catch (eTopic) {
      Logger.log('⚠️ handleManualLinkStart_: トピック作成失敗（処理続行）: ' + eTopic);
    }

    // 接続完了メッセージを顧客へ
    try {
      sendMessage(BOT_TYPE.BOOKING, chatId, MANUAL_LINK_CONNECTED_MSG_);
    } catch (eMsg) {
      Logger.log('⚠️ handleManualLinkStart_: 接続完了メッセージ送信失敗: ' + eMsg);
    }

    // 連携本体
    var result = (kind === 'link')
      ? linkTokenScan_(key, chatId)
      : linkBookingScan_(key, chatId);

    // 管理グループ（顧客トピック）へ結果通知
    notifyLinkResultToAdmin_(topic, customer, kind, key, result);

    Logger.log('🔗 handleManualLinkStart_: kind=' + kind + ' key=' + key +
               ' chatId=' + chatId + ' mode=' + result.mode +
               ' before=' + result.before + ' after=' + result.after);
  } catch (err) {
    Logger.log('❌ handleManualLinkStart_ error: ' + err + ' stack=' + (err.stack || ''));
  }
  return true;
}

// ====== link_<連携コード>（手動ジョブ） ======

/**
 * 連携コードで作業記録を探し、顧客チャットIDの紐付け＋写真キャッチアップ送信を行う
 *
 * @param {string} token
 * @param {string} chatId
 * @return {{mode: string, bookingId: string, before: number, after: number}}
 */
function linkTokenScan_(token, chatId) {
  ensureJobsLinkColumns_();
  var rows = findJobsRowsByLinkToken_(token);

  if (rows.length === 0) {
    // job_start 未着（スキャン先行のレア競合）→ 待避して apiJobStart 側で解決
    try {
      PropertiesService.getScriptProperties().setProperty(
        PENDING_LINK_PREFIX + token,
        JSON.stringify({ chatId: chatId, ts: Date.now() }));
    } catch (e) {
      Logger.log('⚠️ pendlink 保存失敗: ' + e);
    }
    return { mode: 'pending', bookingId: '', before: 0, after: 0 };
  }

  // 作業記録の全該当行に顧客チャットIDを書き込み
  rows.forEach(function(r) {
    if (String(r.data[JOBS_COL_CUSTOMER_CHAT] || '') !== chatId) {
      var u = {};
      u[JOBS_COL_CUSTOMER_CHAT] = chatId;
      updateRow(SHEET_NAMES.JOBS, r.rowIndex, u);
    }
  });

  // 予約行があれば チャットID / 顧客ID をバックフィル（台帳一元化）
  var bookingId = '';
  rows.forEach(function(r) {
    if (!bookingId) bookingId = String(r.data['予約ID'] || '').trim();
  });
  var bkRow = bookingId
    ? findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId)
    : findManualSaleBookingRowForJobs_(rows); // 売上自動計上行（ManualSales）を重複キーで逆引き
  if (bkRow) {
    bookingId = String(bkRow.data['予約ID'] || bookingId);
    backfillBookingChat_(bkRow, chatId);
  }

  // 撮影済み写真のキャッチアップ送信（スキャンが作業後でも届く）
  var urls = collectJobPhotoUrls_(rows);
  var sent = sendCatchupPhotos_(chatId, urls.before, urls.after);

  // 有償の手動ジョブが完了済みなら支払いのご案内も送る（無償はQRを送らない・2026-08-28 A案）
  var paidAmount = 0;
  for (var pi = rows.length - 1; pi >= 0; pi--) {
    var pd = rows[pi].data;
    if (String(pd['予約ID'] || '').trim()) continue;      // 予約経由は既存の決済フロー管轄
    if (String(pd['作業状態'] || '') !== '完了') continue; // 作業中は料金未確定
    var amt = Number(pd['料金(USD)']);
    if (amt > 0) { paidAmount = amt; break; }
  }
  if (paidAmount > 0) {
    try {
      sendManualPaymentInfo_(chatId, paidAmount);
    } catch (ePay) {
      Logger.log('⚠️ 支払いご案内送信失敗(catch-up): ' + ePay);
    }
  }

  return { mode: 'job', bookingId: bookingId, before: sent.before, after: sent.after, paid: paidAmount };
}

// ====== bk_<予約ID>（キャンペーン売上・手動特価予約） ======

/**
 * 予約IDで予約行を探し、チャットID紐付け＋写真キャッチアップ送信を行う
 *
 * @param {string} bookingId
 * @param {string} chatId
 * @return {{mode: string, bookingId: string, before: number, after: number}}
 */
function linkBookingScan_(bookingId, chatId) {
  var bkRow = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
  if (!bkRow) {
    return { mode: 'notfound', bookingId: bookingId, before: 0, after: 0 };
  }

  var existing = String(bkRow.data['チャットID'] || '');
  if (existing && existing !== chatId) {
    // 既に別の顧客と紐付いている → 上書きしない（誤スキャン対策・管理通知のみ）
    return { mode: 'conflict', bookingId: bookingId, before: 0, after: 0 };
  }

  backfillBookingChat_(bkRow, chatId);

  // この予約に作業記録があれば写真キャッチアップ
  var rows = findJobsRowsByBookingId_(bookingId);
  var urls = collectJobPhotoUrls_(rows);
  var sent = sendCatchupPhotos_(chatId, urls.before, urls.after);
  return { mode: 'booking', bookingId: bookingId, before: sent.before, after: sent.after };
}

// ====== 予約行バックフィル ======

/**
 * 予約行の チャットID / 顧客ID を空欄の場合のみ埋める
 */
function backfillBookingChat_(bkRow, chatId) {
  var updates = {};
  if (!String(bkRow.data['チャットID'] || '')) {
    updates['チャットID'] = chatId;
  }
  if (!String(bkRow.data['顧客ID'] || '')) {
    var cust = findCustomerRow(chatId);
    if (cust && cust.data['顧客ID']) {
      updates['顧客ID'] = String(cust.data['顧客ID']);
    }
  }
  if (Object.keys(updates).length > 0) {
    updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, updates);
  }
}

/**
 * 手動ジョブの売上自動計上行（ManualSales.gs）を重複キー(MS:...)の逆算で探す
 * スキャンが作業完了後（売上行作成後）だった場合のバックフィル用
 *
 * @param {Array<{rowIndex: number, data: Object}>} rows - 作業記録の該当行
 * @return {{rowIndex: number, data: Object} | null}
 */
function findManualSaleBookingRowForJobs_(rows) {
  try {
    var tz = getSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
    for (var i = rows.length - 1; i >= 0; i--) {
      var d = rows[i].data;
      if (String(d['作業状態'] || '') !== '完了') continue;
      var amount = Number(d['料金(USD)']);
      if (!(amount > 0)) continue;
      var fin = d['完了時刻'];
      if (!(fin instanceof Date)) fin = fin ? new Date(fin) : null;
      if (!fin || isNaN(fin.getTime())) continue;

      // 車種セルは「carModel / plate」形式（apiJobStart 参照）
      var carCell = String(d['車種'] || '');
      var parts = carCell.split(' / ');
      var carModel = (parts[0] || '').trim();
      var plate = (parts.length > 1 ? parts[1] : '').trim();
      if (!plate && !carModel) continue; // キー再現不可（name は作業記録に無い）

      var dedupeKey = 'MS:' + Utilities.formatDate(fin, tz, 'yyyyMMdd') + ':' +
                      (plate || carModel) + ':' + amount;
      var bkRow = findBookingRowByMemoNeedle_(dedupeKey);
      if (bkRow) return bkRow;
    }
  } catch (e) {
    Logger.log('⚠️ findManualSaleBookingRowForJobs_: ' + e);
  }
  return null;
}

/**
 * 管理者メモに指定文字列を含む予約行を後ろから探す
 * （ManualSales.findBookingMemoContains_ の行取得版）
 */
function findBookingRowByMemoNeedle_(needle) {
  var sheet = getSheet(SHEET_NAMES.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  var memoCol = headers['管理者メモ'];
  if (!memoCol) return null;
  var memos = sheet.getRange(2, memoCol, lastRow - 1, 1).getValues();
  for (var i = memos.length - 1; i >= 0; i--) {
    if (String(memos[i][0] || '').indexOf(needle) !== -1) {
      var rowIndex = i + 2;
      return { rowIndex: rowIndex, data: readRow(SHEET_NAMES.BOOKINGS, rowIndex) };
    }
  }
  return null;
}

// ====== 作業記録の検索・列確保 ======

/**
 * 作業記録シートに連携用2列（連携コード・顧客チャットID）を冪等に確保する
 */
function ensureJobsLinkColumns_() {
  try {
    var sheet = getSheet(SHEET_NAMES.JOBS);
    [JOBS_COL_LINK_TOKEN, JOBS_COL_CUSTOMER_CHAT].forEach(function(name) {
      var headers = getHeaderMap(SHEET_NAMES.JOBS); // キャッシュ無し・毎回シートから読む
      if (!headers[name]) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(name);
      }
    });
  } catch (e) {
    Logger.log('⚠️ ensureJobsLinkColumns_ 失敗（処理は継続）: ' + e);
  }
}

/**
 * 連携コードで作業記録の全該当行を返す
 */
function findJobsRowsByLinkToken_(token) {
  return findJobsRowsByColumn_(JOBS_COL_LINK_TOKEN, token);
}

/**
 * 予約IDで作業記録の全該当行を返す
 */
function findJobsRowsByBookingId_(bookingId) {
  return findJobsRowsByColumn_('予約ID', bookingId);
}

/**
 * 作業記録シートを指定列の値でスキャンし、該当行の配列を返す
 * （手動ジョブは job_start 行と job(最終送信) 行の2行になり得るため全行を返す）
 */
function findJobsRowsByColumn_(colName, value) {
  var out = [];
  try {
    if (!value) return out;
    var sheet = getSheet(SHEET_NAMES.JOBS);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;
    var headers = getHeaderMap(SHEET_NAMES.JOBS);
    var col = headers[colName];
    if (!col) return out;
    var lastCol = sheet.getLastColumn();
    var vals = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    vals.forEach(function(rowVals, idx) {
      if (String(rowVals[col - 1] || '').trim() !== String(value)) return;
      var data = {};
      Object.keys(headers).forEach(function(h) { data[h] = rowVals[headers[h] - 1]; });
      out.push({ rowIndex: idx + 2, data: data });
    });
  } catch (e) {
    Logger.log('⚠️ findJobsRowsByColumn_(' + colName + '): ' + e);
  }
  return out;
}

/**
 * 作業記録行群から Before/After 写真URLを重複除去して集める
 */
function collectJobPhotoUrls_(rows) {
  var seen = {};
  var before = [];
  var after = [];
  rows.forEach(function(r) {
    String(r.data['Before写真URL'] || '').split('\n').forEach(function(u) {
      u = String(u).trim();
      if (u && !seen[u]) { seen[u] = 1; before.push(u); }
    });
    String(r.data['After写真URL'] || '').split('\n').forEach(function(u) {
      u = String(u).trim();
      if (u && !seen[u]) { seen[u] = 1; after.push(u); }
    });
  });
  return { before: before, after: after };
}

// ====== 待避コード（スキャン先行時） ======

/**
 * 待避された連携コードを解決して chatId を返す（読んだら削除・期限切れは無効）
 * apiJobStart / apiJobFinal から呼ばれる
 *
 * @param {string} token
 * @return {string} chatId（無ければ ''）
 */
function consumePendingLink_(token) {
  try {
    if (!token) return '';
    var props = PropertiesService.getScriptProperties();
    var key = PENDING_LINK_PREFIX + token;
    var raw = props.getProperty(key);
    if (!raw) return '';
    props.deleteProperty(key);
    var obj = JSON.parse(raw);
    if (!obj || !obj.chatId) return '';
    if (Date.now() - Number(obj.ts || 0) > PENDING_LINK_TTL_MS) {
      Logger.log('ℹ️ pendlink 期限切れ: ' + token);
      return '';
    }
    return String(obj.chatId);
  } catch (e) {
    Logger.log('⚠️ consumePendingLink_: ' + e);
    return '';
  }
}

// ====== 写真キャッチアップ送信 ======

/**
 * Drive URL から写真を取り直して顧客へアルバム送信する
 *
 * @param {string} chatId
 * @param {Array<string>} beforeUrls
 * @param {Array<string>} afterUrls
 * @return {{before: number, after: number}} 送信できた枚数
 */
function sendCatchupPhotos_(chatId, beforeUrls, afterUrls) {
  var sent = { before: 0, after: 0 };
  try {
    var beforeBlobs = driveUrlsToBlobs_(beforeUrls);
    if (beforeBlobs.length > 0) {
      try { sendMessage(BOT_TYPE.BOOKING, chatId, MANUAL_LINK_BEFORE_CAPTION_); } catch (e1) {}
      var r1 = sendPhotoAlbum(BOT_TYPE.BOOKING, chatId, beforeBlobs, '', {});
      if (r1 && r1.ok !== false) sent.before = beforeBlobs.length;
    }
    var afterBlobs = driveUrlsToBlobs_(afterUrls);
    if (afterBlobs.length > 0) {
      try { sendMessage(BOT_TYPE.BOOKING, chatId, MANUAL_LINK_AFTER_CAPTION_); } catch (e2) {}
      var r2 = sendPhotoAlbum(BOT_TYPE.BOOKING, chatId, afterBlobs, '', {});
      if (r2 && r2.ok !== false) sent.after = afterBlobs.length;
    }
  } catch (e) {
    Logger.log('⚠️ sendCatchupPhotos_: ' + e);
  }
  return sent;
}

/**
 * Drive の閲覧URL配列から Blob 配列を作る（壊れたURLはスキップ）
 * URL形式: https://drive.google.com/file/d/<id>/view?... （saveBase64PhotosToDrive 由来）
 */
function driveUrlsToBlobs_(urls) {
  var blobs = [];
  (urls || []).forEach(function(url) {
    try {
      var m = String(url).match(/\/d\/([-\w]{20,})/) || String(url).match(/[?&]id=([-\w]{20,})/);
      if (!m) return;
      blobs.push(DriveApp.getFileById(m[1]).getBlob());
    } catch (e) {
      Logger.log('⚠️ driveUrlsToBlobs_ スキップ: ' + url + ' : ' + e);
    }
  });
  return blobs;
}

// ====== 支払いのご案内（有償の手動ジョブのみ） ======

/**
 * 有償の手動ジョブ向けに ABA QR 画像＋合計金額の「支払いのご案内」を送る
 *
 * 【A案・ご案内型（2026-08-28 Daisuke 裁可）】
 *   - 台帳の決済状態は一切触らない（手動売上は従来通り「清算済み」で自動計上、
 *     受領確認は現場のロン君が行う）
 *   - スクショ返送依頼はしない（sendPaymentQR の追跡フローとは別物）
 *   - 無償ジョブ（amount<=0）には送らない（呼び出し側で分岐＋本関数でも防衛）
 *
 * @param {string} chatId
 * @param {number} amount - USD
 */
function sendManualPaymentInfo_(chatId, amount) {
  if (!(Number(amount) > 0)) return; // 防衛: 無償にはQRを送らない
  var qr = (typeof getActiveQR === 'function') ? getActiveQR() : null;
  var caption =
    '💰 ការទូទាត់ប្រាក់ / Payment\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '💵 សរុប / Total: ' + Number(amount) + '$\n' +
    (qr && qr.bank ? '🏦 ' + qr.bank + '\n' : '') +
    '━━━━━━━━━━━━━━━━━\n' +
    '📱 សូមស្កេន QR ដើម្បីបង់ប្រាក់ ឬ បង់ជាសាច់ប្រាក់ក៏បានដែរ\n' +
    '📱 Scan QR to pay, or pay by cash — both OK';
  if (qr && qr.imageUrl && typeof sendQRImage === 'function') {
    sendQRImage(chatId, qr.imageUrl, caption);
  } else {
    // QR未設定でも金額のご案内だけは送る
    sendMessage(BOT_TYPE.BOOKING, chatId, caption);
  }
}

// ====== 管理グループ通知 ======

/**
 * 連携結果を管理グループ（顧客トピック）へ通知する
 */
function notifyLinkResultToAdmin_(topic, customer, kind, key, result) {
  try {
    var cfg = getConfig();
    var name = buildDisplayName(customer);
    var head = '🔗 QR連携（手入力ジョブ×顧客）\n' +
               '━━━━━━━━━━━━━━━━━\n' +
               '👤 ' + name + ' (chat_id=' + customer.chatId + ')\n';
    var body;
    switch (result.mode) {
      case 'job':
        body = '✅ 連携完了（作業記録）\n' +
               (result.bookingId ? '🆔 ' + result.bookingId + '\n' : '') +
               '📸 顧客へ送信: Before ' + result.before + '枚 / After ' + result.after + '枚' +
               (result.paid > 0 ? '\n💵 支払いご案内送付: ' + result.paid + '$（案内型・台帳は現場清算のまま）' : '');
        break;
      case 'booking':
        body = '✅ 連携完了（予約 ' + result.bookingId + '）\n' +
               '📸 顧客へ送信: Before ' + result.before + '枚 / After ' + result.after + '枚';
        break;
      case 'pending':
        body = '⏳ 受付済み（作業データ到着待ち）\n' +
               'ℹ️ ミニアプリの「スタート」後に自動で連携・写真送信されます';
        break;
      case 'conflict':
        body = '⚠️ 予約 ' + result.bookingId + ' は別の顧客と連携済みのため上書きしません';
        break;
      case 'notfound':
        body = '⚠️ 予約が見つかりません: ' + key;
        break;
      default:
        body = 'ℹ️ mode=' + result.mode;
    }
    var opts = (topic && topic.threadId) ? { message_thread_id: topic.threadId } : {};
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, head + body, opts);
  } catch (e) {
    Logger.log('⚠️ notifyLinkResultToAdmin_: ' + e);
  }
}
