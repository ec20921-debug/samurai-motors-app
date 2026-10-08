/**
 * FieldLink.gs — 現場アプリ v2 のスタッフ専用リンク（2026-10-08）
 *
 * ホーム画面アプリ（PWA）では Telegram の本人確認が使えないため、
 * スタッフごとの専用リンク `…/field/?u=<chatId>&k=<鍵>` を配り、アプリが毎回 chatId と鍵を送る。
 *
 *   - 鍵 = HMAC-SHA256(秘密, 'field-link-v1:' + chatId) の先頭 24 文字
 *   - 秘密は ScriptProperties「FIELD_LINK_SECRET」。無ければ初回に自動生成（コード・リポジトリには書かない）
 *   - 全員の鍵を無効にする: FIELD_LINK_SECRET を削除（次の発行で新しい秘密になる）
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

/** 管理者用: 有効なスタッフの一覧（専用リンク発行の画面用・chatId は返さない） */
function fieldLinkStaffList_() {
  return getActiveStaff().map(function (s) {
    return { staffId: s.staffId, nameJp: s.nameJp, nameEn: s.nameEn, role: s.role, hasChat: !!s.chatId };
  });
}
