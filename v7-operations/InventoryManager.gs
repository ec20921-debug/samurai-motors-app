/**
 * InventoryManager.gs — 在庫の「少ない品目」を管理グループへ知らせる（2026-09-27 Daisuke 指示）
 *
 * 【仕組み】
 *   - 在庫の正本 = 別スプレッドシート「📦Samurai Motors 在庫管理」
 *       在庫マスター: A ID / D 品名(日本語) / G 単位 / H 少ないライン / I 最新在庫(式) / K 最終棚卸日(式) / M 有効
 *       棚卸履歴:     A 棚卸日時 / B 担当 / C ID / D 個数（現場アプリ「在庫」タブから追記予定）
 *   - 在庫GSSのIDは、この業務GSSの「設定」タブ A列「在庫管理GSS ID」の B列から読む（コードに ID を書かない）
 *   - 毎週金曜（棚卸し日）の日報（JST 20:30）に「在庫」セクションを1ブロック追加する。
 *     少ないライン以下の品目と、今週の棚卸しが未実施かどうかを出す。
 *   - 読み取りに失敗しても日報全体は止めない（空文字を返す）。
 */

const INVENTORY_SETTING_LABEL_ = '在庫管理GSS ID';
const INVENTORY_COUNT_DAY_ = 5; // 金曜（プノンペン時間の曜日）

/** 業務GSS「設定」タブから在庫GSSのIDを探す */
function getInventorySpreadsheetId_() {
  try {
    const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
    const sh = ss.getSheetByName('設定');
    if (!sh) return '';
    const vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === INVENTORY_SETTING_LABEL_) return String(vals[i][1]).trim();
    }
  } catch (e) {
    Logger.log('⚠️ 在庫GSS ID 取得失敗: ' + e);
  }
  return '';
}

/**
 * 在庫の状態を読む
 * @return {{low: Array<{name,count,unit,line}>, countedThisWeek: boolean, total: number} | null}
 */
function readInventoryStatus_() {
  const id = getInventorySpreadsheetId_();
  if (!id) return null;
  const ss = SpreadsheetApp.openById(id);
  const master = ss.getSheetByName('在庫マスター');
  const hist = ss.getSheetByName('棚卸履歴');
  if (!master) return null;

  const rows = master.getLastRow() > 1 ? master.getRange(2, 1, master.getLastRow() - 1, 13).getValues() : [];
  const low = [];
  let total = 0;
  rows.forEach(function (r) {
    const active = r[12] === true || String(r[12]).toUpperCase() === 'TRUE';
    if (!r[0] || !active) return;
    total++;
    const count = r[8];      // I 最新在庫（式）
    const line = Number(r[7]); // H 少ないライン
    if (count === '' || count === null) return;
    if (Number(count) <= line) low.push({ name: String(r[3]), count: Number(count), unit: String(r[6]), line: line });
  });

  // 今週（直近7日以内）に棚卸し記録があるか
  let countedThisWeek = false;
  if (hist && hist.getLastRow() > 1) {
    const dates = hist.getRange(2, 1, hist.getLastRow() - 1, 1).getValues();
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    countedThisWeek = dates.some(function (d) {
      const t = d[0] instanceof Date ? d[0].getTime() : new Date(String(d[0]).replace(' ', 'T')).getTime();
      return !isNaN(t) && t >= since;
    });
  }
  return { low: low, countedThisWeek: countedThisWeek, total: total };
}

/**
 * 日報に載せる在庫セクション（金曜のみ）。該当なし・失敗時は ''。
 * @param {string} ppToday プノンペン日付 yyyy-MM-dd
 */
function buildInventorySection_(ppToday) {
  try {
    const d = new Date(ppToday + 'T12:00:00+07:00');
    if (d.getUTCDay() !== INVENTORY_COUNT_DAY_) return '';
    const st = readInventoryStatus_();
    if (!st) return '';
    let text = '📦 <b>在庫（金曜の棚卸し）</b>';
    if (!st.countedThisWeek) text += '\n⚠️ 今週の棚卸しがまだです（ロン君に確認）';
    if (st.low.length) {
      text += '\n🔴 少ない品目 ' + st.low.length + '件 → 補充の手配を';
      st.low.forEach(function (x) {
        text += '\n・' + invEscapeHtml_(x.name) + '：' + x.count + x.unit + '（ライン ' + x.line + '）';
      });
    } else if (st.countedThisWeek) {
      text += '\n🟢 少ない品目はありません（' + st.total + '品目）';
    }
    return text;
  } catch (e) {
    Logger.log('⚠️ 在庫セクション生成失敗(日報は継続): ' + e);
    return '';
  }
}

function invEscapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** デバッグ: 曜日に関係なく在庫セクションをログに出す */
function debugPreviewInventorySection() {
  const st = readInventoryStatus_();
  Logger.log(JSON.stringify(st));
}
