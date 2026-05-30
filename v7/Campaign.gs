/**
 * Campaign.gs — 顧客向けキャンペーン一斉送信
 *
 * 【責務】
 *   スプレッドシートのメニューから、登録済みの全顧客（または言語別）に
 *   予約Bot経由でテキストメッセージを一斉送信する。
 *
 * 【使い方】
 *   1. `setupCampaign()` を1回だけ実行
 *      → 「キャンペーン下書き」「キャンペーン配信履歴」シート生成
 *      → onOpen トリガー登録
 *   2. スプレッドシートを開き直す
 *   3. 「キャンペーン下書き」シートに本文を記入
 *   4. メニュー「📢 キャンペーン」→「① プレビュー」で送信先と本文を確認
 *   5. 「② 送信実行」で配信開始（最終確認ダイアログあり）
 *   6. 結果は「キャンペーン配信履歴」シートに自動記録
 *
 * 【設計方針】
 *   - 顧客接点は予約Bot1本に統一（BOT_TYPE.BOOKING を使う）
 *   - 顧客「言語」列に応じてクメール語/英語を出し分け
 *   - 50ms 間隔 = 20msg/秒 で送信（Telegram レート制限 30msg/秒 の安全圏）
 *   - 429（Too Many Requests）は retry_after に従って1回リトライ
 *   - 403（bot blocked）は履歴に「blocked」と記録して継続
 *   - 6分実行制限に備え、CAMPAIGN_MAX_RECIPIENTS で上限ガード
 *   - ボイス／音声添付は本ファイルでは未実装（後日 sendVoice ラッパーを追加予定）
 */

// === シート名 ===
const CAMPAIGN_DRAFT_SHEET = 'キャンペーン下書き';
const CAMPAIGN_LOG_SHEET   = 'キャンペーン配信履歴';

// === 設定 ===
const CAMPAIGN_SEND_INTERVAL_MS = 50;   // 送信間ウェイト（20msg/秒）
const CAMPAIGN_MAX_RECIPIENTS   = 2000; // 1回の上限（6分制限の安全マージン）

// === 「送信対象」セル（B4）の選択肢 ===
const CAMPAIGN_AUDIENCE_OPTIONS = ['全員', 'クメール語のみ', '英語のみ'];

// =====================================================
//  セットアップ
// =====================================================

/**
 * キャンペーン機能の初期セットアップ（1回だけ実行）
 *   - 下書き／履歴シートを作成（既存なら維持）
 *   - onOpen トリガーを登録
 */
function setupCampaign() {
  ensureCampaignDraftSheet_();
  ensureCampaignLogSheet_();
  setupCampaignMenu_();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ キャンペーン機能 セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('  - 「' + CAMPAIGN_DRAFT_SHEET + '」シート 準備OK');
  Logger.log('  - 「' + CAMPAIGN_LOG_SHEET + '」シート 準備OK');
  Logger.log('  - onOpen メニュー登録済み → シートを開き直してください');
}

function setupCampaignMenu_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'campaignOnOpen_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('campaignOnOpen_')
    .forSpreadsheet(ss).onOpen().create();
  try { campaignOnOpen_(); } catch (e) { Logger.log('⚠️ onOpen 即時実行: ' + e); }
}

function campaignOnOpen_() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📢 キャンペーン')
    .addItem('① プレビュー（送信先と本文を確認）', 'previewCampaign')
    .addItem('② 送信実行', 'sendCampaign')
    .addSeparator()
    .addItem('📋 配信履歴シートを開く', 'openCampaignLogSheet')
    .addItem('🔧 シート再生成（壊した時の復旧）', 'setupCampaign')
    .addToUi();
}

// =====================================================
//  下書きシート構築
// =====================================================

function ensureCampaignDraftSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (sh) return sh; // 既存なら内容を壊さない

  sh = ss.insertSheet(CAMPAIGN_DRAFT_SHEET);

  // タイトル
  sh.getRange('A1:B1').merge()
    .setValue('📢 キャンペーン下書き')
    .setBackground('#1a1a1a').setFontColor('#c9a84c')
    .setFontSize(16).setFontWeight('bold')
    .setHorizontalAlignment('center');
  sh.setRowHeight(1, 36);

  sh.getRange('A2:B2').merge()
    .setValue('本文を編集 →  メニュー「📢 キャンペーン」→「① プレビュー」→「② 送信実行」')
    .setFontColor('#666').setFontSize(10)
    .setHorizontalAlignment('center');

  // 送信対象
  sh.getRange('A4').setValue('送信対象').setFontWeight('bold').setBackground('#f0e8d0');
  const audience = sh.getRange('B4');
  audience.setValue('全員');
  audience.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(CAMPAIGN_AUDIENCE_OPTIONS, true)
      .setAllowInvalid(false).build()
  );

  // 本文（クメール語）
  sh.getRange('A6').setValue('本文（クメール語）').setFontWeight('bold').setBackground('#f0e8d0').setVerticalAlignment('top');
  const km = sh.getRange('B6');
  km.setValue(
    '🎉 ការផ្តល់ជូនពិសេសថ្ងៃនេះ!\n\n' +
    'អ្នកដែលបានចុះឈ្មោះតាម Telegram ទាំងអស់\n' +
    '👉 ទទួលបាន Samurai Glass ឥតគិតថ្លៃ!\n' +
    '(តែ ៣ នាក់ដំបូងប៉ុណ្ណោះ ថ្ងៃនេះ)\n\n' +
    '📞 ផ្ញើ សារ ឬ សារសំឡេង មកកាន់យើងបាន!\n' +
    'បុគ្គលិកខ្មែររបស់យើងនឹងទាក់ទងទៅអ្នកវិញ 🚗✨'
  ).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  sh.setRowHeight(6, 160);

  // 本文（英語）
  sh.getRange('A7').setValue('本文（英語）任意').setFontWeight('bold').setBackground('#f0e8d0').setVerticalAlignment('top');
  const en = sh.getRange('B7');
  en.setValue(
    '🎉 SPECIAL CAMPAIGN TODAY!\n\n' +
    'All customers registered via Telegram:\n' +
    '👉 Get a FREE Samurai Glass treatment!\n' +
    '(First 3 only, today)\n\n' +
    '📞 Send us a text OR voice message — anything works!\n' +
    'Our Cambodian staff will get back to you 🚗✨'
  ).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  sh.setRowHeight(7, 160);

  // 注釈
  sh.getRange('A8:B8').merge()
    .setValue('💡 顧客の「言語」列に応じて自動振り分け。英語版が空ならクメール語版を全員に送信します。')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic')
    .setHorizontalAlignment('center');
  sh.setRowHeight(8, 24);

  // 最終結果
  sh.getRange('A10:B10').merge()
    .setValue('━━━ 最終配信結果（自動更新） ━━━')
    .setBackground('#1a1a1a').setFontColor('#c9a84c')
    .setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('A11').setValue('送信日時');
  sh.getRange('A12').setValue('成功 / 失敗 / ブロック');
  sh.getRange('A13').setValue('キャンペーンID');
  ['A11', 'A12', 'A13'].forEach(function(a) {
    sh.getRange(a).setFontWeight('bold').setBackground('#f8f4e8');
  });

  // 列幅・凍結
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 600);
  sh.setFrozenRows(2);

  return sh;
}

function ensureCampaignLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (sh) return sh;

  sh = ss.insertSheet(CAMPAIGN_LOG_SHEET);
  const headers = [
    'キャンペーンID', '送信日時', '顧客ID', 'チャットID', '氏名',
    '言語', '結果', 'エラー詳細', '本文プレビュー'
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  const widths = [180, 160, 100, 130, 140, 90, 80, 220, 400];
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });

  return sh;
}

function openCampaignLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (!sh) {
    SpreadsheetApp.getUi().alert('履歴シートが存在しません。「🔧 シート再生成」を実行してください。');
    return;
  }
  ss.setActiveSheet(sh);
}

// =====================================================
//  プレビュー
// =====================================================

function previewCampaign() {
  const ui = SpreadsheetApp.getUi();
  try {
    const draft = readCampaignDraft_();
    const recipients = buildRecipientList_(draft.audience);
    const total = recipients.length;
    const enCount = recipients.filter(function(r) { return r.language === '英語'; }).length;
    const kmCount = total - enCount;

    if (total === 0) {
      ui.alert('⚠️ 送信先が0名です',
        '「' + draft.audience + '」に該当する顧客がいません。', ui.ButtonSet.OK);
      return;
    }
    if (!draft.textKm && !draft.textEn) {
      ui.alert('⚠️ 本文が空です',
        'クメール語または英語のいずれかに本文を入力してください。', ui.ButtonSet.OK);
      return;
    }

    const previewKm = draft.textKm ? draft.textKm.substring(0, 300) : '(空 → 英語版を流用)';
    const previewEn = draft.textEn ? draft.textEn.substring(0, 300) : '(空 → クメール語版を流用)';

    const msg =
      '🎯 送信先\n' +
      '  合計: ' + total + '名\n' +
      '  クメール語向け: ' + kmCount + '名\n' +
      '  英語向け: ' + enCount + '名\n' +
      '\n' +
      '📝 本文（クメール語）\n' +
      '────────────────\n' +
      previewKm + '\n' +
      '\n' +
      '📝 本文（英語）\n' +
      '────────────────\n' +
      previewEn + '\n' +
      '\n' +
      '※ これはプレビューです。送信は「② 送信実行」から。';

    ui.alert('📢 キャンペーン プレビュー', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('❌ プレビュー失敗', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

// =====================================================
//  送信実行
// =====================================================

function sendCampaign() {
  const ui = SpreadsheetApp.getUi();

  let draft, recipients;
  try {
    draft = readCampaignDraft_();
    recipients = buildRecipientList_(draft.audience);
  } catch (err) {
    ui.alert('❌ 設定読込失敗', String(err && err.message || err), ui.ButtonSet.OK);
    return;
  }

  if (recipients.length === 0) {
    ui.alert('⚠️ 送信先が0名です',
      '「' + draft.audience + '」に該当する顧客がいません。', ui.ButtonSet.OK);
    return;
  }
  if (!draft.textKm && !draft.textEn) {
    ui.alert('⚠️ 本文が空です', '本文を入力してください。', ui.ButtonSet.OK);
    return;
  }
  if (recipients.length > CAMPAIGN_MAX_RECIPIENTS) {
    ui.alert('⚠️ 送信先が多すぎます',
      '送信先 ' + recipients.length + '名 が上限 ' + CAMPAIGN_MAX_RECIPIENTS + ' を超えています。',
      ui.ButtonSet.OK);
    return;
  }

  // 最終確認
  const confirm = ui.alert(
    '⚠️ 最終確認：本当に送信しますか？',
    recipients.length + ' 名 に メッセージを送信します。\n' +
    'この操作は取り消せません。よろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert('🚫 キャンセルしました');
    return;
  }

  // 配信実行
  const result = executeBroadcast_(draft, recipients);

  // 下書きシートに最終結果を書き戻す
  writeCampaignSummary_(result);

  ui.alert('📢 配信完了',
    '✅ 成功: ' + result.success + ' 件\n' +
    '❌ 失敗: ' + result.failed + ' 件\n' +
    '🚫 ブロック済み: ' + result.blocked + ' 件\n' +
    '\n' +
    'キャンペーンID: ' + result.campaignId + '\n' +
    '詳細は「' + CAMPAIGN_LOG_SHEET + '」シートをご確認ください。',
    ui.ButtonSet.OK
  );
}

// =====================================================
//  内部処理
// =====================================================

function readCampaignDraft_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) {
    throw new Error('「' + CAMPAIGN_DRAFT_SHEET +
      '」シートが見つかりません。メニューの「🔧 シート再生成」を実行してください。');
  }
  return {
    audience: String(sh.getRange('B4').getValue() || '全員').trim(),
    textKm:   String(sh.getRange('B6').getValue() || '').trim(),
    textEn:   String(sh.getRange('B7').getValue() || '').trim()
  };
}

/**
 * 顧客シートから配信対象リストを構築
 *   - チャットID が空の顧客は除外（Bot から送信不可能）
 *   - 言語フィルタを適用
 */
function buildRecipientList_(audience) {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const idCol   = headers['顧客ID'];
  const chatCol = headers['チャットID'];
  const nameCol = headers['氏名'];
  const langCol = headers['言語'];
  if (!chatCol) throw new Error('「顧客」シートに「チャットID」列が見つかりません');

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const list = [];
  data.forEach(function(row) {
    const chatId = String(row[chatCol - 1] || '').trim();
    if (!chatId) return;

    const language = String((langCol ? row[langCol - 1] : '') || 'クメール語').trim();
    if (audience === 'クメール語のみ' && language === '英語') return;
    if (audience === '英語のみ'      && language !== '英語') return;

    list.push({
      customerId: idCol  ? String(row[idCol  - 1] || '') : '',
      chatId:     chatId,
      name:       nameCol ? String(row[nameCol - 1] || '') : '',
      language:   language
    });
  });
  return list;
}

/**
 * 顧客1件あたりの本文を決定
 *   - 英語顧客は英語版、なければクメール語版
 *   - クメール語顧客はクメール語版、なければ英語版
 */
function pickCampaignText_(draft, recipient) {
  if (recipient.language === '英語') {
    return draft.textEn || draft.textKm;
  }
  return draft.textKm || draft.textEn;
}

/**
 * ブロードキャスト本体
 */
function executeBroadcast_(draft, recipients) {
  const campaignId = 'CAMP-' + Utilities.formatDate(
    new Date(), 'Asia/Phnom_Penh', 'yyyyMMdd-HHmmss'
  );
  const sentAt = new Date();

  let success = 0, failed = 0, blocked = 0;
  const logRows = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const text = pickCampaignText_(draft, r);
    const preview = text ? (text.length > 80 ? text.substring(0, 80) + '…' : text) : '';

    if (!text) {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    'failed', '本文空', '']);
      continue;
    }

    const res = sendCampaignOne_(r.chatId, text);
    if (res.ok) {
      success += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    'success', '', preview]);
    } else if (res.blocked) {
      blocked += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    'blocked', res.error || 'bot blocked', preview]);
    } else {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    'failed', res.error || 'unknown', preview]);
    }

    if (i < recipients.length - 1) {
      Utilities.sleep(CAMPAIGN_SEND_INTERVAL_MS);
    }
  }

  // 履歴シートに一括書き込み
  if (logRows.length > 0) {
    const logSh = ensureCampaignLogSheet_();
    logSh.getRange(logSh.getLastRow() + 1, 1, logRows.length, logRows[0].length)
      .setValues(logRows);
  }

  return {
    campaignId: campaignId,
    sentAt:     sentAt,
    total:      recipients.length,
    success:    success,
    failed:     failed,
    blocked:    blocked
  };
}

/**
 * 1件送信。429（レート制限）は retry_after に従って1回リトライ。
 * 403 や "bot was blocked" 系は blocked フラグで返す。
 */
function sendCampaignOne_(chatId, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = sendMessage(BOT_TYPE.BOOKING, chatId, text, {
      disable_web_page_preview: true
    });
    if (res && res.ok) return { ok: true };

    const desc = (res && res.description) ? String(res.description) : '';
    const errCode = (res && res.error_code) ? Number(res.error_code) : 0;

    // 429: レート制限 → retry_after に従って待機しリトライ
    if (errCode === 429 && res.parameters && res.parameters.retry_after) {
      Utilities.sleep((Number(res.parameters.retry_after) + 1) * 1000);
      continue;
    }
    // 403 や明示的なブロック
    if (errCode === 403 || /blocked|deactivated|user is deactivated|kicked|chat not found/i.test(desc)) {
      return { ok: false, blocked: true, error: desc || ('error_code=' + errCode) };
    }
    return { ok: false, blocked: false, error: desc || ('error_code=' + errCode) };
  }
  return { ok: false, blocked: false, error: '429 リトライ後も失敗' };
}

/**
 * 下書きシートに最終結果を書き戻す
 */
function writeCampaignSummary_(result) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) return;

  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  sh.getRange('B11').setValue(Utilities.formatDate(result.sentAt, tz, 'yyyy-MM-dd HH:mm:ss'));
  sh.getRange('B12').setValue(
    '✅ ' + result.success + ' / ❌ ' + result.failed + ' / 🚫 ' + result.blocked +
    '   （合計 ' + result.total + '）'
  );
  sh.getRange('B13').setValue(result.campaignId);
}
