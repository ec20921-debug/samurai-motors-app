/**
 * IndividualPartnerOps.gs — 個人提携の紹介料（台帳への自動記帳・月次レポートの文面）（2026-10-26・第1号 Hiro Sato さん）
 *
 * 【流れ】Daisuke 2026-10-26「月末に件数と金額をまとめてグループに配信、そのうえで ABA で支払う」
 *   1. 毎月1日 sendShopMonthlyReports（ShopProvisioningManager.gs）の最初に syncIndividualPartnerCommissions_() が、
 *      v7 Database「予約」の「紹介元shop_id」が個人提携の予約のうち、作業完了・清算済みで台帳に無いものを
 *      コミッション台帳へ記帳する（集金者=当社・未払い・率は店マスター「紹介料率(%)」・「予約ID」列で二重記帳を防ぐ）
 *   2. 同じ sendShopMonthlyReports が、個人提携のグループへ月次レポート（グループの言語・英語＋クメール語が標準）（件数・売上・紹介料・支払い予定）を送る。
 *      支払い予定には、前月より前の月の未払い分（月をまたいで清算済みになった予約など）も含める
 *   3. 紹介料は 10日までに ABA で支払い → 台帳の支払ステータスを「支払済み」にする（パートナー精算タブも自動で進む）
 *   - 紹介者本人の利用: 2026-10-27 から、店マスター「本人chat_id」に登録した本人の予約は予約の時に30%引き・紹介料なし
 *     （予約の「紹介元shop_id」が空なので、ここでは数えない）。未登録の間は従来どおり紹介料の対象
 *   - 月をまたいで清算済みになった予約（10/31 の作業を 11/2 に清算など）は、施工日の月の件数・売上には入らず、
 *     次の月報の支払い予定に「前月より前の分」として入る
 *   - 判定・記帳できない時は黙って0件にしない: 店マスター「提携種別」列が無い → 全店の月報を止める／
 *     予約タブ「紹介元shop_id」列が無い・記帳に失敗 → 個人提携の月報だけ止める（直したら sendIndividualPartnerReportsNow）
 *
 * 【個人提携の目印】店マスター「提携種別」=「個人提携」（v7/IndividualPartner.gs と同じ）
 * 【飲食店（2026-10-29・第1号 PJ Restaurant）】「提携種別」=「飲食店」も同じ流れ（お客様は当社に払う・紹介料を台帳へ記帳・月報）。
 *   違うのはあいさつ文（restaurantGroupGreetingText_）と、本人登録・チラシが無いこと（v7/RestaurantPartner.gs）
 * 決定ログ: Vault/01_Personal/Decisions/2026-10-26-motors-individual-partner-type.md
 */

const INDIVIDUAL_PARTNER_KIND = '個人提携';   // v7/IndividualPartner.gs と同じ値（別 GAS プロジェクトのため複製）
const RESTAURANT_PARTNER_KIND = '飲食店';     // 2026-10-29 同上（個人提携と同じ紹介料の流れ）
const INDIVIDUAL_PARTNER_KIND_COL = '提携種別';
const INDIVIDUAL_LEDGER_BOOKING_COL = '予約ID';   // コミッション台帳の末尾に足す（自動記帳の重複防止）
const INDIVIDUAL_BOOKING_REF_COL = '紹介元shop_id';   // v7 Database「予約」タブ（v7 が予約・手動ジョブ売上の時に書く）
const INDIVIDUAL_BOOKING_RATE_COL = '紹介料率(%)';   // 同じく予約した時の紹介料率の写し（2026-10-27・v7/IndividualPartner.gs BOOKING_REFERRAL_RATE_COL と同じ名前）
const INDIVIDUAL_AUTO_RECORDER = '自動（個人提携）';
// 店マスターの個人提携の列（無ければ getShopSheet_ が末尾に足す・2026-10-27）。v7 PartnerSelfRegister.gs / ReferralAttribution.gs が読み書きする
//   紹介割引率(%)＝配分の設定 ／ 本人chat_id ・本人の名前（Telegram）・本人登録日時・本人登録リンク（「送付済み」だけ）＝予約Botが書く ／
//   紹介チラシURL＝立ち上げの時に Claude が書く（Day1 publish_referral_set.py の URL）
const INDIVIDUAL_PARTNER_MASTER_COLS = ['紹介割引率(%)', '本人chat_id', '紹介チラシURL', '本人の名前（Telegram）', '本人登録日時', '本人登録リンク'];

/**
 * 店マスターの個人提携・飲食店 → { shop_id: { name, terms, kind } }（terms = CommissionManager.shopCommissionTerms_・kind = 'individual' / 'restaurant'）。
 * 「提携種別」列が無い時は例外（「個人提携は無い」と決めつけない＝呼び元で月次レポートを止める）
 */
function individualPartnersById_() {
  const sheet = getShopSheet_();
  if (getSheetHeaders_(sheet).map(function(h) { return String(h).trim(); }).indexOf(INDIVIDUAL_PARTNER_KIND_COL) < 0) {
    throw new Error('店マスターに「' + INDIVIDUAL_PARTNER_KIND_COL + '」列がありません');
  }
  const out = {};
  readSheetObjects_(sheet).forEach(function(r) {
    const id = String(r.obj['shop_id'] || '').trim();
    const kindVal = String(r.obj[INDIVIDUAL_PARTNER_KIND_COL] || '').trim();
    if (!id || (kindVal !== INDIVIDUAL_PARTNER_KIND && kindVal !== RESTAURANT_PARTNER_KIND)) return;
    out[id] = { name: String(r.obj['店名'] || '').trim() || id, terms: shopCommissionTerms_(r.obj),
                kind: kindVal === RESTAURANT_PARTNER_KIND ? 'restaurant' : 'individual' };
  });
  return out;
}

/**
 * 個人提携の紹介で、作業完了・清算済みになった予約をコミッション台帳へ記帳する（冪等）。
 * 売上 = 予約の「請求額(USD)」（無ければ 料金(USD)）＝ お客様が実際に払った額（8/24 ルール①: 実支払額の30%）。
 *   紹介割引（配分の設定・2026-10-27）のある予約は、割引後の額が売上（紹介料も割引後の額 × 紹介料率）。
 * 施工日 = 予約日。率は予約した時の写し（予約タブ「紹介料率(%)」）、無ければ記帳時の店マスター。
 * 紹介者（店マスターの「紹介者名」）は記帳時の店マスターから写す（commissionCreate と同じ）
 * @return {number} 今回記帳した件数
 */
function syncIndividualPartnerCommissions_() {
  const partners = individualPartnersById_();
  if (!Object.keys(partners).length) return 0;
  // 予約タブ・「紹介元shop_id」列が無い時は黙って0件にしない（「ご利用なし」の月報を送ってしまう）→ 例外で月報を止める
  const bkSheet = getSalesLogSs_().getSheetByName('予約');
  if (!bkSheet) throw new Error('v7 Database に「予約」タブがありません');
  if (getSheetHeaders_(bkSheet).map(function(h) { return String(h).trim(); }).indexOf(INDIVIDUAL_BOOKING_REF_COL) < 0) {
    throw new Error('予約タブに「' + INDIVIDUAL_BOOKING_REF_COL + '」列がありません（紹介元が記録されないため紹介料を数えられない）');
  }
  const ledger = getCommissionSheet_();
  if (!ensureColumnsAtEnd_(ledger, [INDIVIDUAL_LEDGER_BOOKING_COL])) {
    throw new Error('コミッション台帳に「' + INDIVIDUAL_LEDGER_BOOKING_COL + '」列を足せませんでした（重複防止ができないため記帳しない）');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    const done = {};
    readSheetObjects_(ledger).forEach(function(r) {
      const b = String(r.obj[INDIVIDUAL_LEDGER_BOOKING_COL] || '').trim();
      if (b) done[b] = true;
    });
    const nowStr = salesLogNow_();
    let added = 0;
    readSheetObjects_(bkSheet).forEach(function(r) {
      const o = r.obj;
      const p = partners[String(o[INDIVIDUAL_BOOKING_REF_COL] || '').trim()];
      const bookingId = String(o['予約ID'] || '').trim();
      if (!p || !bookingId || done[bookingId]) return;
      if (String(o['進行状態'] || '') !== '作業完了' || String(o['決済状態'] || '') !== '清算済み') return;
      const paid = Number(o['請求額(USD)'] !== '' ? o['請求額(USD)'] : o['料金(USD)']);
      if (!isFinite(paid) || paid <= 0) return;

      const serviceDate = formatSalesLogDateCell_(o['予約日']).substring(0, 10);
      const revenueCents = Math.round(paid * 100);
      // 率は予約した時の写し（予約タブ「紹介料率(%)」・2026-10-27 配分の設定）。無い・読めない予約は店マスターの今の率
      const bookedRate = parsePercentCell_(o[INDIVIDUAL_BOOKING_RATE_COL]);
      const rate = bookedRate !== null ? bookedRate : p.terms.rate;
      const commissionCents = commissionAmountCents_(revenueCents, rate);
      const intro = introducerAppliesOn_(p.terms, serviceDate)
        ? { name: p.terms.introducerName, rate: p.terms.introducerRate,
            amount: commissionAmountCents_(revenueCents, p.terms.introducerRate) / 100 }
        : { name: '', rate: '', amount: '' };
      appendSheetRow_(ledger, {
        'commission_id':       generateDateTimeId('CM') + '-' + Utilities.getUuid().slice(0, 8),
        '記録日時':            nowStr,
        'shop_id':             String(o[INDIVIDUAL_BOOKING_REF_COL]).trim(),
        '店名':                p.name,
        '施工日':              serviceDate,
        '施工内容':            [o['プラン'], o['オプション']].map(function(v) { return String(v || '').trim(); }).filter(String).join(' + '),
        '売上(USD)':           revenueCents / 100,
        '率(%)':               rate,
        'コミッション額(USD)':  commissionCents / 100,
        '当社受取額(USD)':      (revenueCents - commissionCents) / 100,
        '集金者':              '当社',
        '支払ステータス':       '未払い',
        '支払日':              '',
        '支払方法':            '',
        '記録者':              INDIVIDUAL_AUTO_RECORDER,
        '最終更新日時':         nowStr,
        '更新者':              INDIVIDUAL_AUTO_RECORDER,
        'メモ':                '予約 ' + bookingId + '（' + (p.kind === 'restaurant' ? '飲食店' : '個人提携') + 'の紹介・自動記帳）',
        '紹介者名':            intro.name,
        '紹介者率(%)':         intro.rate,
        '紹介者報酬(USD)':     intro.amount,
        [INDIVIDUAL_LEDGER_BOOKING_COL]: bookingId
      });
      done[bookingId] = true;
      added++;
    });
    if (added) Logger.log('🙋 個人提携の紹介料を台帳へ記帳: ' + added + '件');
    return added;
  } finally {
    lock.releaseLock();
  }
}

/** 手で回す時用（GAS エディタから）。月次レポートは送らない */
function syncIndividualPartnerCommissionsNow() {
  const n = syncIndividualPartnerCommissions_();
  Logger.log('✅ 個人提携の紹介料 記帳: ' + n + '件');
  return n;
}

/**
 * 個人提携ごとの、当社から払う紹介料の未払い合計（指定月 yyyy-MM までの全部の月）
 * ⚠️ 集金者・支払ステータスの見方は ShopProvisioningManager.aggregateCommissionsByShop_ と同じ
 * @return {Object} { shop_id: USD }
 */
function individualOwedUpTo_(ymLabel, partners) {
  const out = {};
  readSheetObjects_(getCommissionSheet_()).forEach(function(r) {
    const o = r.obj;
    const shopId = String(o['shop_id'] || '').trim();
    if (!partners[shopId]) return;
    if (String(o['集金者'] || '') !== '当社' || String(o['支払ステータス'] || '') !== '未払い') return;
    // 月の判定は aggregateCommissionsByShop_ と同じ（日付セルはプノンペン時刻で yyyy-MM）
    const d = o['施工日'];
    const ym = (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Phnom_Penh', 'yyyy-MM') : String(d || '').slice(0, 7).replace('/', '-');
    if (!/^\d{4}-\d{2}$/.test(ym) || ym > ymLabel) return;
    out[shopId] = Math.round(((out[shopId] || 0) + (Number(o['コミッション額(USD)']) || 0)) * 100) / 100;
  });
  return out;
}

// 個人提携のグループは英語＋クメール語が標準（Daisuke 2026-10-27「ベースは日本語」→ 2026-10-28「言語設定のデフォルトは、英語とクメール語にしよう」）。
// 店マスター「グループへの通知の言語」に書けばその言語（日本語・英語・クメール語）。v7/IndividualPartner.gs individualGroupLangs_ と同じ決まり
const INDIVIDUAL_LANG_DEFAULT_OPS = ['en', 'km'];

/** 店マスターの行 → 個人提携のグループに出す言語（'ja' / 'en' / 'km'）。空欄・読めない時は英語＋クメール語 */
function individualGroupLangsOps_(shopObj) {
  const langs = (parsePartnerLangs_(shopObj && shopObj[PARTNER_GROUP_LANG_COL]) || [])
    .filter(function(l) { return l === 'ja' || l === 'en' || l === 'km'; });
  return langs.length ? langs : INDIVIDUAL_LANG_DEFAULT_OPS.slice();
}

/**
 * { ja, en, km } を langs の順に、空行で区切ってつなぐ。その言語の文が無ければ飛ばし、1つも無ければ英語
 * （クメール語の文が無い文を、クメール語だけの設定で空にしない。v7/IndividualPartner.gs individualText_ と同じ）
 */
function individualTextOps_(langs, texts) {
  const out = (langs || INDIVIDUAL_LANG_DEFAULT_OPS).map(function(l) { return texts[l]; }).filter(function(t) { return t; });
  return out.length ? out.join('\n\n') : (texts.en || texts.ja || '');
}

// ====== 個人提携の月次レポート ======
// クメール語は Panha 校閲（2026-10-28・provisional・Run Kosal 確認待ち）。用語は車屋版 SHOP_REPORT_TEXT（PartnerLangOps.gs）と同じ。
// 書き方も車屋版と同じ（見出しは「 / 」で1行・文は言語ごとに1行）。2026-10-28 までは言語ごとのかたまりを空行で並べていた
const INDIVIDUAL_REPORT_TEXT = {
  title:      { ja: '月次レポート', en: 'Monthly Report', km: 'របាយការណ៍ប្រចាំខែ' },
  jobs:       { ja: 'ご紹介のご利用', en: 'Referred jobs', km: 'ចំនួនការងារដែលអ្នកបានណែនាំមក' },
  sales:      { ja: '売上合計', en: 'Total sales', km: 'តម្លៃសេវាសរុប' },
  commission: { ja: '紹介料', en: 'Your commission', km: 'កម្រៃជើងសារ របស់អ្នក' },
  payout:     { ja: '紹介料 {amt} を、10日までに ABA でお支払いします。', en: 'We will pay your commission of {amt} by ABA by the 10th.',
                km: 'យើងនឹងបង់កម្រៃជើងសារចំនួន {amt} ជូនអ្នក ត្រឹមថ្ងៃទី10 (តាម ABA)។' },
  earlier:    { ja: '（前月より前の分 {amt} を含みます）', en: '(Includes {amt} from earlier months.)', km: '(រួមទាំង {amt} ពីខែមុនៗ)' },
  paid:       { ja: '紹介料はお支払い済みです。', en: 'Your commission has been paid.', km: 'យើងបានបង់កម្រៃជើងសារជូនអ្នកហើយ។' },
  none:       { ja: '先月はご紹介のご利用がありませんでした。今月もよろしくお願いします！', en: 'No referred jobs last month — thank you for your support!',
                km: 'ខែមុនមិនមានការងារដែលអ្នកបានណែនាំមកទេ។ សូមអរគុណដែលគាំទ្រយើងជានិច្ច!' },
  thanks:     { ja: 'いつもありがとうございます！', en: 'Thank you!', km: 'សូមអរគុណ!' }
};

/**
 * 個人提携のグループへの月次レポート（英語＋クメール語が標準・2026-10-28）
 * @param {Object} a - aggregateCommissionsByShop_ の1店分 { count, sales, commission, owedToShop, ... }
 * @param {string} ratePct - '30%' など
 * @param {number} owedAll - 前月までの未払い合計（individualOwedUpTo_）
 * @param {Array<string>} [langs] - individualGroupLangsOps_（省略時は英語＋クメール語）
 */
function buildIndividualMonthlyReport_(name, ymLabel, a, ratePct, owedAll, langs) {
  const T = INDIVIDUAL_REPORT_TEXT;
  const L = (langs && langs.length) ? langs : INDIVIDUAL_LANG_DEFAULT_OPS;
  const earlier = Math.round((owedAll - a.owedToShop) * 100) / 100;
  const label = function(key, suffix) {
    const t = {};
    Object.keys(T[key]).forEach(function(l) { t[l] = T[key][l] + (suffix || ''); });
    return langJoinOps_(L, t) || t.en;
  };
  const each = function(prefix, key, vars) {
    const got = langLinesOps_(L, T[key]);
    return (got.length ? got : [T[key].en]).map(function(t) {
      Object.keys(vars || {}).forEach(function(k) { t = t.split('{' + k + '}').join(String(vars[k])); });
      return prefix + t;
    });
  };
  let lines = [
    '📊 SAMURAI MOTORS — ' + label('title') + ' (' + ymLabel + ')',
    '',
    String(name || '').trim() || 'Partner',
    label('jobs') + ': ' + a.count,
    label('sales') + ': ' + a.sales.toFixed(2) + '$',
    label('commission', ' (' + ratePct + ')') + ': ' + a.commission.toFixed(2) + '$',
    ''
  ];
  if (owedAll > 0) {
    lines = lines.concat(each('💵 ', 'payout', { amt: owedAll.toFixed(2) + '$' }));
    if (earlier > 0) lines = lines.concat(each('', 'earlier', { amt: earlier.toFixed(2) + '$' }));
  } else if (a.count > 0) {
    lines = lines.concat(each('✅ ', 'paid'));
  } else {
    lines = lines.concat(each('', 'none'));
  }
  lines.push('', label('thanks'));
  return lines.join('\n');
}

/**
 * 店マスターの行の「紹介割引率(%)」のうち、実際に使う割引(%)（紹介料＋割引は30%まで。超えたら割引を減らす）。
 * v7/ReferralAttribution.gs effectiveReferralDiscount_ と同じ決まり（別 GAS プロジェクトのため複製）
 */
function individualEffectiveDiscountOps_(shopObj, rate) {
  const want = parsePercentCell_(shopObj ? shopObj['紹介割引率(%)'] : '') || 0;
  if (want <= 0) return 0;
  const r = (Number(rate) >= 0) ? Number(rate) : COMMISSION_DEFAULT_RATE;
  return Math.min(want, Math.max(0, Math.round((30 - r) * 100) / 100));
}

/**
 * 紹介者のグループのあいさつ文（営業ボードの表示用）。
 * v7/IndividualPartner.gs buildIndividualGroupGreeting_（連携時に予約Botが送る文）と同じ文。直すときは両方を直す
 */
function individualGroupGreetingText_(name, rate, discount, langs, selfDone) {
  const n = String(name || '').trim() || 'Partner';
  const pct = (Number(rate) >= 0 ? Number(rate) : 30) + '%';
  const off = Number(discount) > 0 ? Number(discount) + '%' : '';   // 紹介割引（配分の設定・2026-10-27）
  // ご本人の予約は予約の時に（紹介料率＋紹介割引）% 引き・紹介料なし（v7/ReferralAttribution.gs ⑦）。率が 0 なら本人の登録の案内を出さない
  const selfPct = Math.min(30, (Number(rate) >= 0 ? Number(rate) : 30) + (Number(discount) > 0 ? Number(discount) : 0));
  const selfOff = selfPct + '%';
  const showSelf = selfPct > 0 && !selfDone;   // 本人登録済み（手入力など）なら登録の案内は出さず、割引だけ伝える
  return individualTextOps_(langs, {
    ja: n + ' さん、SAMURAI MOTORS の紹介パートナーへようこそ！\nこのグループで、ご案内とお知らせをお送りします。\n\n' +
      (selfDone && selfPct > 0 ? '【ご本人のご予約】ご本人の登録は済んでいます。ご自身のご予約は、予約の時に ' + selfOff + ' 引きです。\n\n' : '') +
      (showSelf ? '【はじめに1回だけ】\n① ご本人の登録：このあと届く「🔑 本人登録リンク」を開いてください（「START」ボタンが出たら押してください）。' +
        'ご自身のご予約が、予約の時に ' + selfOff + ' 引きになります。\n\n' : '') +
      '【ご紹介のしかた】\n' + (showSelf ? '② ' : '') +
      'お友達には、このあと届く紹介用のチラシ・URL をお渡しください' + (showSelf ? '（本人登録リンクは渡さないでください）' : '') + '。\n' +
      (off ? '・ご紹介いただいた方は、全サービス ' + off + ' 引きでご利用いただけます\n' : '') +
      '・お友達のご予約が入ると、ここでお知らせします（日時・メニュー・車種。お名前や写真はお送りしません）\n' +
      '\n' +
      'ご不明な点は、このグループでお気軽にどうぞ。よろしくお願いします！',
    en: 'Welcome to SAMURAI MOTORS, ' + n + '! We\'ll send updates in this group.\n\n' +
      (selfDone && selfPct > 0 ? '[Your own bookings] You are already registered. Your own bookings get ' + selfOff + ' off when you book.\n\n' : '') +
      (showSelf ? '[One-time setup]\n1. Register yourself: open the "🔑 Registration link" coming next (tap "START" if it appears). ' +
        'Your own bookings will get ' + selfOff + ' off when you book.\n\n' : '') +
      '[How to refer]\n' + (showSelf ? '2. ' : '') +
      'Share the referral flyers / URL coming next with your friends' + (showSelf ? ' (not the registration link)' : '') + '.\n' +
      (off ? '- People you refer get ' + off + ' off all services\n' : '') +
      '- When a friend books, we\'ll let you know here (date, time, menu and car — no names or photos)\n' +
      '\n' +
      'Feel free to ask anything in this group. Thank you!',
    // クメール語は Panha 校閲（2026-10-28・provisional・Run Kosal 確認待ち）。pct / off / selfOff は % 込みの文字列
    km: 'សូមស្វាគមន៍ ' + n + ' មកកាន់ SAMURAI MOTORS! យើងនឹងផ្ញើដំណឹងមកក្នុងក្រុមនេះ។\n\n' +
      (selfDone && selfPct > 0 ? '[ការកក់របស់អ្នកផ្ទាល់] អ្នកបានចុះឈ្មោះរួចហើយ។ ការកក់របស់អ្នកផ្ទាល់ នឹងបានបញ្ចុះតម្លៃ ' + selfOff + ' ពេលកក់។\n\n' : '') +
      (showSelf ? '[ធ្វើតែម្តងគត់]\n1. ចុះឈ្មោះខ្លួនអ្នក៖ សូមបើក «🔑 តំណភ្ជាប់ចុះឈ្មោះ» ដែលនឹងមកដល់បន្ទាប់ (បើមានប៊ូតុង «START» បង្ហាញ សូមចុច)។ ' +
        'ការកក់របស់អ្នកផ្ទាល់ នឹងបានបញ្ចុះតម្លៃ ' + selfOff + ' ពេលកក់។\n\n' : '') +
      '[របៀបណែនាំមិត្តភក្តិ]\n' + (showSelf ? '2. ' : '') +
      'សូមចែករំលែកខិត្តប័ណ្ណ ឬ URL សម្រាប់ណែនាំ ដែលនឹងមកដល់បន្ទាប់ ទៅកាន់មិត្តភក្តិរបស់អ្នក' + (showSelf ? ' (មិនមែនតំណភ្ជាប់ចុះឈ្មោះទេ)' : '') + '។\n' +
      (off ? '- ភ្ញៀវដែលអ្នកបានណែនាំមក នឹងបានបញ្ចុះតម្លៃ ' + off + ' លើសេវាទាំងអស់\n' : '') +
      '- ពេលមិត្តភក្តិកក់ យើងនឹងប្រាប់អ្នកនៅទីនេះ អំពីថ្ងៃ ម៉ោង សេវា និងប្រភេទរថយន្ត (មិនផ្ញើឈ្មោះ ឬរូបថតទេ)\n' +
      '\n' +
      'បើមានអ្វីចង់សួរ សូមកុំស្ទាក់ស្ទើរសួរក្នុងក្រុមនេះ។ សូមអរគុណ!'
  });
}

/**
 * 飲食店のグループのあいさつ文（営業ボードの表示用・2026-10-29）。
 * v7/RestaurantPartner.gs buildRestaurantGroupGreeting_（連携時に予約Botが送る文）と同じ文。直すときは両方を直す
 * クメール語は Panha 校閲（2026-10-29・provisional・Run Kosal 確認待ち）
 */
function restaurantGroupGreetingText_(name, rate, langs) {
  const n = String(name || '').trim() || 'Partner';
  const r = Number(rate) >= 0 ? Number(rate) : 30;
  const pct = r + '%';
  return individualTextOps_(langs, {
    ja: n + ' さん、SAMURAI MOTORS へようこそ！\nこのグループで、ご案内とお知らせをお送りします。\n\n' +
      '【しくみ】\n' +
      '・お店のお客様は、チラシの QR からご予約いただき、お支払いは SAMURAI MOTORS に直接いただきます\n' +
      '・ご予約が入ると、ここでお知らせします（日時・メニュー・車種。お名前や写真はお送りしません）\n' +
      '\n' +
      'ご不明な点は、このグループでお気軽にどうぞ。よろしくお願いします！',
    en: 'Welcome to SAMURAI MOTORS, ' + n + '! We\'ll send updates in this group.\n\n' +
      '[How it works]\n' +
      '- Your guests book with the QR on our flyer and pay SAMURAI MOTORS directly.\n' +
      '- When a guest books, we\'ll let you know here (date, time, menu and car — no names or photos).\n' +
      '\n' +
      'Feel free to ask anything in this group. Thank you!',
    km: 'សូមស្វាគមន៍ ' + n + ' មកកាន់ SAMURAI MOTORS! យើងនឹងផ្ញើដំណឹងមកក្នុងក្រុមនេះ។\n\n' +
      '[របៀបដំណើរការ]\n' +
      '- ភ្ញៀវហាងអ្នកកក់តាម QR លើខិត្តប័ណ្ណរបស់យើង។ ភ្ញៀវបង់ប្រាក់ឱ្យ SAMURAI MOTORS ដោយផ្ទាល់។\n' +
      '- ពេលភ្ញៀវកក់ យើងនឹងប្រាប់អ្នកនៅទីនេះ អំពីថ្ងៃ ម៉ោង សេវា និងប្រភេទរថយន្ត (មិនផ្ញើឈ្មោះ ឬរូបថតទេ)\n' +
      '\n' +
      'បើមានអ្វីចង់សួរ សូមកុំស្ទាក់ស្ទើរសួរក្នុងក្រុមនេះ។ សូមអរគុណ!'
  });
}

/**
 * 店マスター「提携種別」にプルダウン（個人提携・飲食店。空欄＝車屋）を付ける（打ち間違い防止・2026-10-29 コードレビュー）。
 * 分からない値は v7 が車屋（お客様は店に払う）として扱うので、入力の時点で気づけるようにする。プルダウンにない値も入る（警告の印だけ）
 * @return {boolean} 常に true（プルダウンが付けられなくても列はあるので、列そろえは止めない）
 */
function ensurePartnerKindValidation_(sheet) {
  try {
    const col = getSheetHeaders_(sheet).map(function(h) { return String(h).trim(); }).indexOf(INDIVIDUAL_PARTNER_KIND_COL) + 1;
    if (col > 0 && sheet.getMaxRows() > 1) {
      const options = [INDIVIDUAL_PARTNER_KIND, RESTAURANT_PARTNER_KIND];
      const range = sheet.getRange(2, col, sheet.getMaxRows() - 1, 1);
      const rule = range.getDataValidation();
      if (!rule || String(rule.getCriteriaValues()[0]) !== String(options)) {
        range.setDataValidation(SpreadsheetApp.newDataValidation()
          .requireValueInList(options, true).setAllowInvalid(true)
          .setHelpText('提携の型。空欄＝車屋（お客様は店に払う）／個人提携・飲食店＝お客様は当社に払い、紹介料を月初に払う。' +
            '型の一覧は営業ボードの「📘 提携の型」').build());
      }
    }
  } catch (err) {
    Logger.log('⚠️ 提携種別のプルダウン設定失敗（列はある）: ' + err);
  }
  return true;
}
