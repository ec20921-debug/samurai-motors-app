/**
 * PartnerSettlement.gs — パートナー精算（月次・払う相手ごとの自動集計）
 *
 * 【責務】
 *   コミッション台帳（勤務用GSS・1施工=1行）の指定月を集計し、
 *   v7 Database「パートナー精算」タブに「月 × 支払先 × 種別 × 支払の向き」1行で書き出す。
 *
 * 【設計方針（2026-09-28 Daisuke 裁可「紹介料の提携先別管理 v1」）】
 *   - 率・集金者・紹介者は台帳の行ごとの写しを使う（店マスターの現在値は見ない）
 *   - 支払の向き: 店集金 → 店→当社（当社受取額）/ 当社集金 → 当社→店（紹介料）/ 紹介者 → 本部→紹介者
 *   - 支払予定日は翌月10日（ABA）
 *   - 再実行しても安全: 既存行の 支払予定日・支払日・ステータス・メモ（手入力）は保持し、数字だけ更新。
 *     台帳側が全件支払済みになった行だけ「未払い→支払済み」へ自動で進める（逆方向には戻さない）
 *   - 実行: 毎月1日 sendShopMonthlyReports の冒頭で前月分 / シートのメニューから手動
 *
 * 【シート構成】1〜3行目=サマリー（数式で常に最新）/ 5行目=ヘッダー / 6行目〜=データ
 */

// ====== 定数 ======

const PS_SHEET_NAME = 'パートナー精算';
const PS_HEADER_ROW = 5;
const PS_HEADERS = [
  '月', '支払先', '種別', '関連提携先', '件数', '対象売上(USD)', '率(%)', '支払額(USD)',
  '支払の向き', '支払予定日', '支払日', 'ステータス', 'メモ'
];
const PS_KIND_PARTNER = '提携先';
const PS_KIND_INTRODUCER = '紹介者';
const PS_DIR_FROM_SHOP = '店→当社（当社受取額）';
const PS_DIR_TO_SHOP = '当社→店（紹介料）';
const PS_DIR_TO_INTRODUCER = '本部→紹介者';
const PS_STATUS_UNPAID = '未払い';
const PS_STATUS_PAID = '支払済み';
const PS_PAY_DAY = 10; // 翌月10日払い（2026-09-28 裁可）

// ====== 公開関数 ======

/**
 * 指定月（yyyy-MM）の精算行を作成・更新する（冪等）
 * @return {Object} { ok, ym, rows }
 */
function buildPartnerSettlement(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) throw new Error('buildPartnerSettlement: ym は yyyy-MM で指定');

  // 台帳の列自動追加（内部で LockService を使う）はロック取得前に済ませる
  const ledger = getCommissionSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    const sheet = ensurePartnerSettlementSheet_();
    const fresh = aggregateSettlementRows_(ledger, ym);
    const existing = readSettlementRows_(sheet);
    const merged = mergeSettlementRows_(ym, existing, fresh);
    writeSettlementRows_(sheet, merged);
    Logger.log('💰 パートナー精算 ' + ym + ': ' + fresh.length + '行（全' + merged.length + '行）');
    return { ok: true, ym: ym, rows: fresh.length };
  } finally {
    lock.releaseLock();
  }
}

/** メニュー用: 今月分を再集計 */
function rebuildPartnerSettlementThisMonth() {
  toastSettlement_(buildPartnerSettlement(settlementYm_(0)));
}

/** メニュー用: 先月分を再集計 */
function rebuildPartnerSettlementLastMonth() {
  toastSettlement_(buildPartnerSettlement(settlementYm_(-1)));
}

/**
 * v7 Database を開いた時に「💰 パートナー精算」メニューを出す（installable onOpen・初回1回だけ実行）
 */
function setupPartnerSettlementMenu() {
  const ss = getSalesLogSs_();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'partnerSettlementOnOpen') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('partnerSettlementOnOpen').forSpreadsheet(ss).onOpen().create();
  Logger.log('✅ パートナー精算メニューの onOpen トリガーを設置（次回オープンから表示）');
}

function partnerSettlementOnOpen() {
  try {
    SpreadsheetApp.setActiveSpreadsheet(getSalesLogSs_());
    SpreadsheetApp.getUi().createMenu('💰 パートナー精算')
      .addItem('精算を再集計（今月）', 'rebuildPartnerSettlementThisMonth')
      .addItem('精算を再集計（先月）', 'rebuildPartnerSettlementLastMonth')
      .addToUi();
  } catch (e) {
    Logger.log('⚠️ partnerSettlementOnOpen error: ' + e);
  }
}

// ====== 集計 ======

/**
 * 台帳の指定月 → 精算行（オブジェクト配列・ヘッダー名キー）
 */
function aggregateSettlementRows_(ledger, ym) {
  const groups = {};
  const order = [];
  const add = function(key, init) {
    if (!groups[key]) { groups[key] = init; order.push(key); }
    return groups[key];
  };

  readSheetObjects_(ledger).forEach(function(r) {
    const c = commissionRowToApi_(r.obj);
    if (!c.commissionId || c.serviceDate.substring(0, 7) !== ym) return;
    const revenueCents = Math.round(c.revenue * 100);

    // 提携先との精算（集金者で向きが決まる）
    const toShop = c.collector === '当社';
    const dir = toShop ? PS_DIR_TO_SHOP : PS_DIR_FROM_SHOP;
    const p = add([PS_KIND_PARTNER, c.shopId, dir].join('|'), {
      payee: c.shopName, kind: PS_KIND_PARTNER, dir: dir, shops: {},
      count: 0, revenueCents: 0, amountCents: 0, rates: {}, allPaid: true, lastPayDate: ''
    });
    p.payee = c.shopName || p.payee;
    p.count++;
    p.revenueCents += revenueCents;
    p.amountCents += Math.round((toShop ? c.amount : c.ourAmount) * 100);
    p.rates[c.rate] = true;
    if (c.payStatus !== PS_STATUS_PAID) p.allPaid = false;
    else if (c.payDate > p.lastPayDate) p.lastPayDate = c.payDate;

    // 紹介者への報酬（本部→紹介者。台帳に支払状態は無いので常に未払いで起票）
    if (c.introducerName && c.introducerAmount > 0) {
      const q = add([PS_KIND_INTRODUCER, c.introducerName].join('|'), {
        payee: c.introducerName, kind: PS_KIND_INTRODUCER, dir: PS_DIR_TO_INTRODUCER, shops: {},
        count: 0, revenueCents: 0, amountCents: 0, rates: {}, allPaid: false, lastPayDate: ''
      });
      q.shops[c.shopName] = true;
      q.count++;
      q.revenueCents += revenueCents;
      q.amountCents += Math.round(c.introducerAmount * 100);
      q.rates[c.introducerRate] = true;
    }
  });

  const due = settlementDueDate_(ym);
  return order.map(function(key) {
    const g = groups[key];
    const rates = Object.keys(g.rates);
    return {
      '月':             ym,
      '支払先':         g.payee,
      '種別':           g.kind,
      '関連提携先':     g.kind === PS_KIND_INTRODUCER ? Object.keys(g.shops).join(', ') : '',
      '件数':           g.count,
      '対象売上(USD)':  g.revenueCents / 100,
      '率(%)':          rates.length === 1 ? Number(rates[0]) : 'mixed',
      '支払額(USD)':    g.amountCents / 100,
      '支払の向き':     g.dir,
      '支払予定日':     due,
      '支払日':         g.allPaid ? g.lastPayDate : '',
      'ステータス':     g.allPaid ? PS_STATUS_PAID : PS_STATUS_UNPAID,
      'メモ':           ''
    };
  });
}

function settlementKey_(o) {
  return [o['月'], o['支払先'], o['種別'], o['支払の向き']].join('|');
}

/**
 * 既存行と再集計結果の突き合わせ。対象月以外の行はそのまま残す
 */
function mergeSettlementRows_(ym, existing, fresh) {
  const byKey = {};
  existing.forEach(function(o) { if (o['月'] === ym) byKey[settlementKey_(o)] = o; });

  const out = existing.filter(function(o) { return o['月'] !== ym; });
  const used = {};
  fresh.forEach(function(f) {
    const key = settlementKey_(f);
    const old = byKey[key];
    used[key] = true;
    if (old) {
      // 手入力欄は保持。台帳が全件支払済みになった時だけ未払い→支払済みへ進める
      if (String(old['支払予定日'] || '')) f['支払予定日'] = old['支払予定日'];
      const promote = f['ステータス'] === PS_STATUS_PAID &&
                      (!String(old['ステータス'] || '') || old['ステータス'] === PS_STATUS_UNPAID);
      f['ステータス'] = promote ? PS_STATUS_PAID : (String(old['ステータス'] || '') || f['ステータス']);
      // 支払日は手入力を優先。空なら台帳の最終支払日（台帳が全件支払済みの時だけ値がある）
      if (String(old['支払日'] || '')) f['支払日'] = old['支払日'];
      f['メモ'] = old['メモ'];
    }
    out.push(f);
  });

  // 台帳から消えた行: 手入力の痕跡があれば残して注記、無ければ削除
  Object.keys(byKey).forEach(function(key) {
    if (used[key]) return;
    const o = byKey[key];
    const touched = String(o['支払日'] || '') || String(o['メモ'] || '') || o['ステータス'] === PS_STATUS_PAID;
    if (!touched) return;
    const note = '⚠️ 再集計で台帳に該当なし';
    if (String(o['メモ'] || '').indexOf(note) < 0) o['メモ'] = (o['メモ'] ? o['メモ'] + ' / ' : '') + note;
    out.push(o);
  });

  const kindOrder = [PS_KIND_PARTNER, PS_KIND_INTRODUCER];
  out.sort(function(a, b) {
    return String(b['月']).localeCompare(String(a['月'])) ||
           kindOrder.indexOf(a['種別']) - kindOrder.indexOf(b['種別']) ||
           String(a['支払の向き']).localeCompare(String(b['支払の向き'])) ||
           String(a['支払先']).localeCompare(String(b['支払先']));
  });
  return out;
}

// ====== シート入出力 ======

/**
 * 「パートナー精算」タブを新レイアウトで用意する。
 * 旧【サンプル】レイアウト（2026-08-25 模擬データ・削除は 2026-09-28 Daisuke 承認済み）なら作り直す。
 * それ以外の想定外レイアウトは実データ保護のため例外で止める
 */
function ensurePartnerSettlementSheet_() {
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(PS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PS_SHEET_NAME);
    writeSettlementLayout_(sheet);
    return sheet;
  }
  const lastCol = Math.max(sheet.getLastColumn(), PS_HEADERS.length);
  const headerRow = sheet.getRange(PS_HEADER_ROW, 1, 1, PS_HEADERS.length).getValues()[0].map(String);
  if (headerRow.join('|') === PS_HEADERS.join('|')) return sheet;

  const all = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), lastCol).getValues();
  const isOldSample = String(all[0][0]) === '月' && String(all[0][1]) === 'パートナーID' &&
    all.slice(1).every(function(r) {
      const name = String(r[2] || '');
      return !name || name.indexOf('【サンプル】') === 0;
    });
  if (!isOldSample) {
    throw new Error('パートナー精算: 想定外のレイアウトのため中止（手動データ保護）。5行目のヘッダーを確認してください');
  }
  sheet.clear();
  writeSettlementLayout_(sheet);
  Logger.log('🔄 パートナー精算: 旧【サンプル】レイアウトを新レイアウトに作り直し');
  return sheet;
}

function writeSettlementLayout_(sheet) {
  const needCols = PS_HEADERS.length - sheet.getMaxColumns();
  if (needCols > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols);

  // 列: A月 … H支払額 I支払の向き J支払予定日 K支払日 Lステータス（数式はこの列位置が前提）
  const thisMonth = 'TEXT(TODAY(),"yyyy-mm")&"*"';
  sheet.getRange(1, 1).setValue('💰 パートナー精算（台帳から自動集計・再集計しても 支払日/ステータス/メモ は保持）')
    .setFontWeight('bold');
  sheet.getRange(2, 1, 2, 4).setValues([
    ['今月の支払予定（提携先へ）',
     '=SUMIFS($H$6:$H,$I$6:$I,"' + PS_DIR_TO_SHOP + '",$J$6:$J,' + thisMonth + ')',
     '今月の支払予定（紹介者へ）',
     '=SUMIFS($H$6:$H,$I$6:$I,"' + PS_DIR_TO_INTRODUCER + '",$J$6:$J,' + thisMonth + ')'],
    ['未払い合計（当社が払う分）',
     '=SUMIFS($H$6:$H,$L$6:$L,"' + PS_STATUS_UNPAID + '",$I$6:$I,"<>' + PS_DIR_FROM_SHOP + '")',
     '未回収合計（店から受け取る分）',
     '=SUMIFS($H$6:$H,$L$6:$L,"' + PS_STATUS_UNPAID + '",$I$6:$I,"' + PS_DIR_FROM_SHOP + '")']
  ]);
  sheet.getRange('B2:B3').setNumberFormat('$#,##0.00').setFontWeight('bold');
  sheet.getRange('D2:D3').setNumberFormat('$#,##0.00').setFontWeight('bold');
  sheet.getRange(PS_HEADER_ROW, 1, 1, PS_HEADERS.length).setValues([PS_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(PS_HEADER_ROW);
  // 月・支払予定日は文字列で保持（日付変換されると数式の前方一致が効かない）
  sheet.getRange('A6:A').setNumberFormat('@');
  sheet.getRange('J6:J').setNumberFormat('@');
}

function readSettlementRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= PS_HEADER_ROW) return [];
  const values = sheet.getRange(PS_HEADER_ROW + 1, 1, lastRow - PS_HEADER_ROW, PS_HEADERS.length).getValues();
  return values
    .filter(function(r) { return String(r[0] || '') && String(r[1] || ''); })
    .map(function(r) {
      const o = {};
      PS_HEADERS.forEach(function(h, i) {
        o[h] = (h === '支払日' || h === '支払予定日') ? formatSalesLogDateCell_(r[i]).substring(0, 10) : r[i];
      });
      o['月'] = String(o['月']);
      return o;
    });
}

function writeSettlementRows_(sheet, rows) {
  const start = PS_HEADER_ROW + 1;
  const lastRow = sheet.getLastRow();
  if (lastRow >= start) sheet.getRange(start, 1, lastRow - start + 1, PS_HEADERS.length).clearContent();
  if (!rows.length) return;
  sheet.getRange(start, 1, rows.length, PS_HEADERS.length).setValues(
    rows.map(function(o) { return PS_HEADERS.map(function(h) { return o[h] === undefined ? '' : o[h]; }); })
  );
}

// ====== 日付ユーティリティ ======

/** 今月からの相対月（0=今月 / -1=先月）を yyyy-MM で */
function settlementYm_(offset) {
  const parts = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM').split('-');
  const idx = Number(parts[0]) * 12 + (Number(parts[1]) - 1) + offset;
  return Math.floor(idx / 12) + '-' + String(idx % 12 + 1).padStart(2, '0');
}

/** yyyy-MM → 翌月の支払日（yyyy-MM-10）。Date を使わず TZ ズレを避ける */
function settlementDueDate_(ym) {
  const parts = ym.split('-');
  const idx = Number(parts[0]) * 12 + (Number(parts[1]) - 1) + 1;
  return Math.floor(idx / 12) + '-' + String(idx % 12 + 1).padStart(2, '0') + '-' +
         String(PS_PAY_DAY).padStart(2, '0');
}

function toastSettlement_(res) {
  try {
    getSalesLogSs_().toast(res.ym + ' を再集計しました（' + res.rows + '行）', '💰 パートナー精算', 5);
  } catch (e) {
    Logger.log('ℹ️ toast skipped: ' + e);
  }
}
