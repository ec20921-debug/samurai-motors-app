/**
 * ShopProvisioningManager.gs — 提携店5分プロビジョニング（2026-08-09）
 *
 * 【目的】提携が決まったら現地スタッフだけで「店舗専用QR＋店舗グループ連携」を完了させる。
 *   フロー: Googleフォーム入力 → shop_id採番(店マスター) → 専用QR自動生成(Drive)
 *         → ワンタイムコード発行 → 店舗グループで /register <コード> → 連携完了
 *
 * 【設計の根拠】Vault/04_Projects/Samurai/04_Businesses/Motors/
 *   - 2026-08-09-partner-stamp-bot-scheme.md（スタンプ×Bot連携スキーム）
 *   - 2026-08-09-partner-bot-provisioning-design.md（1ボット多店舗・トークン発行ゼロが標準）
 *
 * 【データ配置】
 *   - 店マスター（v7 Database）: 既存の shop_id 体系をそのまま使用（SalesLogManager.createShopRow_ を再利用）
 *   - Bot連携シート（v7 Database に新設）: shop_id ⇄ ワンタイムコード ⇄ グループchat_id の橋渡し台帳。
 *     v7（予約Bot側 ShopRouting.gs）と v7-operations（本ファイル）の両プロジェクトから読めるよう GSS に置く
 *     （Script Properties はプロジェクト間で共有できないため）
 *   - コミッション台帳（勤務用GSS）: 月次レポートの集計元（既存 CommissionManager と同一シート）
 *
 * 【セキュリティ】トークンはコード・シートに書かない（GAS_PATTERNS #3）。
 *   月次レポート送信用の BOT_TOKEN_BOOKING は本プロジェクトの Script Properties に登録する（手順書参照）。
 */

// ====== 定数 ======

var SHOP_PROV_LINK_SHEET = 'Bot連携';   // v7 Database に新設
var SHOP_PROV_LINK_HEADERS = [
  'shop_id', '店名', 'ワンタイムコード', 'グループchat_id', 'グループ名', '紐付け日時', '状態', 'QRリンク', '登録日時'
];
// 状態: 待機中（コード発行済・未連携） / 連携済 / 停止

var SHOP_PROV_FORM_TITLE = 'Samurai Motors 提携店登録 / Partner Shop Registration';
var SHOP_PROV_QR_FOLDER = 'SamuraiMotors_ShopQR';

// フォーム項目ラベル（handleShopFormSubmit と 1文字違わず一致させること）
var SHOP_PROV_FIELDS = {
  SHOP_NAME: '店名 / Shop name',
  SHOP_TYPE: '業種 / Business type',
  OWNER: 'オーナー名 / Owner name',
  PHONE: '電話番号 / Phone',
  LOCATION: '場所（住所 or Google Mapsリンク） / Location',
  STAFF_TG: '担当者のTelegramユーザー名 / Contact Telegram username',
  BRAND_BOT: 'ブランドBot希望 / Want a branded bot?',
  NOTE: 'メモ / Note'
};

// ====== 設定取得（新規キーは本モジュール内で完結させ Config.gs を汚さない） ======

function getShopProvProps_() {
  var p = PropertiesService.getScriptProperties();
  return {
    formId: p.getProperty('SHOP_FORM_ID') || '',
    botUsername: p.getProperty('SHOP_BOOKING_BOT_USERNAME') || 'SAMURAI_MOTORS_BOOKING_BOT',
    bookingBotToken: p.getProperty('BOT_TOKEN_BOOKING') || ''   // 月次レポート送信用（手順書の手順で登録）
  };
}

// ====== ① 初期セットアップ（日本側・一度だけ実行） ======

/**
 * 提携店登録フォームを自動作成し、送信トリガーを設定する。
 * 実行後、ログに出るフォームURLを現地スタッフに共有すれば運用開始できる。
 */
function setupShopProvisioning() {
  var form = FormApp.create(SHOP_PROV_FORM_TITLE);
  form.setDescription(
    '提携が決まったお店の情報を入力してください。送信すると自動でQRコードができます。\n' +
    'Fill in the new partner shop info. A QR code will be created automatically.'
  );

  form.addTextItem().setTitle(SHOP_PROV_FIELDS.SHOP_NAME).setRequired(true);

  var typeItem = form.addMultipleChoiceItem().setTitle(SHOP_PROV_FIELDS.SHOP_TYPE).setRequired(true);
  // SalesLogManager の業種と一致させる（店マスターの既存分類）
  typeItem.setChoices([
    typeItem.createChoice('中古車販売'),
    typeItem.createChoice('整備・修理'),
    typeItem.createChoice('洗車'),
    typeItem.createChoice('パーツ'),
    typeItem.createChoice('タイヤ'),
    typeItem.createChoice('板金・塗装'),
    typeItem.createChoice('ゴルフ場・ゴルフ練習場'),
    typeItem.createChoice('その他')
  ]);

  form.addTextItem().setTitle(SHOP_PROV_FIELDS.OWNER).setRequired(true);
  form.addTextItem().setTitle(SHOP_PROV_FIELDS.PHONE).setRequired(true);
  form.addTextItem().setTitle(SHOP_PROV_FIELDS.LOCATION);
  form.addTextItem().setTitle(SHOP_PROV_FIELDS.STAFF_TG);

  var brandItem = form.addMultipleChoiceItem().setTitle(SHOP_PROV_FIELDS.BRAND_BOT).setRequired(true);
  brandItem.setChoices([
    brandItem.createChoice('いいえ（標準。これで十分です） / No (standard)'),
    brandItem.createChoice('はい（店名義の専用Botが必要） / Yes (branded bot)')
  ]);

  form.addParagraphTextItem().setTitle(SHOP_PROV_FIELDS.NOTE);

  var p = PropertiesService.getScriptProperties();
  p.setProperty('SHOP_FORM_ID', form.getId());

  // 送信トリガー（冪等: 同関数の既存トリガーを消してから作る）
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handleShopFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('handleShopFormSubmit').forForm(form).onFormSubmit().create();

  ensureShopLinkSheet_();

  Logger.log('✅ 提携店登録フォーム作成完了');
  Logger.log('📝 入力URL（現地スタッフに共有）: ' + form.getPublishedUrl());
  Logger.log('🛠 編集URL: ' + form.getEditUrl());
}

// ====== ② フォーム送信 → 自動プロビジョニング ======

/**
 * フォーム送信ハンドラ: shop_id採番 → Bot連携行作成 → QR生成 → 管理グループ通知
 */
function handleShopFormSubmit(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (err) {
    // PartnerManager の作法: ロック失敗でもフォーム送信は取りこぼさない（採番衝突リスクは許容）
    Logger.log('⚠️ ShopForm: Lock 取得失敗 — 処理継続: ' + err);
  }

  var shopId = '', shopName = '', qrUrl = '', otc = '', brandBot = false;
  try {
    var nv = e.namedValues || {};
    var get = function(label) {
      var v = nv[label];
      return (v && v.length) ? String(v[0]).trim() : '';
    };

    shopName = get(SHOP_PROV_FIELDS.SHOP_NAME);
    if (!shopName) { Logger.log('⚠️ 店名が空のため中断'); return; }

    var shopType = get(SHOP_PROV_FIELDS.SHOP_TYPE);
    // 店マスターに保存を許可する業種（フォーム選択肢と一致させること）。
    // ※「ゴルフ場・ゴルフ練習場」は提携用の新分類。営業ログミニアプリの SALESLOG_SHOP_TYPES とは独立
    var knownTypes = ['中古車販売', '整備・修理', '洗車', 'パーツ', 'タイヤ', '板金・塗装', 'ゴルフ場・ゴルフ練習場', 'その他'];
    var typeForMaster = (knownTypes.indexOf(shopType) >= 0) ? shopType : 'その他';

    brandBot = get(SHOP_PROV_FIELDS.BRAND_BOT).indexOf('はい') === 0;

    var noteParts = [];
    noteParts.push('提携店登録フォーム経由 ' + formatOpsDateTime_(new Date()));
    if (typeForMaster !== shopType && shopType) noteParts.push('業種詳細: ' + shopType);
    var loc = get(SHOP_PROV_FIELDS.LOCATION);
    if (loc) noteParts.push('場所: ' + loc);
    var staffTg = get(SHOP_PROV_FIELDS.STAFF_TG);
    if (staffTg) noteParts.push('担当TG: ' + staffTg);
    if (brandBot) noteParts.push('★ブランドBot希望');
    var note = get(SHOP_PROV_FIELDS.NOTE);
    if (note) noteParts.push(note);

    // 店マスターに登録（既存の採番・スキーマを再利用。ステータスは提携済で開始）
    shopId = createShopRow_({
      '店名': shopName,
      '業種': typeForMaster,
      'オーナー名': get(SHOP_PROV_FIELDS.OWNER),
      '電話': get(SHOP_PROV_FIELDS.PHONE),
      'ステータス': '提携済',
      'メモ': noteParts.join(' / ')
    });

    // ワンタイムコード（6桁・数字のみ。/register で使用）
    otc = String(Math.floor(100000 + Math.random() * 900000));

    // 店舗専用ディープリンク → QR画像を Drive に保存
    var props = getShopProvProps_();
    var deepLink = 'https://t.me/' + props.botUsername + '?start=shop_' + shopId;
    qrUrl = createShopQrPng_(deepLink, shopName, shopId);

    // Bot連携台帳へ行追加（v7 Database）
    var sheet = ensureShopLinkSheet_();
    sheet.appendRow([
      shopId, shopName, otc, '', '', '', '待機中', qrUrl, formatOpsDateTime_(new Date())
    ]);
    SpreadsheetApp.flush();
  } finally {
    // Telegram 送信前にロック解放（PartnerManager の作法を踏襲）
    try { lock.releaseLock(); } catch (ignore) {}
  }

  // 管理グループへ完了通知（パートナートピックがあればそこへ）
  try {
    notifyShopProvisioned_(shopId, shopName, qrUrl, otc, brandBot);
  } catch (err) {
    Logger.log('⚠️ 提携店プロビジョニング通知失敗: ' + err);
  }
}

/**
 * QRコードPNGを生成して Drive に保存し、閲覧URLを返す。
 * 生成は外部API（api.qrserver.com）を使用。データはディープリンクURLのみで機密情報を含まない。
 */
function createShopQrPng_(data, shopName, shopId) {
  var api = 'https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=2&data=' + encodeURIComponent(data);
  var res = UrlFetchApp.fetch(api, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('QR生成API失敗: HTTP ' + res.getResponseCode());
  }
  var folder = getOrCreateFolder_(SHOP_PROV_QR_FOLDER);
  var blob = res.getBlob().setName('QR_' + shopName + '_' + shopId + '.png');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/**
 * Bot連携シート（v7 Database）を取得。無ければヘッダー付きで作成
 */
function ensureShopLinkSheet_() {
  var cfg = getConfig();
  if (!cfg.v7SpreadsheetId) throw new Error('V7_SPREADSHEET_ID 未設定');
  var ss = SpreadsheetApp.openById(cfg.v7SpreadsheetId);
  var sheet = ss.getSheetByName(SHOP_PROV_LINK_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SHOP_PROV_LINK_SHEET);
    sheet.getRange(1, 1, 1, SHOP_PROV_LINK_HEADERS.length).setValues([SHOP_PROV_LINK_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 管理グループ（パートナートピック）へ「QRできました＋次の手順」を通知
 */
function notifyShopProvisioned_(shopId, shopName, qrUrl, otc, brandBot) {
  var cfg = getConfig();
  var lines = [
    '🏪 新規提携店を登録しました',
    '',
    '店名: ' + shopName,
    'shop_id: ' + shopId,
    'QRコード: ' + qrUrl,
    'ワンタイムコード: ' + otc,
    ''
  ];
  if (brandBot) {
    lines.push('⚠️ ブランドBot希望あり → 日本側ランブック（docs/SHOP_PROVISIONING_RUNBOOK_JP.md）で対応');
    lines.push('');
  }
  lines.push('【現地スタッフの残り手順（2ステップ）】');
  lines.push('1. お店の人とのTelegramグループを作り、予約Botを招待する');
  lines.push('2. そのグループで「/register ' + otc + '」と送る → Botが✅を返したら完了');

  var opts = { disable_web_page_preview: true };
  var threadId = cfg.adminPartnerThreadId || '';
  if (threadId) opts.message_thread_id = Number(threadId);
  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), opts);
}

// ====== ③ 月次レポート（透明性の核: 「今月◯台→◯$」を双方に同じ数字で） ======

/**
 * 前月分のコミッションを shop_id 別に集計し、
 *   - 各店舗グループ（連携済）へ英語レポート
 *   - 管理グループへ日本語サマリー
 * を送信する。毎月1日のトリガーで実行（支払いは毎月10日・ABA）。
 */
function sendShopMonthlyReports() {
  var tz = 'Asia/Phnom_Penh';
  var now = new Date();
  var firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  var lastMonthEnd = new Date(firstOfThisMonth.getTime() - 1);
  var ymLabel = Utilities.formatDate(lastMonthEnd, tz, 'yyyy-MM');

  // 連携済み店舗の一覧
  var linkSheet = ensureShopLinkSheet_();
  var linkRows = linkSheet.getDataRange().getValues();
  var headers = linkRows.shift();
  var idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });

  var linkedShops = linkRows.filter(function(r) {
    return String(r[idx['状態']]) === '連携済' && String(r[idx['グループchat_id']]) !== '';
  });
  if (!linkedShops.length) { Logger.log('ℹ️ 連携済み店舗なし。レポート送信スキップ'); return; }

  // コミッション台帳から前月分を shop_id 別に集計
  // 【精算フロー（2026-08-09 Daisuke 決定）】お客様は店に全額支払い → 店が30%を確保 →
  //   当社は70%を施工完了時にその場回収（現金 or ABA）。未回収分だけがレポートに残る。
  var agg = aggregateCommissionsByShop_(ymLabel);

  var props = getShopProvProps_();
  var adminLines = ['📊 提携店 月次レポート（' + ymLabel + '）送信結果', ''];

  linkedShops.forEach(function(r) {
    var shopId = String(r[idx['shop_id']]);
    var shopName = String(r[idx['店名']]);
    var groupChatId = String(r[idx['グループchat_id']]);
    var a = agg[shopId] || { count: 0, sales: 0, commission: 0, ourShare: 0, outstanding: 0 };

    // 店舗向け（英語。クメール語版は Panha 校閲後に差し替え可）
    var shopLines = [
      '📊 SAMURAI MOTORS — Monthly Report (' + ymLabel + ')',
      '',
      'Shop: ' + shopName,
      'Jobs: ' + a.count,
      'Total sales: ' + a.sales.toFixed(2) + '$',
      'Your commission (30%): ' + a.commission.toFixed(2) + '$',
      'Samurai Motors share (70%): ' + a.ourShare.toFixed(2) + '$'
    ];
    if (a.outstanding > 0) {
      shopLines.push('');
      shopLines.push('⏳ Not yet settled: ' + a.outstanding.toFixed(2) + '$');
      shopLines.push('Our staff will collect on the next visit (cash or ABA). Thank you!');
    } else if (a.count > 0) {
      shopLines.push('');
      shopLines.push('✅ All settled. Thank you for working with us!');
    } else {
      shopLines.push('');
      shopLines.push('No jobs last month. Let\'s make this month better together!');
    }

    var ok = sendViaBookingBot_(props.bookingBotToken, groupChatId, shopLines.join('\n'));
    adminLines.push((ok ? '✅ ' : '❌ ') + shopName + ': ' + a.count + '台 / 売上' + a.sales.toFixed(2) +
      '$ / 店取分' + a.commission.toFixed(2) + '$ / 未回収' + a.outstanding.toFixed(2) + '$');
  });

  // 管理グループへ日本語サマリー
  try {
    var cfg = getConfig();
    var opts = { disable_web_page_preview: true };
    if (cfg.adminPartnerThreadId) opts.message_thread_id = Number(cfg.adminPartnerThreadId);
    adminLines.push('');
    adminLines.push('💰 精算ルール: 客→店に全額支払い / 店が30%確保 / 当社70%は施工完了時にその場回収。');
    adminLines.push('未回収がある店は次回訪問時に回収（台帳の支払ステータスを更新すること）');
    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, adminLines.join('\n'), opts);
  } catch (err) {
    Logger.log('⚠️ 管理サマリー送信失敗: ' + err);
  }
}

/**
 * コミッション台帳から指定月（yyyy-MM）の shop_id 別集計を返す。
 * 未回収 = 集金者が「店」（客のお金が店にある）かつ 支払ステータス「未払い」の当社受取額。
 * @return {Object} { shopId: { count, sales, commission, ourShare, outstanding } }
 */
function aggregateCommissionsByShop_(ymLabel) {
  var cfg = getConfig();
  var ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  var sheet = ss.getSheetByName('コミッション台帳');
  var agg = {};
  if (!sheet || sheet.getLastRow() < 2) return agg;

  var values = sheet.getDataRange().getValues();
  var headers = values.shift();
  var col = {};
  headers.forEach(function(h, i) { col[h] = i; });

  values.forEach(function(row) {
    var d = row[col['施工日']];
    if (!d) return;
    var label = (d instanceof Date)
      ? Utilities.formatDate(d, 'Asia/Phnom_Penh', 'yyyy-MM')
      : String(d).slice(0, 7).replace('/', '-');
    if (label !== ymLabel) return;
    var shopId = String(row[col['shop_id']] || '');
    if (!shopId) return;
    if (!agg[shopId]) agg[shopId] = { count: 0, sales: 0, commission: 0, ourShare: 0, outstanding: 0 };
    var a = agg[shopId];
    a.count++;
    a.sales += Number(row[col['売上(USD)']] || 0);
    a.commission += Number(row[col['コミッション額(USD)']] || 0);
    var ourShare = Number(row[col['当社受取額(USD)']] || 0);
    a.ourShare += ourShare;
    var collector = String(row[col['集金者']] || '');
    var payStatus = String(row[col['支払ステータス']] || '');
    if (collector === '店' && payStatus === '未払い') {
      a.outstanding += ourShare;
    }
  });
  return agg;
}

/**
 * 予約Botトークンで直接送信（店舗グループには予約Botが入っているため）。
 * v7-operations の TelegramAPI は INTERNAL 用なので、ここだけ UrlFetch 直叩き。
 */
function sendViaBookingBot_(token, chatId, text) {
  if (!token) {
    Logger.log('⚠️ BOT_TOKEN_BOOKING 未登録（v7-operations側）。手順書②を実施してください');
    return false;
  }
  try {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: text }),
      muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText() || '{}');
    return !!body.ok;
  } catch (err) {
    Logger.log('⚠️ sendViaBookingBot_ 失敗: ' + err);
    return false;
  }
}

/**
 * 月次レポートのトリガーを設定（毎月1日 10時・冪等）
 */
function installShopMonthlyReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'sendShopMonthlyReports') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendShopMonthlyReports')
    .timeBased().onMonthDay(1).atHour(10).create();
  Logger.log('✅ 月次レポートトリガー設定完了（毎月1日 10時）');
}

// ====== ユーティリティ ======

function formatOpsDateTime_(d) {
  return Utilities.formatDate(d, 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
}
