/**
 * FieldLink.gs — 現場アプリ v2 のスタッフ専用リンク（2026-10-08）
 *
 * ホーム画面アプリ（PWA）では Telegram の本人確認が使えないため、
 * スタッフごとの専用リンク `…/field/?u=<chatId>&k=<鍵>` を配り、アプリが毎回 chatId と鍵を送る。
 *
 *   - 鍵 = HMAC-SHA256(秘密, 'field-link-v1:' + chatId) の先頭 24 文字
 *   - 秘密は ScriptProperties「FIELD_LINK_SECRET」。無ければ初回に自動生成（コード・リポジトリには書かない）
 *   - 全員の鍵を無効にする: FIELD_LINK_SECRET を削除（次の発行で新しい秘密になる）
 *     ⚠️ 2026-10-30〜 v7 の ScriptProperties にも同じ値を置く（v7/StaffGate.gs が専用リンクの鍵を確かめる）。
 *        削除・差し替えは v7 と v7-operations の両方を同時に行う（片方だけだと、取り消した鍵が v7 で通り続ける）
 *   - 発行できるのは管理者（スタッフマスターの役割 admin）だけ。Telegram 署名（initData）で本人を確認する
 *   - 署名必須化（Phase 2）までは鍵の確認結果を whoami で返すだけ（ブロックはしない）
 */

var FIELD_APP_URL_ = 'https://ec20921-debug.github.io/samurai-motors-miniapp/field/';

function fieldLinkSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('FIELD_LINK_SECRET');
  if (s) return s;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    s = props.getProperty('FIELD_LINK_SECRET');
    if (!s) {
      s = Utilities.getUuid() + Utilities.getUuid();
      props.setProperty('FIELD_LINK_SECRET', s);
    }
    return s;
  } finally {
    lock.releaseLock();
  }
}

function fieldLinkKey_(chatId) {
  var sig = Utilities.computeHmacSha256Signature('field-link-v1:' + String(chatId), fieldLinkSecret_());
  return sig.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 24);
}

function fieldLinkKeyOk_(chatId, key) {
  if (!key) return false;
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FIELD_LINK_SECRET')) return false;   // まだ一度も発行していない
  return fieldLinkKey_(chatId) === String(key);
}

/**
 * 専用リンクの発行
 * @param {string} initDataRaw - Telegram の署名つき initData（Router で取り出したもの）
 * @param {Object} body - { targetChatId | targetStaffId }
 */
function fieldLinkIssue_(initDataRaw, body) {
  var v = verifyTelegramInitData_(initDataRaw);
  if (!v || !v.ok) return { ok: false, error: 'AUTH_REQUIRED', message: 'Telegram から開いてください' };
  // 古い署名の使い回しを防ぐ（2026-10-09 レビュー M4）
  if (!(v.ageSec >= 0 && v.ageSec < 24 * 3600)) return { ok: false, error: 'AUTH_EXPIRED', message: 'Telegram からもう一度開いてください' };
  var me = findStaffByChatId(v.userId);
  if (!me || me.role !== 'admin') return { ok: false, error: 'AUTH_FORBIDDEN', message: '管理者のみ発行できます' };

  var target = null;
  if (body.targetStaffId) target = findStaffById(String(body.targetStaffId));
  if (!target && body.targetChatId) target = findStaffByChatId(String(body.targetChatId));
  if (!target) return { ok: false, error: 'STAFF_NOT_FOUND' };
  if (!target.chatId) return { ok: false, error: 'NO_CHAT_ID', message: 'スタッフマスターに Chat ID がありません' };

  var link = FIELD_APP_URL_ + '?u=' + encodeURIComponent(target.chatId) + '&k=' + fieldLinkKey_(target.chatId);
  Logger.log('🔗 field link issued for ' + target.staffId + ' by ' + me.staffId);
  return { ok: true, link: link, staff: { staffId: target.staffId, nameJp: target.nameJp, nameEn: target.nameEn } };
}

/**
 * スタッフ全員の現場アプリ専用リンクを実行ログに出す（GAS エディタから実行・管理者だけが使える場所・2026-10-23）
 * Daisuke「本人用リンクの出し方がよくわからない」→ Telegram の管理者カードを使わず PC だけで作れるように（ScoutBoard.scoutHomeLinks と同じ形）
 * - リンクは本人だけに送る（他人に渡すとその人として打刻・日報できてしまう）。全員分を無効にする時は FIELD_LINK_SECRET を削除（2026-10-30〜 v7 にも同じ値を置く＝v7/StaffGate.gs。削除・差し替えは v7 と v7-operations の両方を同時に）
 */
function fieldHomeLinks() {
  getActiveStaff().forEach(function (s) {
    var label = s.nameEn || s.nameJp;
    if (!s.chatId) { Logger.log('— ' + label + '：Chat ID 未登録'); return; }
    Logger.log('🔗 ' + label + '：' + FIELD_APP_URL_ + '?u=' + encodeURIComponent(s.chatId) + '&k=' + fieldLinkKey_(s.chatId));
  });
}

/** 管理者用: 有効なスタッフの一覧（専用リンク発行の画面用・chatId は返さない） */
function fieldLinkStaffList_() {
  return getActiveStaff().map(function (s) {
    return { staffId: s.staffId, nameJp: s.nameJp, nameEn: s.nameEn, role: s.role, hasChat: !!s.chatId };
  });
}

// ── 専用リンクを、勤務Bot から本人の Telegram へ送る（2026-11-19） ──
// Daisuke「なんかめんどくさい」→ 管理者がログからリンクを写して送る手間をなくす。
// リンク（鍵）は人の手・実行ログ・Claude を通らず、本人のトークにだけ届く。
//
// 使い方:
//   1. 本体シート「アプリと鍵」タブで、その人の FIELD の行の「鍵・リンク・ログインを出した日」に「送る」と書く
//   2. GAS エディタで fieldLinkSendMarked を実行
//   3. 送れた行は「送る」が日付に変わり、「出した人」に「勤務Bot（本人の Telegram へ）」と入る
// 送れる条件: スタッフマスターで有効・Chat ID が数字（＝本人が勤務Bot に START 済み）
// クメール語の文は 11/19 の A3 で Panha の校閲を通した文をそのまま使う（言いかえない）
var FIELD_LINK_SHEET_ = 'アプリと鍵';
var FIELD_LINK_SEND_MARK_ = '送る';
var FIELD_LINK_SENT_BY_ = '勤務Bot（本人の Telegram へ）';

function fieldLinkMessage_(staff) {
  var link = FIELD_APP_URL_ + '?u=' + encodeURIComponent(staff.chatId) + '&k=' + fieldLinkKey_(staff.chatId);
  return '🔗 FIELD — ' + (staff.nameEn || staff.nameJp) + '\n' + link + '\n\n' +
    'FIELD៖ យើងចុចតំណដែលមកក្នុង Telegram ឱ្យជាប់ រួចជ្រើស “Open in Safari”\n' +
    'យើងចុចប៊ូតុងចែករំលែកខាងក្រោម (ការ៉េ មានព្រួញឡើងលើ)\n' +
    'យើងចុច “Add to Home Screen” រួចចុច “Add” ខាងលើស្ដាំ\n' +
    'តំណ ID ពាក្យសម្ងាត់ខ្លួន យើងមិនប្រាប់ មិនឱ្យអ្នកដទៃខ្ចី\n\n' +
    '（リンクを長押し →「Safari で開く」→ 共有 →「ホーム画面に追加」。このリンクは人に教えない）';
}

function fieldLinkSendMarked() {
  var sheet = getSheet(FIELD_LINK_SHEET_);
  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error('❌ 「アプリと鍵」が空です');
  clearStaffMasterCache();   // Chat ID を直した直後でも、古い番号へ送らないように
  var done = {};             // 同じ人の行が2つあっても、1回の実行で送るのは1通
  var head = values[0].map(function (h) { return String(h).trim(); });
  var cId = head.indexOf('スタッフID'), cApp = head.indexOf('アプリ'),
      cDay = head.indexOf('鍵・リンク・ログインを出した日'), cBy = head.indexOf('出した人'), cUpd = head.indexOf('最終更新');
  if (cId < 0 || cApp < 0 || cDay < 0 || cBy < 0) throw new Error('❌ 「アプリと鍵」の見出しが見つかりません');
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var sent = 0, skipped = 0;
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (String(row[cDay]).trim() !== FIELD_LINK_SEND_MARK_) continue;
    if (String(row[cApp]).trim().indexOf('FIELD') !== 0) continue;
    var staffId = String(row[cId]).trim();
    if (done[staffId]) continue;
    var s = findStaffById(staffId);
    if (!s || !/^\d+$/.test(String(s.chatId))) {
      Logger.log('— ' + staffId + '：送れません（スタッフマスターで有効でない、または Chat ID が未登録）');
      skipped++;
      continue;
    }
    // プレビューを切る（Telegram のサーバーが鍵つきのアドレスを読みに行かないように）
    var res = sendMessage(BOT_TYPE.INTERNAL, s.chatId, fieldLinkMessage_(s), { link_preview_options: { is_disabled: true } });
    if (!res || !res.ok) {
      Logger.log('⚠️ ' + staffId + '：送信に失敗（本人が勤務Bot に START していない・ブロックしている等）');
      skipped++;
      continue;
    }
    done[staffId] = true;
    try {
      sheet.getRange(r + 1, cDay + 1).setValue(today);
      sheet.getRange(r + 1, cBy + 1).setValue(FIELD_LINK_SENT_BY_);
      if (cUpd >= 0) sheet.getRange(r + 1, cUpd + 1).setValue(today);
    } catch (e) {
      Logger.log('⚠️ ' + staffId + '：送信はできたが、シートへの書き戻しに失敗（「送る」を手で消してください）' + e);
    }
    Logger.log('✅ ' + staffId + '：本人の Telegram へ送りました');   // リンクはログに出さない
    sent++;
  }
  Logger.log('🔗 fieldLinkSendMarked: 送った=' + sent + ' 送れなかった=' + skipped);
  return { sent: sent, skipped: skipped };
}
