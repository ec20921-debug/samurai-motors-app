/**
 * CampaignScheduler.gs — キャンペーンの予約投稿（スケジュール配信）
 *
 * 【責務】
 *   「キャンペーン配信予約」シートに登録した配信を、指定の曜日・時刻に自動送信する。
 *   - 単発: 指定日(YYYY-MM-DD)＋時刻に1回だけ送って「送信済」にする
 *   - 毎週: 指定曜日＋時刻に毎週送る（送信後また待機に戻る）
 *
 * 【仕組み】
 *   15分ごとの時間主導トリガー processCampaignSchedule() が起動し、
 *   「今が送信タイミングを過ぎた未送信の予約」を探して executeBroadcast_ で配信。
 *   GAS は「正確にこの分」が苦手なため、15分の窓内に入ったものを送る方式。
 *
 * 【二重送信防止】
 *   - 単発: 状態=送信済 になったら二度と送らない
 *   - 毎週: 「最終送信日時」が同じ日付内なら再送しない（1日1回ガード）
 *   - 実行はロックで直列化（トリガー重複起動対策）
 *
 * 【再利用】
 *   送信は Campaign.gs の executeBroadcast_ / buildRecipientList_ をそのまま使う。
 *   素材名→リンク解決は CampaignAssets.gs の resolveAssetValue_。
 *   送り先は「配信対象=☑ の全員」（送信時点の状態で判定）。言語は予約行で指定。
 *
 * 【セットアップ】
 *   setupCampaignSchedule() を1回実行 → シート生成 + 15分トリガー登録。
 */

const CAMPAIGN_SCHEDULE_SHEET = 'キャンペーン配信予約';   // 配信の予約投稿（日本側が使う）
const CAMPAIGN_SCHEDULE_SHEET_OLD = 'キャンペーン予約';  // 旧名（自動リネーム用）
// ※「特価キャンペーン」(CampaignBooking.gs) は別物＝ロンが$5受注を手入力する受注台帳。
//   混同を避けるため、配信側は「配信予約」と明示する。

// 予約シートの列（1-based）。レイアウト変更時はここを直す。
const SCHED_COL = {
  ID:        1,  // 予約ID
  ENABLED:   2,  // 有効（チェックボックス）
  TYPE:      3,  // 単発 / 毎週
  DATE:      4,  // 単発の送信日 YYYY-MM-DD
  WEEKDAY:   5,  // 毎週の曜日（日〜土）
  TIME:      6,  // 時刻 HH:mm（15分刻み推奨）
  LANG:      7,  // 言語（CAMPAIGN_AUDIENCE_OPTIONS）
  TEXT_KM:   8,  // 本文(クメール語)
  TEXT_EN:   9,  // 本文(英語)
  IMAGE:    10,  // 画像 ファイル名 or リンク
  VOICE:    11,  // ボイス ファイル名 or リンク
  VIDEO:    12,  // 動画 ファイル名 or リンク
  NOTE_JP:  13,  // 内容(日本語) — 振り返り用メモ。台帳に転記
  STATUS:   14,  // 状態（待機/送信済/エラー/スキップ）
  LAST_SENT:15,  // 最終送信日時
  NOTE:     16   // メモ（エラー詳細など）
};

const SCHED_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const SCHED_WINDOW_MIN = 15; // この分数の窓に入ったら送る（トリガー間隔と合わせる）

// =====================================================
//  セットアップ
// =====================================================

/**
 * 予約投稿機能のセットアップ（1回だけ実行）
 *   - 「キャンペーン配信予約」シート生成
 *   - 15分間隔トリガー登録（既存の同名トリガーは張り替え）
 */
function setupCampaignSchedule() {
  ensureCampaignScheduleSheet_();

  // 既存の processCampaignSchedule トリガーを掃除して張り直し
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processCampaignSchedule') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processCampaignSchedule')
    .timeBased().everyMinutes(SCHED_WINDOW_MIN).create();

  Logger.log('✅ キャンペーン予約投稿 セットアップ完了');
  Logger.log('  - 「' + CAMPAIGN_SCHEDULE_SHEET + '」シート 準備OK');
  Logger.log('  - ' + SCHED_WINDOW_MIN + '分ごとに processCampaignSchedule を実行');
}

/**
 * 【診断】配信予約が動く状態か確認する（GASエディタで実行 → ログを見る）
 *   - processCampaignSchedule トリガーが存在するか
 *   - 今この瞬間、各予約行が「送る/送らない」どちらに判定されるか＋理由
 * テストが空振りする前の事前確認用。送信は行わない（read-only）。
 */
function diagnoseCampaignSchedule() {
  Logger.log('━━━━━━━━━━ 配信予約 診断 ━━━━━━━━━━');

  // ① トリガー存在チェック
  const triggers = ScriptApp.getProjectTriggers().filter(function(t) {
    return t.getHandlerFunction() === 'processCampaignSchedule';
  });
  if (triggers.length === 0) {
    Logger.log('❌ トリガー未登録: processCampaignSchedule が存在しません');
    Logger.log('   → setupCampaignSchedule を実行してください（これが昨日送られなかった原因の可能性大）');
  } else {
    Logger.log('✅ トリガー登録あり: processCampaignSchedule × ' + triggers.length + '（15分間隔のはず）');
  }

  // ② 今この瞬間の判定シミュレーション
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_SCHEDULE_SHEET);
  if (!sh) { Logger.log('❌ 「' + CAMPAIGN_SCHEDULE_SHEET + '」シートなし'); return; }
  const lastRow = sh.getLastRow();
  if (lastRow < 3) { Logger.log('ℹ️ 予約行なし'); return; }

  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  const now = new Date();
  const nowMin = Number(Utilities.formatDate(now, tz, 'H')) * 60 + Number(Utilities.formatDate(now, tz, 'm'));
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const todayWeekday = SCHED_WEEKDAYS[Number(Utilities.formatDate(now, tz, 'u')) % 7];
  Logger.log('🕐 現在: ' + Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm') + '（' + todayWeekday + '曜, ' + nowMin + '分）窓=' + SCHED_WINDOW_MIN + '分');

  const data = sh.getRange(3, 1, lastRow - 2, SCHED_COL.NOTE).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const r = i + 3;
    const id = String(row[SCHED_COL.ID - 1] || '(ID空)');
    const enabled = (row[SCHED_COL.ENABLED - 1] === true || String(row[SCHED_COL.ENABLED - 1]).toUpperCase() === 'TRUE');
    const type = String(row[SCHED_COL.TYPE - 1] || '').trim();
    const timeStr = normalizeTime_(row[SCHED_COL.TIME - 1], tz);
    const dateStr = normalizeDate_(row[SCHED_COL.DATE - 1], tz);
    const wd = String(row[SCHED_COL.WEEKDAY - 1] || '').trim();
    const status = String(row[SCHED_COL.STATUS - 1] || '').trim();
    const lastSent = row[SCHED_COL.LAST_SENT - 1];
    const lastSentDay = lastSent ? Utilities.formatDate(new Date(lastSent), tz, 'yyyy-MM-dd') : '';

    // 空行スキップ
    if (!type && !timeStr && !row[SCHED_COL.TEXT_KM - 1]) continue;

    let verdict = '';
    if (!enabled) verdict = '⏸ 送らない（有効=OFF）';
    else if (!timeStr) verdict = '⚠️ 送らない（時刻が空/不正: "' + row[SCHED_COL.TIME - 1] + '"）';
    else {
      const schedMin = Number(timeStr.split(':')[0]) * 60 + Number(timeStr.split(':')[1]);
      const inWindow = (nowMin >= schedMin && nowMin < schedMin + SCHED_WINDOW_MIN);
      if (lastSentDay === todayStr) verdict = '✅ 本日送信済み（' + lastSentDay + '）';
      else if (type === '単発') {
        if (dateStr !== todayStr) verdict = '⏭ 送らない（単発の日付 ' + dateStr + ' ≠ 今日 ' + todayStr + '）';
        else if (status === '送信済') verdict = '⏭ 送らない（状態=送信済）';
        else if (!inWindow) verdict = '⏳ まだ（時刻 ' + timeStr + ' の窓[' + schedMin + '〜' + (schedMin + SCHED_WINDOW_MIN) + '分]外。今 ' + nowMin + '分）';
        else verdict = '🚀 今この瞬間なら送る対象！';
      } else if (type === '毎週') {
        if (wd !== todayWeekday) verdict = '⏭ 送らない（曜日 ' + wd + ' ≠ 今日 ' + todayWeekday + '）';
        else if (!inWindow) verdict = '⏳ まだ（時刻窓外）';
        else verdict = '🚀 今この瞬間なら送る対象！';
      } else verdict = '⚠️ 送らない（種別が空/不正: "' + type + '"）';
    }
    Logger.log('行' + r + ' [' + id + '] ' + type + ' ' + (type === '毎週' ? wd + '曜' : dateStr) + ' ' + timeStr + ' → ' + verdict);
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 「キャンペーン配信予約」シートを用意（冪等・ヘッダーとドロップダウン整備）
 */
function ensureCampaignScheduleSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headers = [
    '予約ID', '有効', '種別', '送信日(単発)', '曜日(毎週)', '時刻',
    '言語', '本文(クメール語)', '本文(英語)', '画像', 'ボイス', '動画',
    '内容(日本語)', '状態', '最終送信日時', 'メモ'
  ];

  // 旧名「キャンペーン予約」が残っていれば新名「キャンペーン配信予約」へリネーム（自動移行）。
  // 新名が未作成のときだけ。両方ある異常時は触らない。
  const oldSh = ss.getSheetByName(CAMPAIGN_SCHEDULE_SHEET_OLD);
  if (oldSh && !ss.getSheetByName(CAMPAIGN_SCHEDULE_SHEET)) {
    oldSh.setName(CAMPAIGN_SCHEDULE_SHEET);
  }

  let sh = ss.getSheetByName(CAMPAIGN_SCHEDULE_SHEET);
  if (sh) {
    // 旧ヘッダー（内容(日本語)なし＝M列(13)が「状態」）なら M列を挿入して移行
    if (String(sh.getRange(1, SCHED_COL.NOTE_JP).getValue()) === '状態') {
      sh.insertColumnBefore(SCHED_COL.NOTE_JP);
      sh.getRange(1, SCHED_COL.NOTE_JP).setValue('内容(日本語)');
      sh.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
      sh.setColumnWidth(SCHED_COL.NOTE_JP, 220);
    }
    applyCampaignScheduleValidations_(sh);
    return sh;
  }

  sh = ss.insertSheet(CAMPAIGN_SCHEDULE_SHEET);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  // 案内行
  sh.getRange('A2').setValue('（1行=1予約。種別を選び、単発なら送信日、毎週なら曜日を入れ、時刻はHH:mm。有効=☑で稼働）')
    .setFontColor('#999').setFontStyle('italic');

  const widths = [150, 50, 70, 110, 90, 70, 150, 320, 320, 180, 180, 180, 220, 90, 150, 220];
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });

  applyCampaignScheduleValidations_(sh);
  return sh;
}

/**
 * 予約シートのドロップダウン/チェックボックスを設定（行3〜500に適用）
 */
function applyCampaignScheduleValidations_(sh) {
  const lastApply = 500;
  const n = lastApply - 3 + 1;

  // 有効: チェックボックス
  sh.getRange(3, SCHED_COL.ENABLED, n, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());

  // 種別: 単発 / 毎週
  sh.getRange(3, SCHED_COL.TYPE, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['単発', '毎週'], true).setAllowInvalid(false).build());

  // 曜日: 日〜土
  sh.getRange(3, SCHED_COL.WEEKDAY, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(SCHED_WEEKDAYS, true).setAllowInvalid(false).build());

  // 言語: 既存の選択肢を流用（CampaignSheets.gs の定数）
  sh.getRange(3, SCHED_COL.LANG, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(CAMPAIGN_AUDIENCE_OPTIONS, true).setAllowInvalid(false).build());

  // 画像/ボイス/動画: 素材一覧のファイル名から選べる（直貼りも可）。素材シートがあれば適用。
  const assets = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('キャンペーン素材');
  if (assets) {
    const namesRange = assets.getRange('B2:B500');
    const rule = SpreadsheetApp.newDataValidation().requireValueInRange(namesRange, true).setAllowInvalid(true).build();
    [SCHED_COL.IMAGE, SCHED_COL.VOICE, SCHED_COL.VIDEO].forEach(function(c) {
      sh.getRange(3, c, n, 1).setDataValidation(rule);
    });
  }
}

// =====================================================
//  スケジュール処理（15分トリガーから呼ばれる）
// =====================================================

/**
 * 予約シートを走査し、送信タイミングに入った予約を配信する。
 * 15分間隔トリガーで起動。
 */
function processCampaignSchedule() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('⏭️ processCampaignSchedule: 別実行がロック中、スキップ');
    return;
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(CAMPAIGN_SCHEDULE_SHEET);
    if (!sh) return;
    const lastRow = sh.getLastRow();
    if (lastRow < 3) return;

    const tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
    const now = new Date();
    const nowMin = Number(Utilities.formatDate(now, tz, 'H')) * 60 + Number(Utilities.formatDate(now, tz, 'm'));
    const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    // 曜日: GAS 'u' は 1=月..7=日。SCHED_WEEKDAYS は 0=日..6=土。u%7 で 7(日)→0, 1(月)→1...6(土)→6 に変換。
    const todayWeekday = SCHED_WEEKDAYS[Number(Utilities.formatDate(now, tz, 'u')) % 7];

    const data = sh.getRange(3, 1, lastRow - 2, SCHED_COL.NOTE).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const sheetRow = i + 3;
      const enabled = (row[SCHED_COL.ENABLED - 1] === true || String(row[SCHED_COL.ENABLED - 1]).toUpperCase() === 'TRUE');
      if (!enabled) continue;

      const type = String(row[SCHED_COL.TYPE - 1] || '').trim();
      const timeStr = normalizeTime_(row[SCHED_COL.TIME - 1], tz);
      if (!timeStr) continue;
      const schedMin = Number(timeStr.split(':')[0]) * 60 + Number(timeStr.split(':')[1]);

      // 送信タイミング判定: 今が [schedMin, schedMin+window) に入っているか
      const inWindow = (nowMin >= schedMin && nowMin < schedMin + SCHED_WINDOW_MIN);
      if (!inWindow) continue;

      const status = String(row[SCHED_COL.STATUS - 1] || '').trim();
      const lastSent = row[SCHED_COL.LAST_SENT - 1];
      const lastSentDay = lastSent ? Utilities.formatDate(new Date(lastSent), tz, 'yyyy-MM-dd') : '';

      // 当日すでに送っていれば二重送信しない（窓が複数トリガーにまたがっても安全）
      if (lastSentDay === todayStr) continue;

      let shouldSend = false;
      if (type === '単発') {
        const dateStr = normalizeDate_(row[SCHED_COL.DATE - 1], tz);
        if (dateStr === todayStr && status !== '送信済') shouldSend = true;
      } else if (type === '毎週') {
        const wd = String(row[SCHED_COL.WEEKDAY - 1] || '').trim();
        if (wd === todayWeekday) shouldSend = true;
      }
      if (!shouldSend) continue;

      // 配信実行
      sendScheduledRow_(sh, sheetRow, row, type, todayStr);
    }
  } catch (err) {
    Logger.log('❌ processCampaignSchedule error: ' + err + ' stack=' + (err.stack || ''));
  } finally {
    lock.releaseLock();
  }
}

/**
 * 予約1行を配信する（既存 executeBroadcast_ を再利用）
 */
/**
 * 予約シートの1行を、送信に使う draft オブジェクトへ変換する
 * （送信・プレビュー・テスト送信で共通利用）
 *
 * @param {Array} row - SCHED_COL の並びの1行（0-based 配列）
 * @return {Object} {audience,textKm,textEn,imageUrl,voiceUrl,videoUrl}
 */
function scheduledRowToDraft_(row) {
  const resolve = (typeof resolveAssetValue_ === 'function')
    ? resolveAssetValue_ : function(x) { return String(x || '').trim(); };
  return {
    audience: String(row[SCHED_COL.LANG - 1] || CAMPAIGN_LANG_BOTH).trim(),
    noteJp:   String(row[SCHED_COL.NOTE_JP - 1] || '').trim(),
    textKm:   String(row[SCHED_COL.TEXT_KM - 1] || '').trim(),
    textEn:   String(row[SCHED_COL.TEXT_EN - 1] || '').trim(),
    imageUrl: resolve(row[SCHED_COL.IMAGE - 1]),
    voiceUrl: resolve(row[SCHED_COL.VOICE - 1]),
    videoUrl: resolve(row[SCHED_COL.VIDEO - 1])
  };
}

function sendScheduledRow_(sh, sheetRow, row, type, todayStr) {
  const draft = scheduledRowToDraft_(row);

  // 本文も添付も無ければスキップ（事故防止）
  if (!draft.textKm && !draft.textEn && !draft.imageUrl && !draft.voiceUrl && !draft.videoUrl) {
    sh.getRange(sheetRow, SCHED_COL.STATUS).setValue('エラー');
    sh.getRange(sheetRow, SCHED_COL.NOTE).setValue('本文・添付がすべて空');
    return;
  }
  // 動画サイズ上限チェック
  if (draft.videoUrl && typeof driveSizeMB_ === 'function') {
    const mb = driveSizeMB_(draft.videoUrl);
    if (mb > 50) {
      sh.getRange(sheetRow, SCHED_COL.STATUS).setValue('エラー');
      sh.getRange(sheetRow, SCHED_COL.NOTE).setValue('動画が50MB超（' + mb.toFixed(1) + 'MB）');
      return;
    }
  }

  let recipients = [];
  try {
    // スケジュール配信は「当日登録の新規客」を除外（登録直後にキャンペーンが飛ぶバグ対策）。
    // 翌日からは通常どおり配信対象に入る。手動一斉送信は意図的なので除外しない。
    recipients = buildRecipientList_({ excludeRegisteredOnDate: todayStr });
  } catch (e) {
    sh.getRange(sheetRow, SCHED_COL.STATUS).setValue('エラー');
    sh.getRange(sheetRow, SCHED_COL.NOTE).setValue('対象取得失敗: ' + e);
    return;
  }
  if (recipients.length === 0) {
    sh.getRange(sheetRow, SCHED_COL.STATUS).setValue('スキップ');
    sh.getRange(sheetRow, SCHED_COL.NOTE).setValue('配信対象=☑ が0名');
    sh.getRange(sheetRow, SCHED_COL.LAST_SENT).setValue(new Date()); // 当日再試行を防ぐ
    return;
  }

  let result;
  try {
    result = executeBroadcast_(draft, recipients); // 台帳/履歴記録も既存どおり走る
  } catch (e) {
    sh.getRange(sheetRow, SCHED_COL.STATUS).setValue('エラー');
    sh.getRange(sheetRow, SCHED_COL.NOTE).setValue('配信失敗: ' + e);
    return;
  }

  // 状態更新: 単発は「送信済」、毎週は「待機（毎週）」に戻す
  sh.getRange(sheetRow, SCHED_COL.STATUS).setValue(type === '単発' ? '送信済' : '待機（毎週）');
  sh.getRange(sheetRow, SCHED_COL.LAST_SENT).setValue(new Date());
  sh.getRange(sheetRow, SCHED_COL.NOTE).setValue(
    '✅ ' + result.success + ' / ❌ ' + result.failed + ' / 🚫 ' + result.blocked +
    '（' + result.campaignId + '）');
}

// =====================================================
//  ヘルパー
// =====================================================

/**
 * 時刻セルを 'HH:mm' に正規化。
 * Date(セルが時刻型)も '8:00'/'08:00' 文字列も受ける。失敗時 ''。
 */
function normalizeTime_(v, tz) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz, 'HH:mm');
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Math.min(23, Number(m[1]));
  const mi = Math.min(59, Number(m[2]));
  return (h < 10 ? '0' + h : '' + h) + ':' + (mi < 10 ? '0' + mi : '' + mi);
}

/**
 * 日付セルを 'yyyy-MM-dd' に正規化。Date型も文字列も受ける。失敗時 ''。
 */
function normalizeDate_(v, tz) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return '';
  const mo = m[2].length === 1 ? '0' + m[2] : m[2];
  const d = m[3].length === 1 ? '0' + m[3] : m[3];
  return m[1] + '-' + mo + '-' + d;
}

/** 「キャンペーン配信予約」シートを開く（メニューから） */
function openCampaignScheduleSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_SCHEDULE_SHEET);
  if (!sh) { ss.toast('配信予約シートがありません。setupCampaignSchedule を実行してください。'); return; }
  ss.setActiveSheet(sh);
}

// =====================================================
//  予約行ごとのプレビュー / テスト送信
// =====================================================

/**
 * 「キャンペーン配信予約」シートで選択中の行の内容をプレビュー表示する。
 * 予約ごとに別々の本文・画像を確認できる（下書きタブとは独立）。
 */
function previewScheduledRow() {
  const ui = SpreadsheetApp.getUi();
  const ctx = getSelectedScheduleRow_();
  if (!ctx) return;

  const draft = scheduledRowToDraft_(ctx.row);
  if (!draft.textKm && !draft.textEn && !draft.imageUrl && !draft.voiceUrl && !draft.videoUrl) {
    ui.alert('⚠️ この予約は空です', '本文も添付も入っていません（' + ctx.sheetRow + '行目）。', ui.ButtonSet.OK);
    return;
  }

  let total = 0;
  try { total = buildRecipientList_().length; } catch (e) { total = 0; }

  // スケジュール情報の見出し
  const type = String(ctx.row[SCHED_COL.TYPE - 1] || '').trim();
  const when = (type === '毎週')
    ? ('毎週 ' + String(ctx.row[SCHED_COL.WEEKDAY - 1] || '?') + '曜 ' + String(ctx.row[SCHED_COL.TIME - 1] || ''))
    : ('単発 ' + String(ctx.row[SCHED_COL.DATE - 1] || '?') + ' ' + String(ctx.row[SCHED_COL.TIME - 1] || ''));
  const enabled = (ctx.row[SCHED_COL.ENABLED - 1] === true) ? '✅有効' : '⏸無効（送られません）';

  const head =
    '🗓 予約: ' + (String(ctx.row[SCHED_COL.ID - 1] || '(' + ctx.sheetRow + '行目)')) + '\n' +
    '  タイミング: ' + when + '\n' +
    '  状態: ' + enabled + '\n' +
    '────────────────\n\n';

  const msg = head + buildDraftPreviewText_(draft, total) +
    '\n\n※ 実物を自分に送って確認するには「🧪 この予約をテスト送信」を使ってください。';
  ui.alert('🗓 予約プレビュー', msg, ui.ButtonSet.OK);
}

/**
 * 選択中の予約行の内容を、自分のチャットIDだけに実物として送る（見え方確認）。
 * 配信履歴・台帳には記録するが、予約の状態は変更しない。
 */
function testSendScheduledRow() {
  const ui = SpreadsheetApp.getUi();
  const ctx = getSelectedScheduleRow_();
  if (!ctx) return;

  const draft = scheduledRowToDraft_(ctx.row);
  if (!draft.textKm && !draft.textEn && !draft.imageUrl && !draft.voiceUrl && !draft.videoUrl) {
    ui.alert('⚠️ この予約は空です', '本文も添付もありません（' + ctx.sheetRow + '行目）。', ui.ButtonSet.OK);
    return;
  }
  if (draft.videoUrl && typeof driveSizeMB_ === 'function') {
    const mb = driveSizeMB_(draft.videoUrl);
    if (mb > 50) { ui.alert('⚠️ 動画が大きすぎます', mb.toFixed(1) + 'MB は上限50MB超。圧縮してください。', ui.ButtonSet.OK); return; }
  }

  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('CAMPAIGN_TEST_CHAT_ID') || '';
  const resp = ui.prompt('🧪 この予約をテスト送信',
    'テスト送信先の Telegram チャットID（自分）を入力してください。' +
    (saved ? '\n\n空欄OKで前回のID（' + saved + '）を使います。' : ''),
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  let chatId = String(resp.getResponseText() || '').trim() || saved;
  if (!chatId) { ui.alert('⚠️ チャットIDが空です'); return; }
  props.setProperty('CAMPAIGN_TEST_CHAT_ID', chatId);

  const text = (draft.audience === CAMPAIGN_LANG_EN_ONLY)
    ? (draft.textEn || draft.textKm)
    : (draft.audience === CAMPAIGN_LANG_KM_ONLY)
      ? (draft.textKm || draft.textEn)
      : [draft.textKm, draft.textEn].filter(function(s){return s;}).join('\n\n━━━━━━━━━━\n\n');

  const cache = { id: '' };
  const res = deliverCampaign_(chatId, draft, text, cache);  // 画像アルバム＋本文別テキスト（共通）

  const cls = classifyTgResult_(res);
  ui.alert(cls.ok ? '🧪 テスト送信 完了' : '❌ テスト送信 失敗',
    cls.ok ? ('チャットID ' + chatId + ' に送信しました。Telegram を確認してください。\n※ 予約の状態は変更していません。')
           : ('原因: ' + (cls.error || '不明') + '\n相手が予約Botを /start 済みか確認してください。'),
    ui.ButtonSet.OK);
}

/**
 * 「キャンペーン配信予約」シート上で選択中の予約行を取得する。
 * 取得できなければ alert を出して null を返す。
 * @return {{sheetRow:number, row:Array}|null}
 */
function getSelectedScheduleRow_() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  if (sh.getName() !== CAMPAIGN_SCHEDULE_SHEET) {
    ui.alert('⚠️ シートが違います',
      '「' + CAMPAIGN_SCHEDULE_SHEET + '」シートで対象の予約行を選んでから実行してください。',
      ui.ButtonSet.OK);
    return null;
  }
  const sheetRow = sh.getActiveCell().getRow();
  if (sheetRow < 3) {
    ui.alert('⚠️ 予約の行（3行目以降）を選択してください。');
    return null;
  }
  const row = sh.getRange(sheetRow, 1, 1, SCHED_COL.NOTE).getValues()[0];
  // 空行チェック（種別も本文も無い）
  const hasAny = String(row[SCHED_COL.TYPE - 1] || '').trim() ||
                 String(row[SCHED_COL.TEXT_KM - 1] || '').trim() ||
                 String(row[SCHED_COL.TEXT_EN - 1] || '').trim();
  if (!hasAny) {
    ui.alert('⚠️ この行は空です', sheetRow + '行目に予約が入っていません。', ui.ButtonSet.OK);
    return null;
  }
  return { sheetRow: sheetRow, row: row };
}
