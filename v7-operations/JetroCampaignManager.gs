/**
 * JetroCampaignManager.gs — JETRO 駐在員様 無料撥水ガラスコーティング キャンペーン
 *
 * 【責務】
 *   - 駐在員向け予約 Google Form の生成
 *   - フォーム送信時の処理:
 *     - 予約をシート記録(JETROキャンペーン予約 シート)
 *     - Admin グループへ Telegram 通知(業務 Bot 経由)
 *     - ロン君個人へ Telegram 通知(業務 Bot 経由)
 *     - 駐在員にメール送信(確認 + ドライバー転送用クメール語テンプレ)
 *
 * 【駐在員はBotを触らない】
 *   - Google Form のみで完結
 *   - フォーム送信後の確認とドライバー転送用テンプレはメールで届く
 *
 * 【シート】
 *   SHEET_NAMES.JETRO_BOOKINGS = 'JETROキャンペーン予約'
 *
 * 【1度だけ実行する関数】
 *   setupJetroCampaign() — Form 自動生成 + onFormSubmit トリガー設定
 *   出力: 回答用URL(レター掲載用ディープリンク) + 編集用URL
 *
 * 【手動テスト】
 *   debugSendJetroTestEmail()  — メール文面確認
 *   debugNotifyJetroTest()     — Admin/Ron 通知確認
 */

// ============================================================
//  定数
// ============================================================

const JETRO_FORM_TITLE = 'サムライモーターズ JETRO 駐在員様 無料撥水ガラスコーティング';
const JETRO_FORM_DESCRIPTION =
  'JETRO を通じてご案内した日系駐在員様限定の無料撥水ガラスコーティング キャンペーンです。\n' +
  'お忙しいところ恐れ入りますが、下記項目をご入力ください(2 分ほどで完了します)。\n\n' +
  '【施工内容】無料撥水ガラスコーティング(フロントガラス3面 + サイドミラー2枚 = 計5箇所)\n' +
  '【場所】サムライモーターズ事務所(プノンペン)\n' +
  '【対応】撥水コーティング技術者 Ron が対応いたします';

const JETRO_PLAN_LABEL = '無料撥水ガラスコーティング(フロント3面 + サイドミラー2枚 = 計5箇所)';
const JETRO_OFFICE_NAME = 'サムライモーターズ事務所';
const JETRO_OFFICE_MAP_URL = 'https://maps.app.goo.gl/U2ktnZMmbzJVhXep7';
const JETRO_RON_PHONE = '096 713 8456';
const JETRO_DEFAULT_SOURCE = 'jetro2026';

const JETRO_BOOKING_HEADERS_ = [
  '予約ID',
  '申込日時',
  '希望日時',
  '流入経路',
  '駐在員 Telegram',
  'ドライバー Telegram',
  'メールアドレス',
  'ステータス',
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
    sheet.setColumnWidth(3, 160);   // 希望日時
    sheet.setColumnWidth(7, 220);   // メールアドレス
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
  form.setCollectEmail(false);                 // フォームのメール欄で取るので、Google 認証経由は不要
  form.setLimitOneResponsePerUser(false);      // 認証なしで誰でも回答可
  form.setShowLinkToRespondAgain(false);
  form.setConfirmationMessage(
    'ご予約承りました。\n' +
    'ご登録いただいたメールアドレスに、確認メールとドライバー様への伝達文(クメール語)をお送りしました。\n' +
    'メールをご確認のうえ、ドライバー様にご転送ください。\n\n' +
    '当日はサムライモーターズ事務所にてお待ちしております。'
  );

  // ===== 設問 =====

  // Q1: 希望日時
  form.addDateTimeItem()
    .setTitle('ご希望日時')
    .setHelpText('ご希望の日付と時刻をお選びください。前日までにご連絡差し上げ、調整させていただく場合があります。')
    .setRequired(true);

  // Q2: 駐在員 Telegram
  form.addTextItem()
    .setTitle('お客様の Telegram')
    .setHelpText('@your_username またはリンク https://t.me/your_username の形式でご入力ください。Telegram のプロフィール画面で確認いただけます。')
    .setRequired(true);

  // Q3: ドライバー Telegram
  form.addTextItem()
    .setTitle('ドライバー様の Telegram')
    .setHelpText('ドライバー様の @username またはリンクをご入力ください。施工日のご案内をドライバー様にお伝えする際に使用させていただきます。')
    .setRequired(true);

  // Q4: メールアドレス(形式バリデーション)
  const emailValidation = FormApp.createTextValidation()
    .setHelpText('正しいメールアドレスの形式で入力してください')
    .requireTextIsEmail()
    .build();
  form.addTextItem()
    .setTitle('メールアドレス')
    .setHelpText('ご予約確認とドライバー様への伝達文を、こちらのアドレスにお送りいたします。')
    .setRequired(true)
    .setValidation(emailValidation);

  // Q5: プラン情報(固定表示・編集不可)
  form.addSectionHeaderItem()
    .setTitle('施工内容(固定)')
    .setHelpText(JETRO_PLAN_LABEL + '\n場所: ' + JETRO_OFFICE_NAME + '\nマップ: ' + JETRO_OFFICE_MAP_URL);

  // Q6: 流入経路(隠しフィールド・URL プレフィルで自動入力)
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

/**
 * DateTime レスポンス(Date オブジェクトまたは文字列)を 'yyyy-MM-dd HH:mm' に整形
 */
function formatJetroDateTime_(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, OPS_TZ, 'yyyy-MM-dd HH:mm');
  }
  return String(d).trim();
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

    // 設問順に取得(SectionHeader はレスポンスに含まれないので、有効レスポンスは 5 件)
    //   [0] 希望日時(DateTime)
    //   [1] 駐在員 Telegram
    //   [2] ドライバー Telegram
    //   [3] メールアドレス
    //   [4] 流入経路(URL プレフィル / 自動入力 / 手入力なら空)
    const desiredAtRaw = responses[0] ? responses[0].getResponse() : '';
    const desiredAt    = formatJetroDateTime_(desiredAtRaw);
    const expatTg      = String(responses[1] ? responses[1].getResponse() : '').trim();
    const driverTg     = String(responses[2] ? responses[2].getResponse() : '').trim();
    const email        = String(responses[3] ? responses[3].getResponse() : '').trim();
    const sourceValue  = responses[4] ? String(responses[4].getResponse() || '').trim() : '';
    const source       = sourceValue || '(direct)';

    const bookingId = generateDateSeqId('JET', SHEET_NAMES.JETRO_BOOKINGS, '予約ID');

    // ===== シート記録 =====
    appendRow(SHEET_NAMES.JETRO_BOOKINGS, {
      '予約ID':              bookingId,
      '申込日時':            submittedAt,
      '希望日時':            desiredAt,
      '流入経路':            source,
      '駐在員 Telegram':     expatTg,
      'ドライバー Telegram': driverTg,
      'メールアドレス':      email,
      'ステータス':          '未対応',
      '車両情報':            '',
      '施工: 窓フロント3面': '',
      '施工: ミラー':        '',
      'ロン君メモ':          ''
    });

    const data = {
      bookingId:   bookingId,
      submittedAt: submittedAt,
      desiredAt:   desiredAt,
      expatTg:     expatTg,
      driverTg:    driverTg,
      email:       email,
      source:      source
    };

    // ===== 通知配信(各々失敗しても他は止めない) =====
    try { notifyJetroAdminGroup_(data); } catch (err) { Logger.log('⚠️ JETRO admin 通知失敗: ' + err); }
    try { notifyJetroRon_(data); }       catch (err) { Logger.log('⚠️ JETRO ロン君通知失敗: ' + err); }
    try { sendJetroExpatEmail_(data); }  catch (err) { Logger.log('⚠️ JETRO メール送信失敗: ' + err); }

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
    '📅 希望日時: <b>' + escapeHtml_(data.desiredAt) + '</b>',
    '👤 駐在員: ' + escapeHtml_(data.expatTg),
    '🚖 ドライバー: ' + escapeHtml_(data.driverTg),
    '📧 ' + escapeHtml_(data.email),
    '🏷 流入: ' + escapeHtml_(data.source),
    '',
    '施工内容: ' + escapeHtml_(JETRO_PLAN_LABEL),
    '受け入れ場所: ' + JETRO_OFFICE_NAME
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
    '📅 ' + escapeHtml_(data.desiredAt),
    '🚖 ドライバー: ' + escapeHtml_(data.driverTg),
    '',
    '施工: ' + escapeHtml_(JETRO_PLAN_LABEL),
    '当日、事務所での受け入れ準備をお願いします。'
  ];

  sendMessage(BOT_TYPE.INTERNAL, chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  Logger.log('📤 JETRO ロン君通知送信: ' + data.bookingId);
}

// ============================================================
//  メール(駐在員向け)
// ============================================================

function sendJetroExpatEmail_(data) {
  const subject = '【サムライモーターズ】無料撥水ガラスコーティング ご予約承り('
    + data.bookingId + ')';

  const khmer = buildKhmerDriverTemplate_(data);

  const body = [
    'この度はサムライモーターズの無料撥水ガラスコーティング キャンペーンにお申し込みいただき、',
    '誠にありがとうございます。',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '■ ご予約内容',
    '━━━━━━━━━━━━━━━━━━',
    '予約ID: ' + data.bookingId,
    'ご希望日時: ' + data.desiredAt,
    '場所: ' + JETRO_OFFICE_NAME,
    'マップ: ' + JETRO_OFFICE_MAP_URL,
    '施工内容: ' + JETRO_PLAN_LABEL,
    '担当: 撥水コーティング技術者 Ron(連絡先: ' + JETRO_RON_PHONE + ')',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '■ ドライバー様への伝達(以下をそのまま転送してください)',
    '━━━━━━━━━━━━━━━━━━',
    'お手数ですが、下記の文面を Telegram または WhatsApp などでドライバー様にお送りください。',
    'クメール語の文面は、ドライバー様向けの内容になっております。',
    '',
    '----- ここから(コピーしてドライバー様に送信) -----',
    khmer.body,
    '----- ここまで -----',
    '',
    '【参考: 上記文面の日本語訳】',
    khmer.japaneseRef,
    '',
    '━━━━━━━━━━━━━━━━━━',
    '■ 当日の流れ',
    '━━━━━━━━━━━━━━━━━━',
    '1. ドライバー様にご希望日時 ' + data.desiredAt + ' にサムライモーターズ事務所までお越しいただきます。',
    '2. 到着後、Ron が施工(フロント3面 + サイドミラー2枚)を行います。',
    '3. 所要時間の目安は約 30〜45 分です。',
    '4. ご不明点ございましたら、Ron(' + JETRO_RON_PHONE + ')までお問い合わせください。',
    '',
    'お会いできるのを楽しみにしております。',
    '',
    'サムライモーターズ',
    'サービスのご案内: ' + JETRO_OFFICE_MAP_URL
  ].join('\n');

  GmailApp.sendEmail(data.email, subject, body, {
    name: 'サムライモーターズ'
  });
  Logger.log('📧 JETRO 駐在員メール送信: ' + data.email + ' / ' + data.bookingId);
}

// ============================================================
//  クメール語テンプレ(ドライバー向け)
//  ※ ロン君のレビュー必須(現地ニュアンス・敬語の確認)
// ============================================================

function buildKhmerDriverTemplate_(data) {
  // クメール語素案(ロン君レビュー前)
  // 内容: 1) マップ、2) 時間、3) ロン君連絡先 — 場所テキストは省略
  const body = [
    'សួស្តី!',
    '',
    'ម្ចាស់រថយន្តរបស់អ្នកបានកក់សេវាបាញ់ទឹកលើកញ្ចក់ដោយឥតគិតថ្លៃនៅ Samurai Motors។',
    'សូមបើករថយន្តទៅទីតាំងនេះតាមពេលវេលាខាងក្រោម។',
    '',
    '🕒 ' + data.desiredAt,
    '📍 ' + JETRO_OFFICE_MAP_URL,
    '📞 ' + JETRO_RON_PHONE + ' (Ron)',
    '',
    'នៅពេលមកដល់ សូមទាក់ទងលោក Ron តាមលេខទូរស័ព្ទខាងលើ។',
    'សេវានេះឥតគិតថ្លៃ។ រយៈពេលប្រហែល ៣០-៤៥ នាទី។',
    '',
    'អរគុណច្រើន!'
  ].join('\n');

  // 駐在員が中身を確認できるように日本語参照
  const japaneseRef = [
    'こんにちは!',
    '',
    'お雇い主様が Samurai Motors にて無料の撥水ガラスコーティングをご予約されました。',
    '下記の場所・時刻にお車をお持ちください。',
    '',
    '🕒 ' + data.desiredAt,
    '📍 サムライモーターズ事務所(マップは上記リンク)',
    '📞 ' + JETRO_RON_PHONE + '(担当: Ron)',
    '',
    '到着されましたら、上記の電話番号で Ron までご連絡ください。',
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
 * テスト用ダミーデータでメール送信を試す
 * 実行前に下記の TEST_EMAIL を自分のメアドに書き換えてから実行
 */
function debugSendJetroTestEmail() {
  const TEST_EMAIL = Session.getActiveUser().getEmail();  // 実行者のメアド宛
  const data = {
    bookingId:   'JET-TEST-001',
    submittedAt: new Date(),
    desiredAt:   '2026-05-01 14:00',
    expatTg:     '@test_expat',
    driverTg:    '@test_driver',
    email:       TEST_EMAIL,
    source:      JETRO_DEFAULT_SOURCE
  };
  sendJetroExpatEmail_(data);
  Logger.log('テストメール送信先: ' + TEST_EMAIL);
}

/**
 * テスト用ダミーデータで Admin/ロン君通知を試す
 */
function debugNotifyJetroTest() {
  const data = {
    bookingId:   'JET-TEST-001',
    submittedAt: new Date(),
    desiredAt:   '2026-05-01 14:00',
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
