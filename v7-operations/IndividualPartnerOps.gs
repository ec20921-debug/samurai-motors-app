/**
 * IndividualPartnerOps.gs — 個人提携の紹介料（台帳への自動記帳・月次レポートの文面）（2026-10-26・第1号 Hiro Sato さん）
 *
 * 【流れ】Daisuke 2026-10-26「月末に件数と金額をまとめてグループに配信、そのうえで ABA で支払う」
 *   1. 毎月1日 sendShopMonthlyReports（ShopProvisioningManager.gs）の最初に syncIndividualPartnerCommissions_() が、
 *      v7 Database「予約」の「紹介元shop_id」が個人提携の予約のうち、作業完了・清算済みで台帳に無いものを
 *      コミッション台帳へ記帳する（集金者=当社・未払い・率は店マスター「紹介料率(%)」・「予約ID」列で二重記帳を防ぐ）
 *   2. 同じ sendShopMonthlyReports が、個人提携のグループへ日本語＋英語の月次レポート（件数・売上・紹介料・支払い予定）を送る。
 *      支払い予定には、前月より前の月の未払い分（月をまたいで清算済みになった予約など）も含める
 *   3. 紹介料は 10日までに ABA で支払い → 台帳の支払ステータスを「支払済み」にする（パートナー精算タブも自動で進む）
 *   - 紹介者本人の利用も対象（本人が自分の紹介QRを1回読めば、以後の予約に紹介元が付く）
 *   - 月をまたいで清算済みになった予約（10/31 の作業を 11/2 に清算など）は、施工日の月の件数・売上には入らず、
 *     次の月報の支払い予定に「前月より前の分」として入る
 *   - 判定・記帳できない時は黙って0件にしない: 店マスター「提携種別」列が無い → 全店の月報を止める／
 *     予約タブ「紹介元shop_id」列が無い・記帳に失敗 → 個人提携の月報だけ止める（直したら sendIndividualPartnerReportsNow）
 *
 * 【個人提携の目印】店マスター「提携種別」=「個人提携」（v7/IndividualPartner.gs と同じ）
 * 決定ログ: Vault/01_Personal/Decisions/2026-10-26-motors-individual-partner-type.md
 */

const INDIVIDUAL_PARTNER_KIND = '個人提携';   // v7/IndividualPartner.gs と同じ値（別 GAS プロジェクトのため複製）
const INDIVIDUAL_PARTNER_KIND_COL = '提携種別';
const INDIVIDUAL_LEDGER_BOOKING_COL = '予約ID';   // コミッション台帳の末尾に足す（自動記帳の重複防止）
const INDIVIDUAL_BOOKING_REF_COL = '紹介元shop_id';   // v7 Database「予約」タブ（v7 が予約・手動ジョブ売上の時に書く）
const INDIVIDUAL_AUTO_RECORDER = '自動（個人提携）';

/**
 * 店マスターの個人提携 → { shop_id: { name, terms } }（terms = CommissionManager.shopCommissionTerms_）。
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
    if (!id || String(r.obj[INDIVIDUAL_PARTNER_KIND_COL] || '').trim() !== INDIVIDUAL_PARTNER_KIND) return;
    out[id] = { name: String(r.obj['店名'] || '').trim() || id, terms: shopCommissionTerms_(r.obj) };
  });
  return out;
}

/**
 * 個人提携の紹介で、作業完了・清算済みになった予約をコミッション台帳へ記帳する（冪等）。
 * 売上 = 予約の「請求額(USD)」（無ければ 料金(USD)）＝ お客様が実際に払った額（8/24 ルール①: 実支払額の30%）。
 * 施工日 = 予約日。率・紹介者（店マスターの「紹介者名」）は記帳時の店マスターから写す（commissionCreate と同じ）
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
      const rate = p.terms.rate;
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
        'メモ':                '予約 ' + bookingId + '（個人提携の紹介・自動記帳）',
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

/**
 * 個人提携のグループへの月次レポート（日本語＋英語）
 * @param {Object} a - aggregateCommissionsByShop_ の1店分 { count, sales, commission, owedToShop, ... }
 * @param {string} ratePct - '30%' など
 * @param {number} owedAll - 前月までの未払い合計（individualOwedUpTo_）
 */
function buildIndividualMonthlyReport_(name, ymLabel, a, ratePct, owedAll) {
  const lines = [
    '📊 SAMURAI MOTORS — 月次レポート / Monthly Report (' + ymLabel + ')',
    '',
    name + ' さん',
    'ご紹介のご利用 / Referred jobs: ' + a.count + '件',
    '売上合計 / Total sales: ' + a.sales.toFixed(2) + '$',
    '紹介料 / Your commission (' + ratePct + '): ' + a.commission.toFixed(2) + '$',
    ''
  ];
  if (owedAll > 0) {
    lines.push('💵 紹介料 ' + owedAll.toFixed(2) + '$ を、10日までに ABA でお支払いします。');
    lines.push('We will pay your commission of ' + owedAll.toFixed(2) + '$ by ABA by the 10th.');
    const earlier = Math.round((owedAll - a.owedToShop) * 100) / 100;
    if (earlier > 0) lines.push('（前月より前の分 ' + earlier.toFixed(2) + '$ を含みます / includes ' + earlier.toFixed(2) + '$ from earlier months）');
  } else if (a.count > 0) {
    lines.push('✅ 紹介料はお支払い済みです / Your commission has been paid.');
  } else {
    lines.push('先月はご紹介のご利用がありませんでした。今月もよろしくお願いします！');
    lines.push('No referred jobs last month — thank you for your support!');
  }
  lines.push('');
  lines.push('いつもありがとうございます！ / Thank you!');
  return lines.join('\n');
}

/**
 * 紹介者のグループのあいさつ文（営業ボードの表示用）。
 * v7/IndividualPartner.gs buildIndividualGroupGreeting_（連携時に予約Botが送る文）と同じ文。直すときは両方を直す
 */
function individualGroupGreetingText_(name, rate) {
  const n = String(name || '').trim() || 'Partner';
  const pct = (Number(rate) >= 0 ? Number(rate) : 30) + '%';
  return n + ' さん × SAMURAI MOTORS のグループです。\n' +
    'ご紹介いただいた方（' + n + ' さんご自身のご利用も含みます）からご予約が入ると、ここでお知らせします（日時・メニュー・車種。写真はお送りしません）。\n' +
    '毎月はじめに、前月の件数・金額・紹介料（' + pct + '）をまとめてお送りし、紹介料は ABA でお支払いします。\n' +
    'いつもありがとうございます。これからもよろしくお願いします！\n\n' +
    'This is the group for ' + n + ' × SAMURAI MOTORS.\n' +
    'When someone you referred books with us (including your own bookings), we\'ll let you know here — date, time, menu and car (no photos).\n' +
    'At the start of each month, we\'ll send a summary of last month\'s jobs, amounts and your commission (' + pct + '), and pay the commission by ABA.\n' +
    'Thank you for your support!';
}
