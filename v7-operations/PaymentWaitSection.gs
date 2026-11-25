/**
 * PaymentWaitSection.gs — 日報の「💵 入金待ち」欄（2026-11-25 Daisuke 要望）
 *
 * 「最後にお金が入金されて、仕事が終わる」。作業は終わったのにまだ入金されていないものを、
 * 会社（お客様）ごとに1行「何台・何ドル」で出す。大事な一言（例: 水祭りの後に払うと言われた）は
 * v7 Database のタブ「入金待ちメモ」（客名｜メモ｜更新日）に書けば、その会社の行の下に出る。
 *
 * 入金待ちの判定（v7「予約」タブ）:
 *   進行状態 = 作業完了 ／ 決済状態 ≠ 清算済み ／ 金額（請求額、無ければ料金）> 0
 *   客名 = 管理者メモの「客名:〇〇｜」。無ければ「個人のお客様（Bot 予約）」にまとめる
 *
 * 読めない時は「読取失敗」と1行出す（日報は止めない・不具合を隠さない）。
 */

const PAYMENT_WAIT_MEMO_SHEET_ = '入金待ちメモ';
const PAYMENT_WAIT_NO_NAME_ = '個人のお客様（Bot 予約）';

/** 日報に入れる「💵 入金待ち」欄の文字列 */
function buildPaymentWaitSection_() {
  try {
    const cfg = getConfig();
    if (!cfg.v7SpreadsheetId) return '';
    const ss = SpreadsheetApp.openById(cfg.v7SpreadsheetId);
    const sheet = ss.getSheetByName('予約');
    if (!sheet) throw new Error('v7「予約」シート未発見');
    const ssTz = ss.getSpreadsheetTimeZone() || OPS_TZ;

    const lastRow = sheet.getLastRow();
    const rows = [];
    if (lastRow >= 2) {
      const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
      const hdr = values[0];
      for (let i = 1; i < values.length; i++) {
        const o = {};
        hdr.forEach(function(h, j) { if (h) o[String(h)] = values[i][j]; });
        rows.push(o);
      }
    }

    // メモのタブは無くてもよい（無ければメモなしで出す）
    let memos = [];
    try {
      const memoSheet = ss.getSheetByName(PAYMENT_WAIT_MEMO_SHEET_);
      if (memoSheet && memoSheet.getLastRow() >= 2) {
        memos = memoSheet.getRange(2, 1, memoSheet.getLastRow() - 1, 3).getValues().map(function(r) {
          return { name: r[0], memo: r[1], updated: r[2] };
        });
      }
    } catch (e) {
      Logger.log('⚠️ 日報: 入金待ちメモの読取失敗（メモなしで出す）: ' + e);
    }

    return formatPaymentWaitSection_(summarizePaymentWait_(rows, ssTz), memos, ssTz);
  } catch (err) {
    Logger.log('⚠️ 日報: 入金待ち欄の生成失敗: ' + err);
    return '💵 <b>入金待ち</b>\n　（予約シートの読取失敗: ' + escapeHtml_(String(err)) + '）';
  }
}

/** 管理者メモから客名を取り出す（「客名:LUXE Auto｜…」→ 'LUXE Auto'） */
function paymentWaitCustomerName_(r) {
  const m = String(r['管理者メモ'] || '').match(/客名[:：]\s*([^｜|\n]+)/);
  const name = m ? m[1].trim() : '';
  return name || PAYMENT_WAIT_NO_NAME_;
}

/** 日付セルを yyyy-MM-dd に（Date も文字列も受ける） */
function paymentWaitDateStr_(d, tz) {
  if (!d) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  return String(d).trim().substring(0, 10).replace(/\//g, '-');
}

/**
 * 入金待ちの行を会社ごとに集計する（並びは金額の大きい順）
 * @return {Array<{name:string, count:number, amount:number, from:string, to:string}>}
 */
function summarizePaymentWait_(rows, tz) {
  const byName = {};
  rows.forEach(function(r) {
    if (!r['予約ID'] && !r['管理者メモ']) return;
    if (!isCompletedStatus_(r['進行状態'])) return;
    if (String(r['決済状態'] || '') === '清算済み') return;
    const billed = Number(r['請求額(USD)']);
    const amount = billed > 0 ? billed : Number(r['料金(USD)']);
    if (!(amount > 0)) return;
    const name = paymentWaitCustomerName_(r);
    const day = paymentWaitDateStr_(r['予約日'], tz);
    const g = byName[name] || (byName[name] = { name: name, count: 0, amount: 0, from: '', to: '' });
    g.count += 1;
    g.amount += amount;
    if (day && (!g.from || day < g.from)) g.from = day;
    if (day && (!g.to || day > g.to)) g.to = day;
  });
  return Object.keys(byName).map(function(k) { return byName[k]; })
    .sort(function(a, b) { return b.amount - a.amount; });
}

/** 'yyyy-MM-dd' → 'M/d' */
function paymentWaitMd_(s) {
  const m = String(s || '').match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? Number(m[1]) + '/' + Number(m[2]) : '';
}

/** 金額を「110$」の形に（端数があれば小数2桁・カンボジア向けの後置） */
function paymentWaitUsd_(n) {
  return (Math.round(n * 100) % 100 === 0 ? String(Math.round(n)) : n.toFixed(2)) + '$';
}

/** 集計結果とメモから、日報の欄の文字列を作る */
function formatPaymentWaitSection_(groups, memos, tz) {
  if (!groups.length) return '💵 <b>入金待ち</b>: なし';
  const memoByName = {};
  (memos || []).forEach(function(m) {
    const name = String(m.name || '').trim();
    const memo = String(m.memo || '').trim();
    if (name && memo) memoByName[name] = { memo: memo, updated: m.updated };
  });
  let totalCount = 0, totalAmount = 0;
  const lines = [];
  groups.forEach(function(g) {
    totalCount += g.count;
    totalAmount += g.amount;
    const range = g.from ? '（' + paymentWaitMd_(g.from) + (g.to && g.to !== g.from ? '〜' + paymentWaitMd_(g.to) : '') + ' の作業）' : '';
    lines.push('　' + escapeHtml_(g.name) + '：' + g.count + '台・<b>' + paymentWaitUsd_(g.amount) + '</b>' + range);
    const note = memoByName[g.name];
    if (note) {
      const upd = paymentWaitMd_(paymentWaitDateStr_(note.updated, tz));
      lines.push('　　↳ ' + escapeHtml_(note.memo) + (upd ? '（' + upd + '）' : ''));
    }
  });
  return '💵 <b>入金待ち</b>（合計 ' + totalCount + '台・' + paymentWaitUsd_(totalAmount) + '）\n' + lines.join('\n');
}
