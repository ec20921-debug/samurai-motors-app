/**
 * PartnerLangOps.gs — 提携先のグループへの通知の言語（v7-operations 側・2026-10-26）
 *
 * Daisuke「車屋とかの提携店は、クメール語と英語と日本語にしようか」「ケースバイケース」→ グループごとに切り替え。
 *   - 設定 = v7 Database「店マスター」の「グループへの通知の言語」列。この列とプルダウンは getShopSheet_ が足す（ensurePartnerLangColumn_）
 *   - ここで使う: 車屋への月次レポート（ShopProvisioningManager.gs）・営業ボードの表示（ScoutBoardShopLinks.gs）
 *   - v7/PartnerLang.gs と同じ決まり（列名・読み方・標準）。別 GAS プロジェクトのため複製。直すときは両方を直す
 *
 * クメール語は Panha 校閲（2026-10-26・provisional・Run Kosal 確認待ち: native-check-queue「2026-10-26 提携店グループ宛 三言語通知」）。
 * 文言を直すときは Panha を通す（Red Line #7）
 */

const PARTNER_GROUP_LANG_COL = 'グループへの通知の言語';
const PARTNER_LANG_SHOP_DEFAULT = ['km', 'en', 'ja'];   // 車屋の標準（Daisuke 2026-10-26）
const PARTNER_LANG_OPTIONS = ['クメール語＋英語＋日本語', 'クメール語＋英語', '英語＋クメール語', '英語＋日本語', '日本語＋英語', '英語', 'クメール語', '日本語'];   // 英語＋クメール語＝個人提携の標準（2026-10-28。それまでは日本語）
const PARTNER_LANG_SPLIT = /[＋+,、，・\/&＆→＞>\s]+|と/;
const PARTNER_LANG_WORDS = {
  'クメール語': 'km', 'クメール': 'km', 'カンボジア語': 'km', '英語': 'en', '英': 'en', '日本語': 'ja', '日本': 'ja',
  km: 'km', en: 'en', ja: 'ja', khmer: 'km', english: 'en', japanese: 'ja'
};
const PARTNER_LANG_NAMES = { km: 'クメール語', en: '英語', ja: '日本語' };

/** 「クメール語＋英語＋日本語」→ ['km','en','ja']。分からない語は無視。1つも無ければ null（v7/PartnerLang.gs と同じ） */
function parsePartnerLangs_(v) {
  const out = [];
  String(v || '').split(PARTNER_LANG_SPLIT).forEach(function(w) {
    const key = String(w || '').trim().toLowerCase();
    const code = Object.prototype.hasOwnProperty.call(PARTNER_LANG_WORDS, key) ? PARTNER_LANG_WORDS[key] : '';
    if (code && out.indexOf(code) < 0) out.push(code);
  });
  return out.length ? out : null;
}

/** 設定の値のうち読めない語（営業ボードで知らせる。「クメール＋英語」の打ち間違いで言語が黙って欠けないように） */
function partnerLangsUnknownWords_(v) {
  return String(v || '').split(PARTNER_LANG_SPLIT).map(function(w) { return String(w || '').trim(); }).filter(function(w) {
    return w && !Object.prototype.hasOwnProperty.call(PARTNER_LANG_WORDS, w.toLowerCase());
  });
}

/** 店マスターの行（obj）→ 車屋のグループに出す言語。空欄・読めない値は標準 */
function shopGroupLangsOps_(shopObj) {
  return parsePartnerLangs_(shopObj && shopObj[PARTNER_GROUP_LANG_COL]) || PARTNER_LANG_SHOP_DEFAULT.slice();
}

/** ['km','en','ja'] → 「クメール語＋英語＋日本語」 */
function partnerLangsLabel_(langs) {
  return langs.map(function(l) { return PARTNER_LANG_NAMES[l]; }).join('＋');
}

/** texts = {km, en, ja} を langs の順に（その言語の文が無ければ飛ばす） */
function langLinesOps_(langs, texts) {
  return langs.map(function(l) { return texts[l]; }).filter(function(t) { return t; });
}

function langJoinOps_(langs, texts) {
  return langLinesOps_(langs, texts).join(' / ');
}

/**
 * 店マスターに「グループへの通知の言語」列（末尾）とプルダウンを用意する（getShopSheet_ の列そろえから。6時間に1回）。
 * プルダウンにない並び（例: 日本語＋クメール語）も入力できる（警告の印が出るだけ。読み方は parsePartnerLangs_）
 * @return {boolean} 列がそろったか
 */
function ensurePartnerLangColumn_(sheet) {
  if (!ensureColumnsAtEnd_(sheet, [PARTNER_GROUP_LANG_COL])) return false;
  try {
    const col = getSheetHeaders_(sheet).indexOf(PARTNER_GROUP_LANG_COL) + 1;
    if (col > 0 && sheet.getMaxRows() > 1) {
      const range = sheet.getRange(2, col, sheet.getMaxRows() - 1, 1);
      const rule = range.getDataValidation();
      if (!rule || String(rule.getCriteriaValues()[0]) !== String(PARTNER_LANG_OPTIONS)) {
        range.setDataValidation(SpreadsheetApp.newDataValidation()
          .requireValueInList(PARTNER_LANG_OPTIONS, true).setAllowInvalid(true)
          .setHelpText('グループへの通知の言語（並べた順に出す）。空欄＝車屋はクメール語＋英語＋日本語・個人提携は英語＋クメール語。' +
            '変えてから最大5分で反映。あいさつ文は連携した時の1回だけなので、/register の前に決める').build());
      }
    }
  } catch (err) {
    Logger.log('⚠️ 通知の言語のプルダウン設定失敗（列はある）: ' + err);
  }
  return true;
}

// ====== 車屋への月次レポート ======
// クメール語は Panha 校閲（2026-10-26・provisional）。英語は 2026-10-26 までの文と同じ（nothingDue を新設・collect から現金を外した）。日本語は同日新設
const SHOP_REPORT_TEXT = {
  title:      { km: 'របាយការណ៍ប្រចាំខែ', en: 'Monthly Report', ja: '月次レポート' },
  shop:       { km: 'ហាង', en: 'Shop', ja: 'お店' },
  jobs:       { km: 'ចំនួនការងារ', en: 'Jobs', ja: '件数' },
  sales:      { km: 'តម្លៃសេវាសរុប', en: 'Total sales', ja: '売上合計' },
  commission: { km: 'កម្រៃជើងសារ របស់ហាង', en: 'Your commission', ja: 'お店の紹介料' },
  ours:       { km: 'ទឹកប្រាក់របស់ Samurai Motors', en: 'Samurai Motors share', ja: 'Samurai Motors の取り分' },
  payout:     { km: 'យើងនឹងបង់កម្រៃជើងសារចំនួន {amt} ជូនហាង ត្រឹមថ្ងៃទី10 (តាម ABA)។', en: 'We will pay your commission {amt} by the 10th (ABA).',
                ja: '紹介料 {amt} は、10日までに ABA でお支払いします。' },
  notSettled: { km: 'មិនទាន់ទូទាត់', en: 'Not yet settled', ja: '未精算' },
  // 2026-10-25 Daisuke 決定「当社が受け取るのは ABA の QR だけ（現金は受け取らない）」に合わせて、現金を外した（Panha 案B・2026-10-26）
  collect:    { km: 'បុគ្គលិករបស់យើងនឹងទទួលប្រាក់ពីហាង នៅពេលមកលើកក្រោយ (តាម ABA)។ សូមអរគុណ!',
                en: 'Our staff will collect on the next visit (ABA). Thank you!',
                ja: '次にうかがった時に、スタッフが ABA で受け取ります。よろしくお願いします！' },
  settled:    { km: 'ទូទាត់រួចរាល់ទាំងអស់។ សូមអរគុណដែលសហការជាមួយយើង!', en: 'All settled. Thank you for working with us!',
                ja: 'すべて精算済みです。いつもありがとうございます！' },
  // 当社→店の紹介料の支払いだけがある月（お店が当社に払うものは無い）。「All settled」が支払い予告と矛盾して見えないように（Panha 2026-10-26 提案）
  nothingDue: { km: 'ហាងអ្នកគ្មានប្រាក់ត្រូវបង់ទៀតទេ។ សូមអរគុណដែលសហការជាមួយយើង!', en: 'Nothing is outstanding on your side. Thank you for working with us!',
                ja: 'お店からのお支払いはありません。いつもありがとうございます！' },
  none:       { km: 'ខែមុនមិនមានការងារទេ។ ខែនេះ សូមរួមគ្នាខិតខំប្រឹងប្រែង!', en: 'No jobs last month. Let\'s make this month better together!',
                ja: '先月の作業はありませんでした。今月も一緒にがんばりましょう！' }
};

/**
 * 車屋への月次レポートの本文（langs の順。['en'] なら 2026-10-26 までの英語の文と同じ。
 * ただし当社→店の支払いだけの月の締めは「All settled」でなく nothingDue）
 * @param {Array} langs
 * @param {Object} p - { shopName, ymLabel, a: 集計（count/sales/commission/ourShare/owedToShop/outstanding）, yourPct, ourPct }
 */
function buildShopMonthlyReportText_(langs, p) {
  const T = SHOP_REPORT_TEXT, a = p.a;
  const label = function(key, suffix) {
    const t = {};
    Object.keys(T[key]).forEach(function(l) { t[l] = T[key][l] + (suffix || ''); });
    return langJoinOps_(langs, t);
  };
  const each = function(prefix, key, vars) {
    return langLinesOps_(langs, T[key]).map(function(t) {
      Object.keys(vars || {}).forEach(function(k) { t = t.split('{' + k + '}').join(String(vars[k])); });
      return prefix + t;
    });
  };
  let lines = [
    '📊 SAMURAI MOTORS — ' + label('title') + ' (' + p.ymLabel + ')',
    '',
    label('shop') + ': ' + p.shopName,
    label('jobs') + ': ' + a.count,
    label('sales') + ': ' + a.sales.toFixed(2) + '$',
    label('commission', ' (' + p.yourPct + ')') + ': ' + a.commission.toFixed(2) + '$',
    label('ours', ' (' + p.ourPct + ')') + ': ' + a.ourShare.toFixed(2) + '$'
  ];
  if (a.owedToShop > 0) {
    // 当社集金の案件: 紹介料は当社から店へ翌月10日に支払う
    lines.push('');
    lines = lines.concat(each('💵 ', 'payout', { amt: a.owedToShop.toFixed(2) + '$' }));
  }
  lines.push('');
  if (a.outstanding > 0) {
    lines.push('⏳ ' + label('notSettled') + ': ' + a.outstanding.toFixed(2) + '$');
    lines = lines.concat(each('', 'collect'));
  } else if (a.count > 0) {
    lines = lines.concat(each('✅ ', a.owedToShop > 0 ? 'nothingDue' : 'settled'));
  } else {
    lines = lines.concat(each('', 'none'));
  }
  return lines.join('\n');
}
