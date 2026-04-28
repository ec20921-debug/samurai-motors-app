/**
 * JetroCampaignManager.gs — JETRO 駐在員様 無料撥水ガラスコーティング キャンペーン
 *
 * 【責務】
 *   - 駐在員向け予約 Google Form の生成
 *   - フォーム送信時の処理:
 *     - 予約をシート記録(JETROキャンペーン予約 シート)
 *     - Admin グループへ Telegram 通知(業務 Bot 経由)
 *     - ロン君個人へ Telegram 通知(業務 Bot 経由)
 *
 * 【駐在員はBotを触らない・メールも送らない】
 *   - Google Form のみで完結
 *   - 送信後の「送信完了メッセージ」にクメール語ドライバー転送テンプレを静的に表示
 *   - 駐在員はその文面をコピーしてドライバーに転送する
 *
 * 【シート】
 *   SHEET_NAMES.JETRO_BOOKINGS = 'JETROキャンペーン予約'
 *
 * 【1度だけ実行する関数】
 *   setupJetroCampaign() — Form 自動生成 + onFormSubmit トリガー設定
 *   出力: 回答用URL(レター掲載用ディープリンク) + 編集用URL
 *
 * 【手動テスト】
 *   debugNotifyJetroTest()     — Admin/Ron 通知確認
 */

// ============================================================
//  定数
// ============================================================

const JETRO_FORM_TITLE = 'サムライモーターズ JETRO 駐在員様 無料撥水ガラスコーティング';
const JETRO_FORM_DESCRIPTION =
  'JETRO を通じてご案内した日系駐在員様限定の無料撥水ガラスコーティング キャンペーンです。\n' +
  'お忙しいところ恐れ入りますが、下記項目をご入力ください(1 分ほどで完了します)。\n\n' +
  '【施工内容】無料撥水ガラスコーティング(フロントガラス3面 + サイドミラー2枚 = 計5箇所)\n' +
  '【場所】サムライモーターズ事務所(プノンペン)\n' +
  '【対応】撥水コーティング技術者 Ron が対応いたします\n\n' +
  '※ 具体的な時刻は、ご予約後にドライバー様と Ron が Telegram にて直接調整いたします。';

const JETRO_PLAN_LABEL = '無料撥水ガラスコーティング(フロント3面 + サイドミラー2枚 = 計5箇所)';
const JETRO_OFFICE_NAME = 'サムライモーターズ事務所';
const JETRO_OFFICE_MAP_URL = 'https://maps.app.goo.gl/U2ktnZMmbzJVhXep7';
const JETRO_RON_PHONE = '096 713 8456';
const JETRO_DEFAULT_SOURCE = 'jetro2026';

const JETRO_BOOKING_HEADERS_ = [
  '予約ID',
  '申込日時',
  '希望日',
  '流入経路',
  '駐在員 Telegram',
  'ドライバー Telegram',
  'ステータス',
  '確定時刻',
  '車両情報',
  '施工: 窓フロント3面',
  '施工: ミラー',
  'ロン君メモ'
];

// ============================================================
//  シート準備
// ============================================================

/**
 * JETROキャンペーン予約シートが無ければ作成する
 */
function ensureJetroBookingSheet() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  let sheet = ss.getSheetByName(SHEET_NAMES.JETRO_BOOKINGS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.JETRO_BOOKINGS);
    sheet.getRange(1, 1, 1, JETRO_BOOKING_HEADERS_.length).setValues([JETRO_BOOKING_HEADERS_]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, JETRO_BOOKING_HEADERS_.length)
      .setFontWeight('bold')
      .setBackground('#1f3a1f')
      .setFontColor('#e8f0e8');
    sheet.setColumnWidth(1, 160);   // 予約ID
    sheet.setColumnWidth(2, 160);   // 申込日時
    sheet.setColumnWidth(3, 130);   // 希望日
    sheet.setColumnWidth(8, 130);   // 確定時刻
    sheet.setColumnWidth(9, 200);   // 車両情報
    sheet.setColumnWidth(12, 240);  // メモ
    Logger.log('✅ JETROキャンペーン予約シート 作成');
  } else {
    const lastCol = sheet.getLastColumn() || 1;
    const existing = sheet.getRange(1, 1, 1, Math.max(lastCol, JETRO_BOOKING_HEADERS_.length)).getValues()[0];
    let needs = false;
    JETRO_BOOKING_HEADERS_.forEach(function(h, i) { if (existing[i] !== h) needs = true; });
    if (needs) {
      sheet.getRange(1, 1, 1, JETRO_BOOKING_HEADERS_.length).setValues([JETRO_BOOKING_HEADERS_]);
      Logger.log('♻️ JETROキャンペーン予約シート ヘッダー整備');
    } else {
      Logger.log('ℹ️ JETROキャンペーン予約シート 変更なし');
    }
  }
}

// ============================================================
//  キャンペーン初期セットアップ(1 度だけ実行)
// ============================================================

/**
 * Google Form を自動生成し、onFormSubmit トリガーを設定する
 * 完了後、ログに以下を出力:
 *   - フォーム回答用URL(レター掲載用)
 *   - フォーム編集用URL
 *   - プレフィル付きURL(jetro2026 タグ自動付与)
 *
 * @return {{publishedUrl:string, editUrl:string, prefilledUrl:string}}
 */
function setupJetroCampaign() {
  ensureJetroBookingSheet();

  const form = FormApp.create(JETRO_FORM_TITLE);
  form.setDescription(JETRO_FORM_DESCRIPTION);
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false);      // 認証なしで誰でも回答可
  form.setShowLinkToRespondAgain(false);

  // ===== 送信完了メッセージ =====
  // ドライバー転送用クメール語テンプレと案内をここに静的に表示する。
  // 駐在員は本文をコピーして、自身でドライバーに Telegram/WhatsApp 転送する。
  // ドライバーは Ron に Telegram で直接連絡し、具体的な時刻を調整する。
  const khmer = buildStaticKhmerDriverTemplate_();
  form.setConfirmationMessage(
    'ご予約承りました。\n' +
    'ご指定の日に、ドライバー様と Ron が Telegram にて時刻を直接調整いたします。\n' +
    '\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    'ドライバー様への伝達(以下をそのままご転送ください)\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    '※ 📅 の「ご予約日」の部分は、ご予約された日付にご記入のうえ転送してください。\n' +
    '\n' +
    khmer.body + '\n' +
    '\n' +
    '【参考: 日本語訳】\n' +
    khmer.japaneseRef + '\n' +
    '\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    'Ron への連絡先(Telegram): ' + JETRO_RON_PHONE + '\n' +
    'マップ: ' + JETRO_OFFICE_MAP_URL
  );

  // ===== 設問 =====

  // Q1: 希望日
  form.addDateItem()
    .setTitle('ご希望日')
    .setHelpText('施工をご希望の日付をお選びください。具体的な時刻は、ご予約後にドライバー様と Ron が Telegram で直接調整いたします。')
    .setRequired(true);

  // Q2: 駐在員 Telegram
  form.addTextItem()
    .setTitle('お客様の Telegram')
    .setHelpText('@your_username またはリンク https://t.me/your_username の形式でご入力ください。Telegram のプロフィール画面で確認いただけます。')
    .setRequired(true);

  // Q3: ドライバー Telegram
  form.addTextItem()
    .setTitle('ドライバー様の Telegram')
    .setHelpText('ドライバー様の @username またはリンクをご入力ください。')
    .setRequired(true);

  // Q4: プラン情報(固定表示・編集不可)
  form.addSectionHeaderItem()
    .setTitle('施工内容(固定)')
    .setHelpText(JETRO_PLAN_LABEL + '\n場所: ' + JETRO_OFFICE_NAME + '\nマップ: ' + JETRO_OFFICE_MAP_URL);

  // Q5: 流入経路(隠しフィールド・URL プレフィルで自動入力)
  const sourceItem = form.addTextItem()
    .setTitle('流入経路(自動入力)')
    .setHelpText('このフィールドは自動入力されます。変更不要です。')
    .setRequired(false);

  // ===== Form ID と Entry ID を Script Properties に保存 =====
  const formId = form.getId();
  const publishedUrl = form.getPublishedUrl();
  const editUrl = form.getEditUrl();
  const sourceEntryId = sourceItem.getId();   // entry ID(プレフィル URL 用)

  PropertiesService.getScriptProperties().setProperties({
    [CONFIG_KEYS.JETRO_FORM_ID]:           formId,
    [CONFIG_KEYS.JETRO_FORM_URL]:          publishedUrl,
    [CONFIG_KEYS.JETRO_FORM_SOURCE_ENTRY]: String(sourceEntryId)
  });

  // ===== onFormSubmit トリガー =====
  // 既存の同名トリガーは削除してから作成(冪等)
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handleJetroFormSubmit') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('handleJetroFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();

  // ===== プレフィル URL 生成 =====
  const prefilledUrl = buildJetroPrefilledUrl_(publishedUrl, sourceEntryId, JETRO_DEFAULT_SOURCE);

  Logger.log('================================');
  Logger.log('JETRO キャンペーン セットアップ完了');
  Logger.log('================================');
  Logger.log('【フォーム回答用URL(プレーン)】');
  Logger.log(publishedUrl);
  Logger.log('');
  Logger.log('【プレフィル付きURL(レター掲載用)】');
  Logger.log(prefilledUrl);
  Logger.log('  → このURLからの申込は流入経路 = ' + JETRO_DEFAULT_SOURCE + ' として自動記録');
  Logger.log('');
  Logger.log('【編集用URL(設問の微修正用)】');
  Logger.log(editUrl);
  Logger.log('================================');

  return { publishedUrl: publishedUrl, editUrl: editUrl, prefilledUrl: prefilledUrl };
}

/**
 * プレフィル URL を生成
 *  例: https://docs.google.com/forms/d/e/{form}/viewform?usp=pp_url&entry.{id}=jetro2026
 */
function buildJetroPrefilledUrl_(publishedUrl, entryId, sourceValue) {
  const sep = publishedUrl.indexOf('?') >= 0 ? '&' : '?';
  return publishedUrl + sep + 'usp=pp_url&entry.' + entryId + '=' + encodeURIComponent(sourceValue);
}

// ============================================================
//  フォーム送信ハンドラ(トリガー)
// ============================================================

/**
 * Google Form 送信時に呼ばれる
 * 1. 予約IDを採番してシート記録
 * 2. Admin グループに通知(業務Bot)
 * 3. ロン君に個別通知(業務Bot)
 * 4. 駐在員にメール送信(確認 + ドライバー転送用クメール語テンプレ)
 */
function handleJetroFormSubmit(e) {
  try {
    const responses = e.response.getItemResponses();
    const submittedAt = e.response.getTimestamp();

    // 設問順に取得(SectionHeader はレスポンスに含まれないので、有効レスポンスは 4 件)
    //   [0] 希望日(Date)
    //   [1] 駐在員 Telegram
    //   [2] ドライバー Telegram
    //   [3] 流入経路(URL プレフィル / 自動入力 / 手入力なら空)
    // DateItem.getResponse() は 'yyyy-MM-dd' 形式の文字列を返す
    const desiredDate  = String(responses[0] ? responses[0].getResponse() : '').trim();
    const expatTg      = String(responses[1] ? responses[1].getResponse() : '').trim();
    const driverTg     = String(responses[2] ? responses[2].getResponse() : '').trim();
    const sourceValue  = responses[3] ? String(responses[3].getResponse() || '').trim() : '';
    const source       = sourceValue || '(direct)';

    const bookingId = generateDateSeqId('JET', SHEET_NAMES.JETRO_BOOKINGS, '予約ID');

    // ===== シート記録 =====
    appendRow(SHEET_NAMES.JETRO_BOOKINGS, {
      '予約ID':              bookingId,
      '申込日時':            submittedAt,
      '希望日':              desiredDate,
      '流入経路':            source,
      '駐在員 Telegram':     expatTg,
      'ドライバー Telegram': driverTg,
      'ステータス':          '未対応',
      '確定時刻':            '',
      '車両情報':            '',
      '施工: 窓フロント3面': '',
      '施工: ミラー':        '',
      'ロン君メモ':          ''
    });

    const data = {
      bookingId:   bookingId,
      submittedAt: submittedAt,
      desiredDate: desiredDate,
      expatTg:     expatTg,
      driverTg:    driverTg,
      source:      source
    };

    // ===== Telegram 通知配信(失敗しても他は止めない) =====
    try { notifyJetroAdminGroup_(data); } catch (err) { Logger.log('⚠️ JETRO admin 通知失敗: ' + err); }
    try { notifyJetroRon_(data); }       catch (err) { Logger.log('⚠️ JETRO ロン君通知失敗: ' + err); }

  } catch (err) {
    Logger.log('❌ handleJetroFormSubmit: ' + err + ' stack=' + (err.stack || ''));
  }
}

// ============================================================
//  通知(Admin グループ)
// ============================================================

function notifyJetroAdminGroup_(data) {
  const cfg = getConfig();
  const thread = cfg.adminJetroThreadId
              || cfg.adminWaterRepellentThreadId
              || cfg.adminDailyReportThreadId;
  if (!thread) {
    Logger.log('⚠️ JETRO 通知先トピック未設定、admin 通知スキップ');
    return;
  }

  const lines = [
    '🌟 <b>JETRO 駐在員予約</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(data.bookingId),
    '📅 希望日: <b>' + escapeHtml_(data.desiredDate) + '</b>',
    '👤 駐在員: ' + escapeHtml_(data.expatTg),
    '🚖 ドライバー: ' + escapeHtml_(data.driverTg),
    '🏷 流入: ' + escapeHtml_(data.source),
    '',
    '施工内容: ' + escapeHtml_(JETRO_PLAN_LABEL),
    '受け入れ場所: ' + JETRO_OFFICE_NAME,
    '',
    '※ 具体的な時刻は、ロン君がドライバーと Telegram で直接調整します'
  ];

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), {
    parse_mode: 'HTML',
    message_thread_id: Number(thread),
    disable_web_page_preview: true
  });
  Logger.log('📤 JETRO admin 通知送信: ' + data.bookingId);
}

// ============================================================
//  通知(ロン君個別)
// ============================================================

function notifyJetroRon_(data) {
  const cfg = getConfig();
  let chatId = cfg.ronChatId;
  if (!chatId) {
    // スタッフマスターから "ロン" さんを解決(role=field を優先)
    try {
      const allStaff = (typeof getActiveStaff === 'function') ? getActiveStaff() : [];
      const ron = allStaff.find(function(s) {
        return s && s.nameJp && s.nameJp.indexOf('ロン') >= 0;
      });
      if (ron && ron.chatId) chatId = ron.chatId;
    } catch (err) {
      Logger.log('⚠️ スタッフマスターから ロン君 解決失敗: ' + err);
    }
  }
  if (!chatId) {
    Logger.log('⚠️ ロン君 chatId 未解決、個別通知スキップ');
    return;
  }

  const lines = [
    '🛻 <b>JETRO 予約が入りました</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(data.bookingId),
    '📅 希望日: ' + escapeHtml_(data.desiredDate),
    '🚖 ドライバー: ' + escapeHtml_(data.driverTg),
    '',
    '施工: ' + escapeHtml_(JETRO_PLAN_LABEL),
    '',
    'ドライバーさんから Telegram に直接ご連絡が来ます。',
    '当日の時刻を調整して、シートの「確定時刻」欄に記入してください。'
  ];

  sendMessage(BOT_TYPE.INTERNAL, chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  Logger.log('📤 JETRO ロン君通知送信: ' + data.bookingId);
}

// ============================================================
//  クメール語テンプレ(ドライバー向け、フォーム送信完了画面に静的表示)
//  ※ ロン君のレビュー必須(現地ニュアンス・敬語の確認)
// ============================================================

/**
 * フォーム送信完了画面に表示する、駐在員→ドライバー転送用テンプレ。
 * ドライバーが Ron に Telegram で直接連絡して時刻を調整する流れ。
 * 予約日はプレースホルダー(駐在員が転送時に置換)。
 */
function buildStaticKhmerDriverTemplate_() {
  const body = [
    'សួស្តី!',
    '',
    'ម្ចាស់រថយន្តរបស់អ្នកបានកក់សេវាបាញ់ទឹកលើកញ្ចក់ដោយឥតគិតថ្លៃនៅ Samurai Motors។',
    '',
    '📅 ថ្ងៃកក់: [予約日をここに記入してください]',
    '📍 ទីតាំង: ' + JETRO_OFFICE_MAP_URL,
    '📞 Ron (Telegram): ' + JETRO_RON_PHONE,
    '',
    'សូមផ្ញើសារទៅលោក Ron តាម Telegram ដោយផ្ទាល់ ដើម្បីព្រមព្រៀងពីពេលវេលាជាក់លាក់។',
    'ពេលផ្ញើសារ សូមប្រាប់ថ្ងៃកក់ និងឈ្មោះម្ចាស់រថយន្ត។',
    '',
    'សេវានេះឥតគិតថ្លៃ។ រយៈពេលប្រហែល ៣០-៤៥ នាទី។',
    '',
    'អរគុណច្រើន!'
  ].join('\n');

  const japaneseRef = [
    'こんにちは!',
    '',
    'お雇い主様が Samurai Motors にて無料の撥水ガラスコーティングをご予約されました。',
    '',
    '📅 ご予約日: [予約日]',
    '📍 場所: サムライモーターズ事務所(マップは上記リンク)',
    '📞 Ron(Telegram): ' + JETRO_RON_PHONE,
    '',
    'Ron まで Telegram で直接ご連絡のうえ、具体的な時刻をご相談ください。',
    'ご連絡の際は、ご予約日とお雇い主様のお名前をお伝えください。',
    '',
    '本サービスは無料です。所要時間は約 30〜45 分です。',
    '',
    'よろしくお願いいたします。'
  ].join('\n');

  return { body: body, japaneseRef: japaneseRef };
}

// ============================================================
//  デバッグ(手動実行)
// ============================================================

/**
 * テスト用ダミーデータで Admin/ロン君通知を試す
 */
function debugNotifyJetroTest() {
  const data = {
    bookingId:   'JET-TEST-001',
    submittedAt: new Date(),
    desiredDate: '2026-05-01',
    expatTg:     '@test_expat',
    driverTg:    '@test_driver',
    email:       'test@example.com',
    source:      JETRO_DEFAULT_SOURCE
  };
  notifyJetroAdminGroup_(data);
  notifyJetroRon_(data);
}

/**
 * 既に作成済みフォームの URL を表示(setupJetroCampaign 後の確認用)
 */
function debugShowJetroFormUrls() {
  const cfg = getConfig();
  if (!cfg.jetroFormId) {
    Logger.log('⚠️ JETRO_FORM_ID 未登録。先に setupJetroCampaign を実行してください。');
    return;
  }
  const form = FormApp.openById(cfg.jetroFormId);
  const publishedUrl = form.getPublishedUrl();
  const editUrl = form.getEditUrl();
  const prefilledUrl = cfg.jetroFormSourceEntry
    ? buildJetroPrefilledUrl_(publishedUrl, cfg.jetroFormSourceEntry, JETRO_DEFAULT_SOURCE)
    : '(JETRO_FORM_SOURCE_ENTRY 未登録、setupJetroCampaign を再実行してください)';

  Logger.log('================================');
  Logger.log('JETRO フォーム URL');
  Logger.log('================================');
  Logger.log('回答用: ' + publishedUrl);
  Logger.log('プレフィル付き(レター用): ' + prefilledUrl);
  Logger.log('編集用: ' + editUrl);
  Logger.log('================================');
}
