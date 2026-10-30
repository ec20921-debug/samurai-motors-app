/**
 * PartnerSelfRegister.gs — 個人提携の立ち上げ（はじめのご案内のあとのチラシ・紹介URL・本人登録リンク）と、紹介者ご本人の自動登録
 * （2026-10-27・個人提携だけ。車屋はあとで）
 *
 * 【目的】Daisuke 2026-10-27
 *   「これおれがいわなくてもしっかり登録してくれるようにしてほしい」「まず個人提携だけ、本人登録リンクを自動で送って自動登録する形で」
 *   「〇〇さんと提携が決まってグループを作りました、という連絡をしたら通知が届くように。チラシも発送してもらえるように」
 *   「通知はまず日本人向けの定型なので日本語でいい。言語を変えてと言われたら変える」
 *   「登録が済んだら、そのグループに『登録ありがとうございました』みたいなのが通知されるように」
 *   ＋前から「ヒロさん以外が最初に予約したら、ヒロさんと間違えて30%引きにならないように」
 *
 * 【流れ】紹介者のグループを連携（/register）すると、予約Botが順に送る（ShopGroupGreeting.gs sendShopGroupGreetingOnce_ のあと）:
 *   ① はじめのご案内（IndividualPartner.gs buildIndividualGroupGreeting_）
 *   ② チラシ（店マスター「紹介チラシURL」の画像・最大10枚）＋資料の説明 → ③ 紹介URL（店マスター「QRリンク(BookingBot)」）
 *   ④ 🔑 本人登録リンク t.me/<予約Bot>?start=self_<token>（紹介QRとは別のリンク）
 *   本人が④から開くと、店マスター「本人chat_id」（＋本人の名前・登録日時）に自動で書き込み、
 *   グループに「ご登録ありがとうございました」、管理グループに登録した人の名前・@ユーザー名を送る
 *   → 本人の予約は予約の時に割引（ReferralAttribution.gs ⑦ selfPartnerDiscount_）
 *   言語はグループごと（individualGroupLangs_・2026-10-28〜 英語＋クメール語が標準。店マスター「グループへの通知の言語」で日本語にも）。
 *   グループ宛（チラシの説明・本人登録リンク・登録のお礼）はクメール語あり（Panha 校閲・provisional）。リンクを開いた人への返事（SELF_REG_TEXT・selfRegUserText_）はクメール語がまだ無い＝英語だけ
 *
 * 【守り】
 *   - 紹介QRからは本人登録しない（友達が先に押しても本人にならない）
 *   - 1つの紹介者に登録できる本人は1人。登録済みなら別の人がリンクを押しても上書きしない（書く直前にセルを読み直す・書いたら flush）
 *   - 管理グループのメンバー（スタッフ・Daisuke）は本人にしない（試しに押しても登録されない）。確かめられない時も登録しない
 *   - ほかの紹介者の本人として登録済みの人は、別の紹介者の本人にしない
 *   - 紹介者のグループに入っていない人は本人にしない（getChatMember。確かめられない時は登録し、管理グループに一言）。
 *     グループが連携済みでない間（作り直し中・停止）は登録しない。リンクは送ったグループ用（グループが変わったら取り消し）
 *   - リンク本体はグループにだけ送る。店マスター・営業ボードには「送付済み」だけ（先に開いた人が本人になるリンクのため）
 *   - 登録したら、まずグループと管理グループに知らせる（Telegram 名・@ユーザー名。違う人ならすぐ分かる）。歓迎文などはそのあと
 *   - 個人提携でない・停止中・店マスターに無い紹介者のリンクは登録しない（開いた人に「このリンクは使えません」）。読めない時は「少し待って」
 *   - 送る前に印を取る（partnerSendClaim_）: /register 直後の送信と毎時の安全網が重なっても、チラシ・リンクは1回だけ
 *   - チラシURL・紹介URL が別の紹介者（番号・shop_id）のものなら送らない（紹介料の取り違えを防ぐ）
 *   - 毎時の安全網: チラシ・本人登録リンクの最初の送信は、この版より後にあいさつ文を送ったグループで、あいさつ文から7日以内だけ
 *     （Hiro さん等の既存グループに今さら送らない）。作り直したリンクは枠に関係なく送れるまで送る。送れない時は6時間に1回知らせる
 *
 * 【GSS（店マスター）】紹介チラシURL（立ち上げの時に Claude が書く・改行区切り）／ 本人chat_id ／ 本人の名前（Telegram）／
 *   本人登録日時 ／ 本人登録リンク（予約Botが「送付済み 日時」「登録に使用済み 日時」と書く）。列は v7-operations が無ければ足す（IndividualPartnerOps.gs）
 *   チラシは版ごとのフォルダ（miniapp partners/<番号>/<版>/・PNG）。送るたびに「紹介チラシ送付履歴」タブへ1行（無ければ作る）。
 *   チラシを作り直したら → 店マスターの URL を新しい版に替えて resendPartnerFlyersNow('<shop_id>')（2026-10-27 Daisuke）
 * 【取り消し・作り直し】違う人が登録された → 店マスター「本人chat_id」を消すだけ → このリンクはすぐ使えなくなり（5分ほどで割引も外れる）、
 *   その人は本人登録リンクでは戻れない（戻すなら「本人chat_id」に手で入れる）。1時間以内に新しいリンクがグループに届く（すぐなら sendSelfRegLinkNow）
 *   まだ誰も登録していないリンクを止める → 「本人登録リンク」を消す（同じく作り直して送る）
 *   グループを作り直した時（同じ shop_id で /register し直した）→ resendPartnerFlyersNow と sendSelfRegLinkNow（あいさつ文は送り直さない）
 * 【呼び出し元】ShopGroupGreeting.gs（あいさつ文のあと・毎時の安全網）／ BookingBot.gs handleCustomerMessage（/start self_）
 */

var SELF_REG_TOKEN_PREFIX = 'selfreg_tok_';   // 状態タブ（KvStore.gs・2026-10-31。以前は Script Properties）: token → shop_id
var SELF_REG_SHOP_PREFIX = 'selfreg_shop_';   // 状態タブ: shop_id → token（送り直しても同じリンク）
var SELF_REG_SENT_PREFIX = 'selfreg_sent_';   // 状態タブ: 本人登録リンクをグループに送った日時
var PARTNER_FLYERS_SENT_PREFIX = 'partner_flyers_sent_';   // 状態タブ: チラシ・紹介URLをグループに送った日時
var SELF_REG_CELL_PREFIX = 'selfreg_cell_';   // 状態タブ: 店マスター「本人登録リンク」に「送付済み」を書けた印（消されたら＝取り消し）
var SELF_REG_GID_PREFIX = 'selfreg_gid_';     // 状態タブ: リンクを送った紹介者グループの chat_id（グループが変わったら＝取り消し）
var SELF_REG_USED_PREFIX = 'selfreg_used_';   // 状態タブ: このリンクで本人になった chat_id（「本人chat_id」を消したら＝取り消し）
var SELF_REG_DENY_PREFIX = 'selfreg_deny_';   // 状態タブ: 取り消された人（カンマ区切り）。本人登録リンクでは二度と本人にしない（手で「本人chat_id」に入れれば戻せる）
var SELF_REG_NEED_PREFIX = 'selfreg_need_';   // 状態タブ: 作り直したリンクの送り待ち（毎時、送れるまで送る・7日の枠に関係なく）
var PARTNER_SEND_STALE_MIN = 10;   // 「送信中」の印がこれより古ければ、止まった実行の残りとみなして送り直してよい
var PARTNER_ONBOARD_SINCE = '2026-10-27 11:00:00';   // プノンペン時刻。この時刻より後にあいさつ文を送ったグループだけ、毎時の安全網でチラシ・リンクを送る
var PARTNER_ONBOARD_RETRY_DAYS = 7;
var PARTNER_FLYER_URL_COL = '紹介チラシURL';
var PARTNER_SELF_NAME_COL = '本人の名前（Telegram）';
var PARTNER_SELF_AT_COL = '本人登録日時';
var PARTNER_SELF_LINK_COL = '本人登録リンク';

// ====== 店マスターの読み書き（shop_id の行） ======

/** 店マスターの shop_id の行 → { sheet, row, head, values }。無ければ null（毎回シートを読む） */
function partnerMasterRow_(shopId) {
  var id = String(shopId || '').trim();
  var sh = getSpreadsheet().getSheetByName('店マスター');
  if (!id || !sh || sh.getLastRow() < 2) return null;
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim(); });
  var ci = head.indexOf('shop_id');
  if (ci < 0) return null;
  var ids = sh.getRange(2, ci + 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() !== id) continue;
    return { sheet: sh, row: i + 2, head: head, values: sh.getRange(i + 2, 1, 1, head.length).getValues()[0] };
  }
  return null;
}

/** 行の列の値（列が無ければ ''） */
function partnerMasterCell_(r, col) {
  var i = r ? r.head.indexOf(col) : -1;
  return i >= 0 ? r.values[i] : '';
}

/** 行の列に書く（列が無ければ書かない・false） */
function partnerMasterSet_(r, col, value) {
  var i = r ? r.head.indexOf(col) : -1;
  if (i < 0) return false;
  r.sheet.getRange(r.row, i + 1).setValue(sheetSafeValue_(value));   // 数式にならないように（SheetHelpers.gs）
  return true;
}

/** 紹介者の連携済みグループの chat_id（無ければ ''） */
function partnerGroupChatId_(shopId) {
  var link = findShopLinkByShopId_(shopId);
  return (link && String(link.obj['状態']) === '連携済') ? String(link.obj['グループchat_id'] || '') : '';
}

// ====== 本人登録リンク ======

/** 紹介者の本人登録用 token（無ければ作る）。リンク本体はグループにだけ送り、シートには書かない（2026-10-27 レビュー: 先に開いた人が本人になるため） */
function selfRegTokenFor_(shopId) {
  var id = String(shopId || '').trim();
  var tok = kvGet_(SELF_REG_SHOP_PREFIX + id);
  if (tok) return tok;
  tok = Utilities.getUuid().replace(/-/g, '').substring(0, 20);
  var p = {};
  p[SELF_REG_SHOP_PREFIX + id] = tok;
  p[SELF_REG_TOKEN_PREFIX + tok] = id;
  kvSetAll_(p);
  return tok;
}

/**
 * 店マスター「本人登録リンク」に「送付済み」と書く（リンク本体は書かない）。書けたら印を付ける。
 * この印があるのにセルが空 ＝ Daisuke が消した ＝ そのリンクの取り消し（handleSelfRegStart_ ですぐ効く・毎時の安全網が作り直して送る）
 */
function markSelfLinkCell_(shopId, at) {
  try {
    var shown = String(at || '').indexOf('sending ') === 0 ? '' : String(at || '').substring(0, 16);
    if (partnerMasterSet_(partnerMasterRow_(shopId), PARTNER_SELF_LINK_COL, '送付済み ' + shown + '（リンクはグループだけ・消すと作り直し）')) {
      kvSet_(SELF_REG_CELL_PREFIX + shopId, String(at || ''));
      return true;
    }
  } catch (err) {
    Logger.log('⚠️ 本人登録リンクの記録: ' + err);
  }
  return false;
}

/**
 * 今のリンクが取り消されたか: true / false / null（確かめられない＝登録しない側）。取り消しになるのは:
 *   - リンクを送った後で、紹介者のグループが変わった（作り直し・別グループで /register）
 *   - 店マスター「本人登録リンク」を消した（「送付済み」を書けていた時だけ。列が消えていたら確かめられない）
 *   - このリンクで登録した本人の「本人chat_id」を消した（違う人が登録された時はこれだけで取り消せる・2026-10-27 レビュー）
 */
function selfLinkRevoked_(shopId) {
  var cellMark = kvGet_(SELF_REG_CELL_PREFIX + shopId);
  var used = kvGet_(SELF_REG_USED_PREFIX + shopId);
  var sentGid = kvGet_(SELF_REG_GID_PREFIX + shopId);
  try {
    if (sentGid) {
      var gid = partnerGroupChatId_(shopId);
      if (gid && String(gid) !== String(sentGid)) return true;
    }
    if (!cellMark && !used) return false;
    var mr = partnerMasterRow_(shopId);
    if (!mr) return null;
    if (cellMark) {
      if (mr.head.indexOf(PARTNER_SELF_LINK_COL) < 0) return null;
      if (!String(partnerMasterCell_(mr, PARTNER_SELF_LINK_COL) || '').trim()) return true;
    }
    if (used) {
      if (mr.head.indexOf(PARTNER_SELF_CHAT_COL) < 0) return null;
      if (!String(partnerMasterCell_(mr, PARTNER_SELF_CHAT_COL) || '').trim()) return true;
    }
    return false;
  } catch (err) {
    Logger.log('⚠️ selfLinkRevoked_: ' + err);
    return null;
  }
}

/** 取り消された人（このリンクで本人になり、あとで「本人chat_id」を消された人）。本人登録リンクでは二度と本人にしない */
function selfRegDenied_(shopId, chatId) {
  var v = String(kvGet_(SELF_REG_DENY_PREFIX + shopId) || '');
  return (',' + v + ',').indexOf(',' + String(chatId) + ',') >= 0;
}

function addSelfRegDeny_(shopId, chatId) {
  if (!chatId || selfRegDenied_(shopId, chatId)) return;
  var v = String(kvGet_(SELF_REG_DENY_PREFIX + shopId) || '');
  kvSet_(SELF_REG_DENY_PREFIX + shopId, v ? v + ',' + chatId : String(chatId));
}

/** 「送信中」の印がまだ新しいか（10分以内） */
function partnerSendingFresh_(v) {
  var s = String(v || '');
  if (s.indexOf('sending ') !== 0) return false;
  var stale = Utilities.formatDate(new Date(new Date().getTime() - PARTNER_SEND_STALE_MIN * 60 * 1000), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
  return s.substring('sending '.length) > stale;
}

/** 送った日時（'sending …' は送信中＝まだ送っていないので ''） */
function partnerSentAt_(key) {
  var v = String(kvGet_(key) || '');
  return v.indexOf('sending ') === 0 ? '' : v;
}

/**
 * 送る前に印を取る（即時送信と毎時の安全網が重なっても1回だけ送る）。取れたら { prev } / 取れなければ null
 * （送信済み・ほかの実行が送信中・状態タブか退避を読めない・印を残せない）
 *   印は 'sending <日時>' → 送れたら送った日時、送れなかったら元に戻す（partnerSendDone_）。止まった実行の 'sending' は10分で取り直せる
 */
function partnerSendClaim_(key, force) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5 * 1000)) return null;
  try {
    var cur;
    try {
      cur = String(kvGetStrict_(key, true) || '');   // ロックの中はタブを読み直す（直前に読んだ古い内容で「未送信」と読まない）
    } catch (err) {
      // 状態タブを読めない時は「未送信」と読まずに送らない（取り消せない送信・毎時の安全網が再試行。2026-10-31）
      Logger.log('⚠️ 送付印を読めないので送らない: ' + key + ' ' + err);
      kvWarn_('warn_partner_send_kv_unreadable', '⚠️ v7 Database「状態」タブ（または退避 kv_retreat_v1）を読めないため、個人提携のグループへの' +
        'チラシ・本人登録リンクを保留しました（毎時の安全網が再試行）。「状態」タブが開けるか確かめてください\n' + key + '\n' + err);
      return null;
    }
    if (cur.indexOf('sending ') === 0) {
      if (partnerSendingFresh_(cur)) return null;
    } else if (cur && !force) {
      return null;
    }
    // 印を残せなかった時は送らない（送ったあとに印も残せないと、毎時の安全網が送り直す）
    if (!kvSet_(key, 'sending ' + Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss'))) return null;
    return { prev: cur.indexOf('sending ') === 0 ? '' : cur };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/** 印を確定する。送れたら送った日時（を返す）、送れなかったら印を元に戻して '' */
function partnerSendDone_(key, claim, ok) {
  if (ok) {
    var at = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
    kvSet_(key, at);
    return at;
  }
  if (claim && claim.prev) kvSet_(key, claim.prev); else kvDelete_(key);
  return '';
}

// シートに書く名前の無害化 sheetSafeText_ は SheetHelpers.gs の共通版を使う（2026-10-27 一本化）

function selfRegLinkFromToken_(tok) {
  return 'https://t.me/' + SHOP_LINK_BOT_USERNAME + '?start=self_' + tok;
}

/** 本人登録リンク */
function selfRegLinkFor_(shopId) {
  return selfRegLinkFromToken_(selfRegTokenFor_(shopId));
}

/**
 * リンクを作り直す（前のリンクを使えなくする）。このリンクで登録していた人は取り消された人として覚える（同じリンクの系統では本人にしない）。
 * 新しいリンクは「送り待ち」の印を付け、毎時の安全網が送れるまで送る（7日の枠に関係なく）。
 * @return {boolean} 作り直した時 true（リンクの送信中で作り直せない時は false＝次の回に）
 */
function rotateSelfRegToken_(shopId) {
  var id = String(shopId || '').trim();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5 * 1000)) return false;
  try {
    if (partnerSendingFresh_(kvGet_(SELF_REG_SENT_PREFIX + id))) return false;   // ほかの実行がリンクを送信中
    var used = kvGet_(SELF_REG_USED_PREFIX + id);
    if (used) addSelfRegDeny_(id, used);
    // この紹介者の token をすべて消す（取り違えで2本できていても残さない）
    var all = kvGetAll_(SELF_REG_TOKEN_PREFIX);
    Object.keys(all).forEach(function(k) {
      if (String(all[k]) === id) kvDelete_(k);
    });
    [SELF_REG_SHOP_PREFIX, SELF_REG_SENT_PREFIX, SELF_REG_CELL_PREFIX, SELF_REG_GID_PREFIX, SELF_REG_USED_PREFIX].forEach(function(p) {
      kvDelete_(p + id);
    });
    kvSet_(SELF_REG_NEED_PREFIX + id, Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss'));
    return true;
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/**
 * 本人登録リンクを作り直して、その紹介者の連携済みグループへ今すぐ送る（GAS エディタで実行）。前のリンクはすぐ使えなくなる。
 * 使う時: グループを作り直して /register し直した時・違う人が登録された時（先に店マスター「本人chat_id」を消す）。本人登録済みなら何もしない。
 * 送れなかった時は毎時の安全網が送り続ける
 */
function sendSelfRegLinkNow(shopId) {
  var id = String(shopId || '').trim();
  var gid = partnerGroupChatId_(id);
  if (!gid) { Logger.log('⚠️ 連携済みのグループが無い: ' + id); return false; }
  refreshPartnerKinds_();
  var info = individualPartnerInfo_(id);
  if (!info) { Logger.log('⚠️ 個人提携として読めない（店マスター）: ' + id); return false; }
  if (info.kind === 'restaurant') { Logger.log('ℹ️ 飲食店には本人登録リンクを送らない（2026-10-29）: ' + id); return false; }
  if (info.selfChat) { Logger.log('ℹ️ 本人登録済み（作り直すなら先に店マスター「' + PARTNER_SELF_CHAT_COL + '」を消す）: ' + id); return false; }
  if (!(selfRegPctFor_(info) > 0)) { Logger.log('ℹ️ 本人割引が 0% の配分なので、本人登録リンクは送らない: ' + id); return false; }
  if (!rotateSelfRegToken_(id)) { Logger.log('⚠️ 本人登録リンクの送信中です。少し待ってからもう一度: ' + id); return false; }
  var r = sendSelfRegLinkOnce_(id, gid);
  if (r === 'sent') kvDelete_(SELF_REG_NEED_PREFIX + id);
  Logger.log((r === 'sent' ? '🔑 本人登録リンクを作り直して送った: ' : '⚠️ いま送れなかった（毎時の安全網が送る）: ') + id);
  return r === 'sent';
}

/** 紹介者ご本人の割引率（紹介料率＋紹介割引・30%まで） */
function selfRegPctFor_(info) {
  if (!info) return 0;
  var rate = Number(info.rate);
  if (!isFinite(rate) || rate < 0) rate = 30;
  var disc = (typeof effectiveReferralDiscount_ === 'function') ? effectiveReferralDiscount_(info, '') : 0;
  return Math.min(REFERRAL_TOTAL_CAP_PCT, Math.round((rate + disc) * 100) / 100);
}

/** グループに送る本人登録リンクの案内 */
function selfRegGroupText_(name, pct, link, langs) {
  var n = String(name || '').trim() || 'Partner';
  var off = Number(pct) > 0 ? Number(pct) : 0;
  return individualText_(langs, {
    ja: '🔑 ' + n + ' さんの本人登録リンク\n' + link + '\n' +
      '最初にこのリンクを開いた方が、' + n + ' さんご本人として登録されます。' + n + ' さん以外は押さないでください。\n' +
      'リンクを開き、「START（開始）」ボタンが出たら押してください（出ない場合はそのままで大丈夫です）。返事が届くまで1分ほどかかることがあります。\n' +
      (off ? '登録のあと、ご自身のご予約は左下の Booking ボタンから、予約の時に ' + off + '% 引きになります。\n' : '') +
      '※ お友達には、このリンクではなく紹介用のチラシ・URL をお渡しください。',
    en: '🔑 Registration link for ' + n + '\n' + link + '\n' +
      'The first person to open this link is registered as ' + n + '. Please do not tap it unless you are ' + n + '.\n' +
      'Open the link and tap "START" if it appears (if not, that\'s fine). The reply may take about a minute.\n' +
      (off ? 'After that, your own bookings from the Booking button get ' + off + '% off.\n' : '') +
      'For friends, please share the referral flyers / URL, not this link.',
    // クメール語は Panha 校閲（2026-10-28・provisional）。リンクはクメール語のかたまりにも入れる
    km: '🔑 តំណភ្ជាប់ចុះឈ្មោះសម្រាប់ ' + n + '\n' + link + '\n' +
      'អ្នកដំបូងគេដែលបើកតំណភ្ជាប់នេះ នឹងត្រូវបានចុះឈ្មោះជា ' + n + '។ សូមកុំចុច បើអ្នកមិនមែនជា ' + n + '។\n' +
      'សូមបើកតំណភ្ជាប់ ហើយចុចប៊ូតុង «START» បើមានបង្ហាញ (បើមិនបង្ហាញ ក៏មិនអីទេ)។ អាចត្រូវរង់ចាំប្រហែល 1 នាទី ទើបមានសារឆ្លើយតប។\n' +
      (off ? 'បន្ទាប់ពីនោះ ការកក់របស់អ្នកផ្ទាល់ តាមប៊ូតុង «Booking» នឹងបានបញ្ចុះតម្លៃ ' + off + '%។\n' : '') +
      'សម្រាប់មិត្តភក្តិ សូមចែករំលែកខិត្តប័ណ្ណ ឬ URL សម្រាប់ណែនាំ មិនមែនតំណភ្ជាប់នេះទេ។'
  });
}

/**
 * 個人提携のグループに、本人登録リンクを1回だけ送る（本人が未登録・割引がある時だけ）。送ったら店マスターに「送付済み」
 * @return {string|boolean} 今送った時 'sent'／送る必要が無い・送信済み・ほかの実行が送信中は true／送れなかった時 false
 */
function sendSelfRegLinkOnce_(shopId, groupChatId) {
  shopId = String(shopId || '').trim();
  if (!shopId || !groupChatId) return false;
  if (typeof individualPartnerState_ !== 'function' || individualPartnerState_(shopId) !== true) return true;   // 個人提携だけ
  var info = individualPartnerInfo_(shopId);
  if (!info || info.selfChat) return true;   // 登録済み
  if (info.kind === 'restaurant') return true;   // 飲食店は本人登録なし（2026-10-29）
  var pct = selfRegPctFor_(info);
  if (!(pct > 0)) return true;   // 本人割引が無い配分（紹介料率0・割引0）は登録しても意味が無い
  var key = SELF_REG_SENT_PREFIX + shopId;
  var claim = partnerSendClaim_(key, false);
  if (!claim) return true;
  var res = null;
  try {
    res = sendMessage(BOT_TYPE.BOOKING, groupChatId, selfRegGroupText_(info.name, pct, selfRegLinkFor_(shopId), individualGroupLangs_(shopId)),
      { disable_web_page_preview: true });
  } catch (err) {
    Logger.log('⚠️ 本人登録リンク: ' + err);
  }
  var at = partnerSendDone_(key, claim, !!(res && res.ok));
  if (!at) {
    Logger.log('⚠️ 本人登録リンク 送信失敗: ' + shopId + ' ' + JSON.stringify(res));
    warnOncePer_('warn_selfreg_send_failed_' + shopId, 6 * 60 * 60,
      '⚠️ ' + info.name + '（個人提携）のグループに本人登録リンクを送れていません（毎時再試行・6時間に1回お知らせ）。グループの連携・Bot がグループにいるかを確かめてください');
    return false;
  }
  kvSet_(SELF_REG_GID_PREFIX + shopId, String(groupChatId));   // このリンクはこのグループ用
  markSelfLinkCell_(shopId, at);
  Logger.log('🔑 本人登録リンク 送信: ' + shopId + ' → ' + groupChatId);
  return 'sent';
}

// ====== チラシ・紹介URL ======

/** 店マスター「紹介チラシURL」（改行・カンマ・空白区切り）→ https の URL（最大10件） */
function parsePartnerFlyerUrls_(v) {
  return String(v || '').split(/[\s,、，]+/).map(function(u) { return u.trim(); })
    .filter(function(u) { return /^https:\/\/\S+$/.test(u); }).slice(0, 10);
}

/** チラシの説明（チラシのすぐあと） */
function partnerFlyersText_(name, no, langs) {
  var n = String(name || '').trim() || 'Partner';
  return individualText_(langs, {
    ja: '📎 ご紹介用のチラシです（' + n + ' さん専用' + (no ? 'の番号 ' + no + ' と' : 'の') + ' QR 入り）\n' +
      '日本品質のカーケアに興味がありそうな方がいらっしゃったら、ぜひご紹介ください。' +
      'チラシの画像をそのまま転送するか、このあとに送る URL を送っていただければ大丈夫です。\n\n' +
      '【資料の内容】\n・アニメ風チラシ（A4）：出張の流れと主な料金\n・スマホ用カード：スマホでそのまま見やすい縦長の案内\n' +
      '・料金表（A4）：全メニューの料金\nそれぞれ日本語＋英語版と、クメール語＋英語版があります。お相手に合わせてお使いください。\n\n' +
      'QR か URL からご予約いただくと、' + n + ' さんのご紹介として自動で記録されます。',
    en: '📎 Referral flyers (with your own' + (no ? ' number ' + no + ' and' : '') + ' QR)\n' +
      'If you know anyone interested in Japanese-quality car care, please share them. ' +
      'Forward the images as they are, or send the URL coming next.\n\n' +
      '[What\'s included]\n- Illustrated flyer (A4): how our mobile service works and main prices\n' +
      '- Phone card: an easy-to-read vertical guide\n- Price list (A4): all menus and prices\n' +
      'Each comes in Japanese + English and Khmer + English. Use whichever suits your friend.\n\n' +
      'Bookings made through the QR or URL are recorded as your referrals automatically.',
    // クメール語は Panha 校閲（2026-10-28・provisional）
    km: '📎 ខិត្តប័ណ្ណសម្រាប់ណែនាំ (មាន' + (no ? ' លេខ ' + no + ' និង' : '') + ' QR របស់អ្នកផ្ទាល់)\n' +
      'បើអ្នកស្គាល់អ្នកដែលចាប់អារម្មណ៍ចំពោះការថែទាំរថយន្តគុណភាពជប៉ុន សូមណែនាំពួកគេមកយើង។ ' +
      'សូមផ្ញើបន្តរូបភាពទាំងនេះដោយមិនកែប្រែ ឬផ្ញើ URL ដែលនឹងមកដល់បន្ទាប់។\n\n' +
      '[អ្វីដែលរួមបញ្ចូល]\n- ខិត្តប័ណ្ណរូបគំនូរ (A4)៖ ដំណើរការនៃសេវាដល់ទីតាំងរបស់យើង និងតម្លៃសំខាន់ៗ\n' +
      '- កាតសម្រាប់ទូរស័ព្ទ៖ ការណែនាំបញ្ឈរដែលងាយអាន\n- តារាងតម្លៃ (A4)៖ មុខសេវា និងតម្លៃទាំងអស់\n' +
      'ទាំងបីមានកំណែ ភាសាជប៉ុន + ភាសាអង់គ្លេស និងកំណែ ភាសាខ្មែរ + ភាសាអង់គ្លេស។ សូមប្រើកំណែណាដែលសមនឹងមិត្តភក្តិរបស់អ្នក។\n\n' +
      'ការកក់ដែលធ្វើតាម QR ឬ URL យើងនឹងកត់ត្រាជាការណែនាំរបស់អ្នកដោយស្វ័យប្រវត្តិ។'
  });
}

/**
 * 個人提携のグループに、チラシ（アルバム）＋説明＋紹介URL を1回だけ送る。
 * 店マスター「紹介チラシURL」が空なら送らず管理グループに知らせる（立ち上げの時に Claude が書く）
 * @param {Object} [opts] - { force: true } で送り直し
 * @return {string|boolean} 今送った時 'sent'／送る必要が無い・送信済み・ほかの実行が送信中は true／チラシが未登録・別の紹介者のもの・送信失敗は false
 */
function sendIndividualFlyersOnce_(shopId, groupChatId, opts) {
  opts = opts || {};
  shopId = String(shopId || '').trim();
  if (!shopId || !groupChatId) return false;
  if (typeof individualPartnerState_ !== 'function' || individualPartnerState_(shopId) !== true) return true;
  if (typeof isRestaurantPartnerShop_ === 'function' && isRestaurantPartnerShop_(shopId)) return true;   // 飲食店はチラシを Bot から送らない（2026-10-29）
  var key = PARTNER_FLYERS_SENT_PREFIX + shopId;
  var claim = partnerSendClaim_(key, !!opts.force);
  if (!claim) return true;   // 送信済み・ほかの実行が送信中（即時送信と毎時の安全網が重なっても1回だけ）
  var r = null, urls = [], album = null, wrong = '';
  try {
    r = partnerMasterRow_(shopId);
    urls = parsePartnerFlyerUrls_(partnerMasterCell_(r, PARTNER_FLYER_URL_COL));
    wrong = r ? partnerFlyerMismatch_(r, shopId, urls) : '';
    if (urls.length && !wrong) {
      album = urls.length === 1
        ? sendPhoto(BOT_TYPE.BOOKING, groupChatId, urls[0])
        : sendMediaGroup(BOT_TYPE.BOOKING, groupChatId, urls.map(function(u) { return { type: 'photo', media: u }; }));
    }
  } catch (err) {
    Logger.log('⚠️ 紹介チラシ: ' + err);
  }
  var sentAt = partnerSendDone_(key, claim, !!(album && album.ok));
  if (!r) {
    Logger.log('⚠️ 紹介チラシ: 店マスターの行を読めない（毎時の安全網で再試行）: ' + shopId);
    return false;
  }
  var name = String(partnerMasterCell_(r, '店名') || '').trim() || shopId;
  if (!urls.length) {
    warnOncePer_('warn_partner_flyers_missing_' + shopId, 6 * 60 * 60,
      '⚠️ ' + name + '（個人提携）のグループにチラシを送れていません: 店マスター「' + PARTNER_FLYER_URL_COL + '」が空です。\n' +
      'チラシを作って URL を入れたら、毎時の安全網が送ります（あいさつ文から' + PARTNER_ONBOARD_RETRY_DAYS + '日以内）');
    return false;
  }
  if (wrong) {
    warnOncePer_('warn_partner_flyers_wrong_' + shopId, 6 * 60 * 60,
      '⚠️ ' + name + '（個人提携）のグループにチラシを送っていません: ' + wrong + '。\n' +
      '別の紹介者の URL を貼っていないか、店マスターの行を確かめてください（紹介料の取り違えを防ぐため）');
    return false;
  }
  if (!sentAt) {
    Logger.log('⚠️ 紹介チラシ 送信失敗: ' + shopId + ' ' + JSON.stringify(album));
    warnOncePer_('warn_partner_flyers_failed_' + shopId, 6 * 60 * 60,
      '⚠️ ' + name + '（個人提携）のグループへのチラシの送信に失敗しました（URL が開けない等）。「' + PARTNER_FLYER_URL_COL + '」の URL を確かめてください');
    return false;
  }
  var no = String(partnerMasterCell_(r, 'パートナーID') || '').trim();
  var ver = partnerFlyerVersion_(urls);
  var refUrl = String(partnerMasterCell_(r, 'QRリンク(BookingBot)') || '').trim() ||
    ('https://t.me/' + SHOP_LINK_BOT_USERNAME + '?start=shop_' + shopId);
  logPartnerFlyerSend_({
    '送った日時': sentAt, 'パートナーID': no, '名前': sheetSafeText_(name), 'shop_id': shopId, 'チラシの版': ver, '枚数': urls.length,
    '送り方': opts.force ? '予約Bot（送り直し）' : '予約Bot（自動）', '送り先（グループchat_id）': String(groupChatId),
    'URL': urls.join('\n')
  });
  // 説明と紹介URL（転送しやすいよう URL だけの1通）。届かなかったら管理グループに URL を出す（紹介URLが一番大事な1通）
  var restOk = false;
  try {
    var d1 = sendMessage(BOT_TYPE.BOOKING, groupChatId, partnerFlyersText_(name, no, individualGroupLangs_(shopId)));
    var d2 = sendMessage(BOT_TYPE.BOOKING, groupChatId, refUrl);
    restOk = !!(d1 && d1.ok && d2 && d2.ok);
  } catch (err) {
    Logger.log('⚠️ 紹介チラシの説明・紹介URL: ' + err);
  }
  try {
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, '📎 ' + name + '（個人提携）のグループに、チラシ ' + ver + '・' + urls.length + '枚と紹介URLを送りました' +
      (restOk ? '' : '\n⚠️ チラシのあとの説明・紹介URLが届いていません。紹介URL: ' + refUrl + '（グループに手で貼ってください）'));
  } catch (ignore) {}
  return 'sent';
}

/**
 * 「紹介チラシURL」「QRリンク(BookingBot)」がこの紹介者のものか。違えば理由（''＝問題なし）。
 * 貼り間違えると友達の予約が別の人の紹介になる（紹介料の取り違え）ので、送る前に確かめる（2026-10-27 レビュー）
 */
function partnerFlyerMismatch_(r, shopId, urls) {
  var ref = String(partnerMasterCell_(r, 'QRリンク(BookingBot)') || '').trim();
  var tail = 'start=shop_' + shopId;
  if (ref && ref.slice(-tail.length) !== tail) return '「QRリンク(BookingBot)」が別の shop_id のリンク（' + ref + '）';
  var no = String(partnerMasterCell_(r, 'パートナーID') || '').trim();
  if (!no) return '';
  var bad = (urls || []).filter(function(u) {
    var m = String(u).match(/\/partners\/([^\/]+)\//);
    return m && m[1] !== no;
  });
  return bad.length ? '「' + PARTNER_FLYER_URL_COL + '」に別の番号のチラシ（' + bad[0] + '・この紹介者は ' + no + '）' : '';
}

/**
 * チラシを作り直した（版を上げた）あと、店マスター「紹介チラシURL」を新しい版に替えてから GAS エディタで実行する。
 * 今の「紹介チラシURL」のチラシ＋説明＋紹介URLを、その紹介者の連携済みグループへもう一度送る（送付履歴に「送り直し」で1行）
 */
function resendPartnerFlyersNow(shopId) {
  var gid = partnerGroupChatId_(shopId);
  if (!gid) { Logger.log('⚠️ 連携済みのグループが無い: ' + shopId); return false; }
  if (typeof isRestaurantPartnerShop_ === 'function' && isRestaurantPartnerShop_(shopId)) {
    Logger.log('ℹ️ 飲食店のチラシは Bot から送らない（グループに手で送る・2026-10-29）: ' + shopId);
    return false;
  }
  var r = sendIndividualFlyersOnce_(shopId, gid, { force: true });
  Logger.log((r === 'sent' ? '📎 送り直した: ' : r ? '⚠️ ほかの実行が送信中か混み合っている。少し待ってもう一度: ' : '⚠️ 送れなかった（管理グループの知らせを見る）: ') + shopId);
  return r === 'sent';
}

// ====== 送付履歴（v7 Database「紹介チラシ送付履歴」・2026-10-27） ======
// Daisuke「どのバージョンを送ったのか履歴もしっかり GSS で管理してね」
//   予約Botがチラシを送るたびに1行（送れなかった時は書かない・管理グループに出る）。Daisuke が手で送った分は Claude が書き足す
//   版は「紹介チラシURL」のフォルダ名（…/partners/<番号>/<版>/…・Day1 publish_referral_set.py が作る）から読む。
//   版ごとの変わったところは「紹介チラシの版」タブ（Claude が書く）。営業ボード「🙋 個人提携」タブが最後に送った版と日を表示する
var PARTNER_FLYER_LOG_SHEET = '紹介チラシ送付履歴';
var PARTNER_FLYER_LOG_HEADERS = ['送った日時', 'パートナーID', '名前', 'shop_id', 'チラシの版', '枚数', '送り方',
  '送り先（グループchat_id）', 'URL', 'メモ'];

/** URL のフォルダ名から版（v1.0 など）。分からない URL は「不明」。版が混ざっていれば「・」でつなぐ */
function partnerFlyerVersion_(urls) {
  var seen = [];
  (urls || []).forEach(function(u) {
    var m = String(u).match(/\/partners\/[^\/]+\/(v\d+(?:\.\d+)*)\//);
    var v = m ? m[1] : '不明';
    if (seen.indexOf(v) < 0) seen.push(v);
  });
  return seen.length ? seen.join('・') : '不明';
}

/** 送付履歴に1行（シートが無ければ作る・見出しの名前で列を合わせる）。書けなくても送信は止めない */
function logPartnerFlyerSend_(row) {
  try {
    var ss = getSpreadsheet();
    var sh = ss.getSheetByName(PARTNER_FLYER_LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(PARTNER_FLYER_LOG_SHEET);
      sh.getRange(1, 1, 1, PARTNER_FLYER_LOG_HEADERS.length).setValues([PARTNER_FLYER_LOG_HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(function(h) { return String(h).trim(); });
    sh.appendRow(head.map(function(h) { return sheetSafeValue_(Object.prototype.hasOwnProperty.call(row, h) ? row[h] : ''); }));
  } catch (err) {
    Logger.log('⚠️ 紹介チラシ送付履歴に書けない: ' + err);
  }
}

/**
 * 個人提携の立ち上げの続き（はじめのご案内のあと）: チラシ＋紹介URL → 本人登録リンク。
 * ShopGroupGreeting.gs sendShopGroupGreetingOnce_ がロックを外したあとに呼ぶ
 */
function sendIndividualOnboardingRest_(shopId, groupChatId) {
  try { sendIndividualFlyersOnce_(shopId, groupChatId); } catch (err) { Logger.log('⚠️ 紹介チラシ: ' + err); }
  try { sendSelfRegLinkOnce_(shopId, groupChatId); } catch (err) { Logger.log('⚠️ 本人登録リンク: ' + err); }
}

/**
 * 安全網（毎時・sendPendingShopGreetings から）。紹介者ごとに（1件の失敗で他を止めない）:
 *   1. 本人が未登録で、今のリンクが取り消されていたら（「本人登録リンク」「本人chat_id」を消した・グループが変わった）作り直す
 *      （送った時の書き込みに失敗していただけなら、作り直さず「送付済み」を書き直す）
 *   2. 作り直したリンクの送り待ちは、送れるまで毎時送る（7日の枠に関係なく。Hiro さん等の既存グループでも）
 *   3. 最初の送り残し: この版より後にあいさつ文を送ったグループで、あいさつ文から7日以内なら、チラシ・本人登録リンクを送る
 */
function sendPendingIndividualOnboarding_() {
  var since = Utilities.formatDate(new Date(new Date().getTime() - PARTNER_ONBOARD_RETRY_DAYS * 24 * 60 * 60 * 1000), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
  var sent = 0;
  readShopLinks_().forEach(function(r) {
    try {
      var o = r.obj;
      if (String(o['状態'] || '') !== '連携済') return;
      var shopId = String(o['shop_id'] || '').trim(), gid = String(o['グループchat_id'] || '');
      if (!shopId || !gid) return;
      if (typeof individualPartnerState_ !== 'function' || individualPartnerState_(shopId) !== true) return;
      var info = individualPartnerInfo_(shopId);
      if (!info || info.kind === 'restaurant') return;   // 飲食店はチラシ・本人登録リンクを送らない（2026-10-29）
      // 1. 取り消し → 作り直し（送信中の 'sending' は送ったとみなさない）
      if (!info.selfChat && kvGet_(SELF_REG_SHOP_PREFIX + shopId) && partnerSentAt_(SELF_REG_SENT_PREFIX + shopId)) {
        var mr = partnerMasterRow_(shopId);
        var cellEmpty = !!mr && mr.head.indexOf(PARTNER_SELF_LINK_COL) >= 0 && !String(partnerMasterCell_(mr, PARTNER_SELF_LINK_COL) || '').trim();
        if (cellEmpty && !kvGet_(SELF_REG_CELL_PREFIX + shopId) && !kvGet_(SELF_REG_USED_PREFIX + shopId)) {
          markSelfLinkCell_(shopId, partnerSentAt_(SELF_REG_SENT_PREFIX + shopId));   // 書き込みに失敗していただけ（消されたのではない）
        } else if (selfLinkRevoked_(shopId) === true) {
          rotateSelfRegToken_(shopId);   // 送り待ちの印を付ける（送信中なら次の回）
        }
      }
      // 2. 作り直したリンクの送り待ち（送れるまで毎時）
      if (kvGet_(SELF_REG_NEED_PREFIX + shopId)) {
        if (info.selfChat) { kvDelete_(SELF_REG_NEED_PREFIX + shopId); return; }
        if (sendSelfRegLinkOnce_(shopId, gid) === 'sent') {
          kvDelete_(SELF_REG_NEED_PREFIX + shopId);
          sent++;
          try { sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, '🔑 ' + info.name + '（個人提携）の本人登録リンクを作り直して送りました（前のリンクは使えません）'); } catch (ignore) {}
        }
        return;
      }
      // 3. 最初の送り残し（既存のグループ・7日より前は送らない）
      var greetAt = String(kvGet_(SHOP_GREETING_PROP_PREFIX + shopId) || '');
      // 日時は文字の並びで比べるので、yyyy-MM-dd HH:mm:ss の形でなければ送らない（安全側。2026-10-31 日付に化けた値で再送した不具合）
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(greetAt)) {
        if (greetAt) Logger.log('⚠️ チラシ・本人登録リンク保留（あいさつ文の日時が読めない）: ' + shopId + ' ' + greetAt);
        return;
      }
      if (greetAt < PARTNER_ONBOARD_SINCE || greetAt < since) return;
      sendIndividualFlyersOnce_(shopId, gid);   // 送信済み・送信中なら何もしない（印は関数の中で取る）
      if (sendSelfRegLinkOnce_(shopId, gid) === 'sent') sent++;
    } catch (err) {
      Logger.log('⚠️ sendPendingIndividualOnboarding_（' + String((r && r.obj && r.obj['shop_id']) || '') + '）: ' + err);
    }
  });
  if (sent > 0) Logger.log('🔑 sendPendingIndividualOnboarding_: ' + sent + '件');
  return sent;
}

// ====== 登録（/start self_<token>） ======

/**
 * 店マスターの「本人chat_id」に書く（書く直前にセルを読み直す・書いたら flush）。本人の名前・登録日時の列があれば一緒に書く。
 * 「本人chat_id」が書けたら登録できた扱い（名前・日時・「本人登録リンク」の書き込みに失敗しても、割引は効くので登録として知らせる）
 * @return {string} 'registered' / 'already' / 'taken:<登録済みの chat_id>' / 'failed'
 */
function writeSelfChatToMaster_(shopId, chatId, who) {
  var r = partnerMasterRow_(shopId);
  if (!r || r.head.indexOf(PARTNER_SELF_CHAT_COL) < 0) return 'failed';
  var cur = String(partnerMasterCell_(r, PARTNER_SELF_CHAT_COL) || '').trim();
  if (cur === String(chatId)) return 'already';
  if (cur) return 'taken:' + cur;
  if (!partnerMasterSet_(r, PARTNER_SELF_CHAT_COL, String(chatId))) return 'failed';
  // このリンクで本人になった人（「本人chat_id」を消したら、このリンクは取り消し・この人は本人登録リンクで戻れない）
  kvSet_(SELF_REG_USED_PREFIX + shopId, String(chatId));
  try {
    var at = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm');
    partnerMasterSet_(r, PARTNER_SELF_NAME_COL, sheetSafeText_(who || ''));
    partnerMasterSet_(r, PARTNER_SELF_AT_COL, at);
    partnerMasterSet_(r, PARTNER_SELF_LINK_COL, '登録に使用済み ' + at + '（違う人なら「本人chat_id」を消す → 新しいリンクを送る）');
  } catch (err) {
    Logger.log('⚠️ 本人の名前・登録日時の記録: ' + err);
  }
  try { SpreadsheetApp.flush(); } catch (ignore) {}   // ロックを外す前に書き込みを確定（並走した実行から見えるように）
  return 'registered';
}

/** 個人提携の判定を読み直す（登録した chat_id をすぐ効かせる。5分キャッシュ・最後に読めた内容も新しくなる） */
function refreshPartnerKinds_() {
  try { CacheService.getScriptCache().remove(PARTNER_KIND_CACHE_KEY); } catch (ignore) {}
  __partnerKindMemo_ = null;
  __partnerKindFresh_ = false;
  try { readPartnerKinds_(true); } catch (err) { Logger.log('⚠️ refreshPartnerKinds_: ' + err); }
}

/** Telegram の表示名と @ユーザー名（通知・店マスター用） */
function selfRegWho_(msg) {
  var f = msg.from || {};
  var name = ((f.first_name || '') + ' ' + (f.last_name || '')).trim() || 'Customer';
  return name + (f.username ? ' @' + f.username : '');
}

/**
 * 管理グループのメンバー（スタッフ・Daisuke）か: true / false / null（確かめられない）。
 * 予約Botは管理グループの管理者（トピックを作るため）なので getChatMember で確かめられる
 */
function isAdminGroupMember_(userId) {
  try {
    var uid = /^\d+$/.test(String(userId)) ? Number(userId) : String(userId);
    var res = callTelegramApi(BOT_TYPE.BOOKING, 'getChatMember', { chat_id: getConfig().adminGroupId, user_id: uid });
    if (!res || !res.ok || !res.result) {
      // 一度も入ったことの無い人は「user not found」等で ok=false になることがある → メンバーではない
      var desc = String((res && res.description) || '');
      return /user not found|member not found|PARTICIPANT_ID_INVALID/i.test(desc) ? false : null;
    }
    var st = String(res.result.status || '');
    return st === 'creator' || st === 'administrator' || st === 'member' || (st === 'restricted' && res.result.is_member === true);
  } catch (err) {
    Logger.log('⚠️ isAdminGroupMember_: ' + err);
    return null;
  }
}

/**
 * 紹介者のグループ（Bot連携で連携済み）のメンバーか: true / false / null（確かめられない・グループ未連携）。
 * 2026-10-27 レビュー: リンクが外に出ても、グループの外の人は本人にしない。Bot がグループの管理者でないと確かめられないことがある（null）
 */
function isPartnerGroupMember_(shopId, userId) {
  var gid = partnerGroupChatId_(shopId);
  if (!gid) return null;
  try {
    var uid = /^\d+$/.test(String(userId)) ? Number(userId) : String(userId);
    var res = callTelegramApi(BOT_TYPE.BOOKING, 'getChatMember', { chat_id: String(gid), user_id: uid });
    if (!res || !res.ok || !res.result) {
      var desc = String((res && res.description) || '');
      return /user not found|member not found|PARTICIPANT_ID_INVALID/i.test(desc) ? false : null;
    }
    var st = String(res.result.status || '');
    if (st === 'left' || st === 'kicked') return false;
    if (st === 'restricted') return res.result.is_member === true;
    return (st === 'creator' || st === 'administrator' || st === 'member') ? true : null;
  } catch (err) {
    Logger.log('⚠️ isPartnerGroupMember_: ' + err);
    return null;
  }
}

/** ほかの個人提携の本人として登録済みなら、その紹介者の名前（無ければ ''） */
function selfChatUsedElsewhere_(chatId, shopId) {
  var map = readPartnerKinds_() || {};
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var p = map[keys[i]];
    if (keys[i] !== shopId && p && String(p.selfChat || '') === String(chatId)) return p.name || keys[i];
  }
  return '';
}

/** 本人あて・グループあての文面 */
var SELF_REG_TEXT = {
  busy: { ja: '⏳ 混み合っています。少し待ってから、もう一度リンクを開いてください。', en: '⏳ Busy, please open the link again in a minute.' },
  invalid: { ja: '⚠️ このリンクは使えません（古いリンクの可能性があります）。お手数ですが SAMURAI MOTORS にご連絡ください。',
             en: '⚠️ This link is not valid (it may be an old link). Please contact SAMURAI MOTORS.' },
  taken: { ja: 'ℹ️ このリンクは、すでにご本人の登録に使われています。お心当たりがない場合は SAMURAI MOTORS にご連絡ください。',
           en: 'ℹ️ This link has already been used for registration. If this is unexpected, please contact SAMURAI MOTORS.' },
  staff: { ja: 'ℹ️ SAMURAI MOTORS のスタッフの方は、紹介者ご本人として登録されません（このままで大丈夫です）。',
           en: 'ℹ️ SAMURAI MOTORS staff are not registered as the partner (no action needed).' },
  unknown: { ja: '⏳ いま確認ができませんでした。少し時間をおいて、もう一度リンクを開いてください。',
             en: '⏳ We could not confirm right now. Please open the link again a little later.' },
  notInGroup: { ja: 'ℹ️ この登録は、紹介パートナーのグループに入っている方だけができます。グループに入ってから、もう一度リンクを開いてください。',
                en: 'ℹ️ Only members of the partner group can register. Please join the group, then open the link again.' },
  revoked: { ja: '⚠️ このリンクは使えなくなりました。新しいリンクがグループに届きますので、そちらを開いてください。',
             en: '⚠️ This link is no longer valid. A new link will be sent to the group — please open that one.' },
  failed: { ja: '⚠️ 登録できませんでした。SAMURAI MOTORS からご連絡します。', en: '⚠️ We could not register you. SAMURAI MOTORS will contact you.' }
};

/** 本人あて（登録できた・登録済み） */
function selfRegUserText_(name, pct, already, langs) {
  return individualText_(langs, {
    ja: (already ? '✅ 紹介パートナー「' + name + '」さんのご本人として、登録済みです。'
                 : '✅ ご登録ありがとうございました！紹介パートナー「' + name + '」さんのご本人として登録しました。') +
      (pct > 0 ? '\nご自身のご予約は、左下の Booking ボタンから予約の時に ' + pct + '% 引きになります。'
               : '\nご自身のご予約の扱いは、SAMURAI MOTORS が確認してご連絡します。'),
    en: (already ? '✅ You are already registered as the partner "' + name + '".'
                 : '✅ Thank you! You are now registered as the partner "' + name + '".') +
      (pct > 0 ? '\nYour own bookings from the Booking button get ' + pct + '% off.'
               : '\nSAMURAI MOTORS will confirm how your own bookings are handled.')
  });
}

/** グループあて（登録が完了した・お礼） */
function selfRegGroupDoneText_(name, pct, who, langs) {
  return individualText_(langs, {
    ja: '✅ ご登録ありがとうございました！\n' + name + ' さんご本人の登録が完了しました（Telegram: ' + who + '）。\n' +
      (pct > 0 ? 'ご自身のご予約は、左下の Booking ボタンから予約の時に ' + pct + '% 引きになります。\n' : '') +
      'これからどうぞよろしくお願いします！\n（違う方が登録された場合は、SAMURAI MOTORS にご連絡ください）',
    en: '✅ Thank you for registering!\nRegistration for ' + name + ' is complete (Telegram: ' + who + ').\n' +
      (pct > 0 ? 'Your own bookings from the Booking button get ' + pct + '% off.\n' : '') +
      'We look forward to working with you!\n(If this is not you, please contact SAMURAI MOTORS.)',
    // クメール語は Panha 校閲（2026-10-28・provisional）
    km: '✅ សូមអរគុណដែលបានចុះឈ្មោះ!\nការចុះឈ្មោះសម្រាប់ ' + name + ' រួចរាល់ហើយ (Telegram: ' + who + ')។\n' +
      (pct > 0 ? 'ការកក់របស់អ្នកផ្ទាល់ តាមប៊ូតុង «Booking» នឹងបានបញ្ចុះតម្លៃ ' + pct + '%។\n' : '') +
      'យើងរីករាយនឹងបានសហការជាមួយអ្នក!\n(បើមិនមែនជាអ្នកទេ សូមទាក់ទងមក SAMURAI MOTORS។)'
  });
}

/** 失敗しても次へ進む（通知・歓迎文・トピック作成を互いに止めない） */
function selfRegSafe_(label, fn) {
  try { fn(); } catch (err) { Logger.log('⚠️ 本人登録（' + label + '）: ' + err); }
}

/**
 * 本人登録リンクからの /start。処理したら true（self_ で始まらなければ false）
 * 知らせ（管理グループ・紹介者のグループ）を先に送り、本人あての返事・歓迎文・トピック作成はそのあと（どれかが失敗しても知らせは消えない）
 */
function handleSelfRegStart_(msg, text) {
  var m = String(text || '').match(/^\/start\s+self_([A-Za-z0-9]{8,40})$/);
  if (!m) return false;
  var chatId = String(msg.chat.id);
  var who = selfRegWho_(msg);
  var shopId = String(kvGet_(SELF_REG_TOKEN_PREFIX + m[1]) || '').trim();
  selfRegSafe_('ファネル', function() {
    if (typeof logFunnelEvent === 'function') logFunnelEvent(chatId, 'selfreg_start', 'selfreg:' + (shopId || '?'), '', null);
  });
  var admin = function(t) { selfRegSafe_('管理通知', function() { sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, t); }); };
  var reply = function(t) { selfRegSafe_('本人あて', function() { sendMessage(BOT_TYPE.BOOKING, chatId, t); }); };
  var welcome = function(opts) {
    selfRegSafe_('歓迎文', function() { sendWelcomeMessage(msg, opts); });
    selfRegSafe_('トピック', function() { ensureCustomerTopic(msg); });
  };

  var state = (shopId && typeof individualPartnerState_ === 'function') ? individualPartnerState_(shopId) : false;
  if (shopId && state === null) {
    // 店マスターを一時的に読めない（リンクは正しいかもしれない）→「少し待って」
    admin('⚠️ 本人登録リンク: 店マスターを読めず、登録していない（本人なら少し待って押し直してもらう）\n顧客: ' + who +
      '（chat_id=' + chatId + '）\nshop_id: ' + shopId);
    reply(individualText_(INDIVIDUAL_LANG_DEFAULT, SELF_REG_TEXT.unknown));
    return true;
  }
  var valid = !!shopId && state === true && !!validPartnerShopId_(shopId) &&
    !(typeof isRestaurantPartnerShop_ === 'function' && isRestaurantPartnerShop_(shopId));   // 飲食店は本人登録なし（2026-10-29）
  if (!valid) {
    // 知らない token を何度も送られても管理グループを埋めない（同じ人は10分に1回）
    warnOncePer_('warn_selfreg_invalid_' + chatId, 10 * 60,
      '⚠️ 本人登録リンクから来たが、登録しなかった（リンクが古い・個人提携でない・停止中のいずれか）\n顧客: ' + who +
      '（chat_id=' + chatId + '）\nshop_id: ' + (shopId || '（リンクの token が見つからない）'));
    reply(individualText_(INDIVIDUAL_LANG_DEFAULT, SELF_REG_TEXT.invalid));
    welcome();
    return true;
  }
  var langs = individualGroupLangs_(shopId);
  var name0 = (individualPartnerInfo_(shopId) || {}).name || shopId;

  // 紹介者のグループが連携済みでない間（作り直し中・停止）は登録しない（グループのメンバーか確かめられないため）
  if (!partnerGroupChatId_(shopId)) {
    admin('⚠️ 本人登録リンク: 紹介者のグループが連携済みでないので、登録していない（作り直し中なら、新しいグループで /register のあと sendSelfRegLinkNow）\n' +
      '紹介者: ' + name0 + '（' + shopId + '）\n開いた人: ' + who + '（chat_id=' + chatId + '）');
    reply(individualText_(langs, SELF_REG_TEXT.revoked));
    return true;
  }
  // 取り消されたリンク（「本人登録リンク」か「本人chat_id」を消した・グループが変わった）。すぐ効く。新しいリンクは毎時の安全網か sendSelfRegLinkNow で届く
  var revoked = selfLinkRevoked_(shopId);
  if (revoked !== false) {
    admin((revoked ? '⚠️ 本人登録リンク: 取り消したリンク（「' + PARTNER_SELF_LINK_COL + '」か「' + PARTNER_SELF_CHAT_COL + '」を消した・グループが変わった）が開かれた（登録していない）'
                   : '⚠️ 本人登録リンク: 店マスターを読めず、登録していない（本人なら少し待って押し直してもらう）') +
      '\n紹介者: ' + name0 + '（' + shopId + '）\n開いた人: ' + who + '（chat_id=' + chatId + '）');
    reply(individualText_(langs, revoked ? SELF_REG_TEXT.revoked : SELF_REG_TEXT.unknown));
    return true;
  }
  // 本人から外した人（違う人が登録されて「本人chat_id」を消した）は、本人登録リンクでは戻さない
  if (selfRegDenied_(shopId, chatId)) {
    admin('⚠️ 本人登録リンク: 本人から外した人が開いた（登録していない）\n紹介者: ' + name0 + '（' + shopId + '）\n' +
      '開いた人: ' + who + '（chat_id=' + chatId + '）\n→ この人を本人に戻すなら、店マスター「' + PARTNER_SELF_CHAT_COL + '」に ' + chatId + ' を手で入れる');
    reply(individualText_(langs, SELF_REG_TEXT.taken));
    welcome();
    return true;
  }

  // スタッフ（管理グループのメンバー）は本人にしない。確かめられない時も登録しない（あとで押し直してもらう）
  var staff = isAdminGroupMember_(chatId);
  if (staff !== false) {
    admin((staff ? 'ℹ️ 管理グループのメンバーが本人登録リンクを開いた（スタッフは本人にしない・登録していない）'
                 : '⚠️ 本人登録リンク: 管理グループのメンバーか確かめられず、登録していない（本人なら押し直してもらう）') +
      '\n紹介者: ' + name0 + '（' + shopId + '）\n開いた人: ' + who + '（chat_id=' + chatId + '）');
    reply(individualText_(langs, staff ? SELF_REG_TEXT.staff : SELF_REG_TEXT.unknown));
    if (staff) welcome();
    return true;
  }
  // 紹介者のグループに入っていない人は本人にしない（リンクが外に出ても安全に）。確かめられない時は登録し、管理グループに一言
  var inGroup = isPartnerGroupMember_(shopId, chatId);
  if (inGroup === false) {
    admin('⚠️ 本人登録リンク: 紹介者のグループに入っていない人が開いた（登録していない）\n紹介者: ' + name0 + '（' + shopId + '）\n' +
      '開いた人: ' + who + '（chat_id=' + chatId + '）\n→ 本人なら、グループに入ってからもう一度リンクを開いてもらう');
    reply(individualText_(langs, SELF_REG_TEXT.notInGroup));
    welcome();
    return true;
  }
  // ほかの紹介者の本人として登録済みの人は、別の紹介者の本人にしない
  var other = selfChatUsedElsewhere_(chatId, shopId);
  if (other) {
    admin('⚠️ 本人登録リンク: すでに別の紹介者（' + other + '）の本人として登録済みの人が開いた（登録していない）\n' +
      '紹介者: ' + name0 + '（' + shopId + '）\n開いた人: ' + who + '（chat_id=' + chatId + '）');
    reply(individualText_(langs, SELF_REG_TEXT.taken));
    welcome();
    return true;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    reply(individualText_(langs, SELF_REG_TEXT.busy));
    return true;
  }
  var result = '';
  try {
    // 確かめてからロックを取るまでに取り消されていないか、ロックの中でもう一度見る
    var rv = selfLinkRevoked_(shopId);
    result = rv === false ? writeSelfChatToMaster_(shopId, chatId, who) : (rv ? 'revoked' : 'failed');   // 書く直前に店マスターのセルを読み直す
  } catch (err) {
    Logger.log('⚠️ handleSelfRegStart_: ' + err);
    result = 'failed';
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
  if (result === 'registered') refreshPartnerKinds_();

  if (result === 'revoked') {
    admin('⚠️ 本人登録リンク: 開いた直後にリンクが取り消された（登録していない）\n紹介者: ' + name0 + '（' + shopId + '）\n開いた人: ' + who + '（chat_id=' + chatId + '）');
    reply(individualText_(langs, SELF_REG_TEXT.revoked));
    return true;
  }
  if (result.indexOf('taken:') === 0) {
    admin('⚠️ 本人登録リンクを、登録済みの本人とは別の人が開いた（上書きしていない）\n紹介者: ' + name0 + '（' + shopId + '）\n' +
      '登録済みの chat_id: ' + result.substring('taken:'.length) + '\n今回開いた人: ' + who + '（chat_id=' + chatId + '）\n' +
      '→ 登録済みの方が違う人なら、店マスター「' + PARTNER_SELF_CHAT_COL + '」を消す（このリンクは使えなくなり、新しいリンクが1時間以内にグループへ届く）');
    reply(individualText_(langs, SELF_REG_TEXT.taken));
    welcome();
    return true;
  }
  if (result !== 'registered' && result !== 'already') {
    admin('⚠️ 本人登録リンクから来たが、店マスターに書けなかった（「' + PARTNER_SELF_CHAT_COL + '」列が無い・行が無い・読めない）\n' +
      '紹介者: ' + name0 + '（' + shopId + '）\n開いた人: ' + who + '（chat_id=' + chatId + '）\n→ 本人なら店マスターに手で入れる');
    reply(individualText_(langs, SELF_REG_TEXT.failed));
    welcome();
    return true;
  }

  // 登録できた（または登録済み）: 本人割引の率（ほかの紹介者の紹介で来ていた人・読めない時は 0）
  var self = (typeof selfPartnerDiscount_ === 'function') ? selfPartnerDiscount_(chatId, chatId) : null;
  var pct = self ? self.pct : 0;
  if (result === 'registered') {
    // 先に知らせる: 紹介者のグループに「ご登録ありがとうございました」、管理グループに登録した人（グループに届いたかも）
    var groupOk = false;
    selfRegSafe_('グループへの知らせ', function() {
      var gid = partnerGroupChatId_(shopId);
      if (!gid) return;
      var res = sendMessage(BOT_TYPE.BOOKING, gid, selfRegGroupDoneText_(name0, pct, who, langs));
      groupOk = !!(res && res.ok);
    });
    admin('🔑 紹介者ご本人を自動登録しました（本人登録リンク）\n紹介者: ' + name0 + '（' + shopId + '）\n' +
      '登録した人: ' + who + '（chat_id=' + chatId + '）\n' +
      (pct > 0 ? '本人の予約は ' + pct + '%引き・紹介料なし' : '⚠️ 本人割引が 0（ほかの紹介者の紹介で来ていた・店マスターが読めない のどちらか）。確かめてご本人に連絡') +
      (inGroup === null ? '\n（紹介者のグループのメンバーか確かめられませんでした。名前が本人か確かめてください）' : '') +
      (groupOk ? '' : '\n⚠️ 紹介者のグループへの「ご登録ありがとうございました」が届いていません') +
      '\n→ 違う人なら、店マスター「' + PARTNER_SELF_CHAT_COL + '」を消す（このリンクはすぐ使えなくなり、その人はこのリンクで戻れない。新しいリンクが1時間以内にグループへ届く）');
  }
  reply(selfRegUserText_(name0, pct, result === 'already', langs));
  welcome(pct > 0 ? { skipCampaign: true, selfPartnerPct: pct } : { skipCampaign: true });
  return true;
}
