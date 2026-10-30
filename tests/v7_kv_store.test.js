/**
 * v7: 小さな状態の置き場（KvStore.gs・「状態」タブ）と、処理済み update_id の一覧（QueueManager.gs）の確認（2026-10-31）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・Cache・Properties・ロックはスタブで置き換える（本番には触れない）。
 *   - 書いたものが読める・prefix でまとめて読める・消すと行が空いて次に使い回される
 *   - 移行前に Script Properties に残っている値は、タブに無い時だけ読む。書いたら Script Properties 側は消す
 *   - 別の実行（メモ無し）が1分以内に読んでも新しい値（書いた時に Cache も更新する）
 *   - タブが読めない時: 最後に読めた内容 → Script Properties → null。書けない時は Script Properties へ退避（値を失わない）
 *   - まとめ読み（kvGetAll_）は、タブが読めず最後に読めた内容も無ければ例外（一斉配信を止める側）
 *   - ScriptLock を持ったまま呼ばれても書ける（DocumentLock を使う）
 *   - kvMigrateFromProperties: 対象のキーだけタブへ移して Script Properties から消す。設定・キューは触らない。2回実行しても同じ
 *   - processTelegramQueue: 処理済みの update_id は processed_ids_v1（1つのキー）で見る。旧 processed_* も移行期間は見る
 *   - 日時・数字の形の文字も文字のまま（書式 @ で書く）。@105 で日付・数値に化けた値は元の文字の形で読み、文字に書き直す
 *     （シートのスタブは本物と同じく、書式が @ でなければ日時の文字を Date・数字の文字を数値に変える。2026-10-31）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// ====== スタブ ======

// 本物のシートと同じく、書式が書式なしテキスト（@）でないセルに書いた日時・数字の文字は Date・数値に変わる
const SHEET_TZ_OFFSET_H = 9;   // スプレッドシートのタイムゾーン（本番は Asia/Tokyo）
function sheetDate(text) {      // シートが「yyyy-MM-dd[ H:mm[:ss]]」を日付に変えた時の Date（Asia/Tokyo）
  const m = String(text).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - SHEET_TZ_OFFSET_H, +(m[5] || 0), +(m[6] || 0)));
}
function sheetAutoConvert(v) {
  if (typeof v !== 'string') return v;
  if (/^\d{4}-\d{1,2}-\d{1,2}( \d{1,2}:\d{2}(:\d{2})?)?$/.test(v)) return sheetDate(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function fakeSpreadsheet() {
  const sheets = {};
  const ss = {
    sheets,
    calls: { setValues: 0, setNumberFormat: 0 },   // シートへの書き込み回数（まとめて書けているかの確認用）
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = make(n); return sheets[n]; },
    getSpreadsheetTimeZone: () => 'Asia/Tokyo'
  };
  const make = (name) => {
    const rows = [];
    const formats = {};   // 'r,c' → 書式
    return {
      name, rows, formats,
      getParent: () => ss,
      getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
      getRange: (r, c, nr, nc) => ({
        setNumberFormat: (f) => {
          ss.calls.setNumberFormat++;
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) formats[(r + i) + ',' + (c + j)] = f;
          return {};
        },
        setValues: (vals) => {
          ss.calls.setValues++;
          for (let i = 0; i < nr; i++) {
            while (rows.length < r + i) rows.push(['', '', '']);
            rows[r - 1 + i] = vals[i].map((v, j) => (formats[(r + i) + ',' + (c + j)] === '@' ? v : sheetAutoConvert(v)));
          }
          return { setFontWeight: () => ({}) };
        }
      }),
      setFrozenRows: () => {},
      setColumnWidth: () => {}
    };
  };
  return ss;
}

// Utilities.formatDate のスタブ（タイムゾーンと yyyy/MM/dd/HH/mm/ss に対応）
function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return String(fmt || 'yyyy-MM-dd HH:mm:ss').replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

function makeCtx(opts) {
  opts = opts || {};
  const props = new Map(Object.entries(opts.props || {}));
  const cache = new Map();
  const ss = opts.ss || fakeSpreadsheet();
  const state = { sheetBroken: false, scriptLockHeld: false, log: [] };
  const ctx = {
    console,
    Logger: { log: (m) => state.log.push(String(m)) },
    Utilities: { formatDate },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
        deleteProperty: (k) => props.delete(k),
        getProperties: () => Object.fromEntries(props),
        getKeys: () => Array.from(props.keys())
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        getAll: (keys) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
        put: (k, v) => cache.set(k, String(v)),
        putAll: (obj) => Object.keys(obj).forEach((k) => cache.set(k, String(obj[k])))
      })
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => !state.scriptLockHeld, waitLock: () => {}, releaseLock: () => {} }),
      getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },
    getSpreadsheet: () => { if (state.sheetBroken) throw new Error('sheet unavailable'); return ss; }
  };
  vm.createContext(ctx);
  ['Config.gs', 'KvStore.gs', 'QueueManager.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8'), ctx, { filename: f }));
  const run = (code) => vm.runInContext(code, ctx);
  const newExecution = () => run('__kvMemo_ = null; __kvMemoAt_ = 0;');   // 別の実行＝メモが無い
  return { ctx, run, props, cache, ss, state, newExecution };
}

const plain = (v) => JSON.parse(JSON.stringify(v));   // vm の中のオブジェクトは deepEqual で別物扱いになる
const tabRows = (t) => plain(t.ss.sheets['状態'] ? t.ss.sheets['状態'].rows : []);
const rawRows = (t) => t.ss.sheets['状態'].rows;               // plain() は Date を文字にしてしまうので、セルの型はこちらで見る
const isText = (v) => typeof v === 'string';
const tabMap = (t) => Object.fromEntries(tabRows(t).slice(1).filter((r) => r[0]).map((r) => [r[0], r[1]]));

// ====== 基本 ======

test('状態タブ: 書く→読む・prefix でまとめて読む・消すと行が空いて使い回す。タブは見出し付きで自動で作られる', () => {
  const t = makeCtx();
  t.run(`kvSet_('shop_ref_100', 'SHOP-A'); kvSet_('shop_ref_200', 'SHOP-B'); kvSet_('src_ref_100', 'PICASSO');`);
  assert.equal(t.run(`kvGet_('shop_ref_100')`), 'SHOP-A');
  assert.equal(t.run(`kvGet_('shop_ref_999')`), null);
  assert.deepEqual(plain(t.run(`kvGetAll_('shop_ref_')`)), { shop_ref_100: 'SHOP-A', shop_ref_200: 'SHOP-B' });
  assert.deepEqual(tabRows(t)[0], ['キー(key)', '値(value)', '更新日時(updated_at)']);
  assert.equal(tabRows(t).length, 4);

  t.run(`kvDelete_('shop_ref_100')`);
  assert.equal(t.run(`kvGet_('shop_ref_100')`), null);
  assert.deepEqual(tabRows(t)[1], ['', '', '']);               // 行は消さず空にする（行番号がずれない）
  t.run(`kvSet_('srcgrp_B1', '{"shopId":"SHOP-A"}')`);
  assert.equal(tabRows(t)[1][0], 'srcgrp_B1');                 // 空いた行を使い回す
  assert.equal(tabRows(t).length, 4);

  t.run(`kvSet_('shop_ref_200', 'SHOP-C')`);                   // 上書きは同じ行
  assert.equal(tabRows(t).length, 4);
  assert.equal(t.run(`kvGet_('shop_ref_200')`), 'SHOP-C');
});

test('移行前の Script Properties の値: タブに無い時だけ読む。タブに書いたら Script Properties 側は消す（消したあとに古い値が出ない）', () => {
  const t = makeCtx({ props: { shop_ref_100: 'OLD-SHOP', shopref_at_100: 'OLD-SHOP|2026-01-01', BOT_TOKEN_BOOKING: 'tok' } });
  assert.equal(t.run(`kvGet_('shop_ref_100')`), 'OLD-SHOP');
  assert.deepEqual(plain(t.run(`kvGetAll_('shop_ref_')`)), { shop_ref_100: 'OLD-SHOP' });
  assert.equal(t.run(`kvGet_('BOT_TOKEN_BOOKING')`), null);     // 設定のキーは状態の置き場から読まない

  t.run(`kvSet_('shop_ref_100', 'NEW-SHOP')`);
  assert.equal(t.run(`kvGet_('shop_ref_100')`), 'NEW-SHOP');
  assert.equal(t.props.has('shop_ref_100'), false);
  assert.equal(t.props.get('shopref_at_100'), 'OLD-SHOP|2026-01-01');   // 触っていないキーは残る

  t.run(`kvDelete_('shopref_at_100')`);
  assert.equal(t.props.has('shopref_at_100'), false);
  assert.equal(t.run(`kvGet_('shopref_at_100')`), null);
});

test('別の実行が1分以内に読んでも新しい値（書いた時に Cache も更新する）', () => {
  const t = makeCtx();
  t.run(`kvSet_('shop_ref_1', 'A')`);
  t.newExecution();
  t.state.sheetBroken = true;                                   // タブを読み直せなくても Cache から新しい値
  assert.equal(t.run(`kvGet_('shop_ref_1')`), 'A');
  t.state.sheetBroken = false;
  t.run(`kvSet_('shop_ref_1', 'B')`);
  t.newExecution();
  t.state.sheetBroken = true;
  assert.equal(t.run(`kvGet_('shop_ref_1')`), 'B');
});

test('タブが読めない時: 最後に読めた内容 → Script Properties → null。書けない時は Script Properties へ退避して値を失わない', () => {
  const t = makeCtx({ props: { src_ref_5: 'LEGACY' } });
  t.state.sheetBroken = true;
  assert.equal(t.run(`kvGet_('src_ref_5')`), 'LEGACY');
  assert.equal(t.run(`kvGet_('src_ref_6')`), null);
  assert.throws(() => t.run(`kvGetAll_('shop_ref_')`), /状態タブを読めません/);   // まとめ読みは止める側

  t.run(`kvSet_('shop_ref_7', 'SHOP-X')`);
  assert.deepEqual(JSON.parse(t.props.get('kv_retreat_v1')), { shop_ref_7: 'SHOP-X' });   // 退避は 1 キー
  assert.equal(t.props.has('shop_ref_7'), false);
  assert.equal(t.run(`kvGet_('shop_ref_7')`), 'SHOP-X');
  assert.ok(t.state.log.some((m) => m.indexOf('退避') >= 0));

  t.state.sheetBroken = false;                                  // 直ったら毎分の処理が拾う（退避はタブより新しいので上書き）
  t.run(`kvSet_('shop_ref_7', 'OLDER-IN-TAB')`);              // ※ この書き込みは退避も消す（最新を書いたので）
  assert.equal(t.props.has('kv_retreat_v1'), false);
  t.run(`kvRetreatAdd_({ shop_ref_7: 'FROM-RETREAT' })`);     // 退避だけ残った状態を作る
  assert.equal(t.run(`kvGet_('shop_ref_7')`), 'FROM-RETREAT');   // 読む時は退避が最優先
  t.run(`processTelegramQueue()`);                             // 毎分の処理が自動で移す
  assert.equal(t.props.has('kv_retreat_v1'), false);
  assert.equal(tabMap(t).shop_ref_7, 'FROM-RETREAT');
});

test('ScriptLock を持ったまま呼ばれても書ける（書き込みは DocumentLock）', () => {
  const t = makeCtx();
  t.state.scriptLockHeld = true;
  t.run(`kvSet_('shop_greeting_sent_SHOP-A', '2026-10-31 10:00:00')`);
  assert.equal(tabMap(t)['shop_greeting_sent_SHOP-A'], '2026-10-31 10:00:00');
  assert.equal(t.props.has('shop_greeting_sent_SHOP-A'), false);   // 退避ではなくタブに書けている
});

test('kvMigrateFromProperties: 対象のキーだけタブへ移して Script Properties から消す（タブにある値は優先）。設定・キュー・監査は触らない。2回実行しても同じ・1回の上限', () => {
  const t = makeCtx({ props: {
    BOT_TOKEN_BOOKING: 'tok', SPREADSHEET_ID: 'id', queue_1_1: '{}', processed_1: '1', STAFF_GATE_AUDIT_20261031: '{}',
    shop_ref_1: 'S1', shopref_at_1: 'S1|2026-10-01', src_ref_2: 'PICASSO', srcgrp_B1: '{"at":"x"}',
    selfreg_tok_abc: 'SHOP-H', selfreg_shop_SHOP_H: 'abc', partner_flyers_sent_SHOP_H: '2026-10-27', shop_greeting_sent_SHOP_H: '2026-10-27',
    shopref_dates_migrated_v1: '2026-10-27'
  } });
  t.run(`kvSet_('shop_ref_1', 'S1-NEWER')`);                  // タブにある値は移行で上書きしない
  t.props.set('shop_ref_1', 'S1');
  assert.equal(t.run(`kvMigrateFromProperties(3)`), 6);        // 上限 3 件 → 残り 6
  assert.equal(t.run(`kvMigrateFromProperties()`), 0);
  const left = Array.from(t.props.keys()).sort();
  assert.deepEqual(left, ['BOT_TOKEN_BOOKING', 'SPREADSHEET_ID', 'STAFF_GATE_AUDIT_20261031', 'processed_1', 'queue_1_1']);
  const m = tabMap(t);
  assert.equal(Object.keys(m).length, 9);
  assert.equal(m.shop_ref_1, 'S1-NEWER');
  assert.equal(m.selfreg_tok_abc, 'SHOP-H');
  assert.equal(m.shopref_dates_migrated_v1, '2026-10-27');
  assert.equal(t.run(`kvGet_('shopref_dates_migrated_v1')`), '2026-10-27');

  t.run(`kvMigrateFromProperties()`);                          // 2回目: 何も起きない
  assert.equal(Object.keys(tabMap(t)).length, 9);
  assert.equal(tabRows(t).length, 10);
});

// ====== processTelegramQueue: 処理済みの一覧 ======

test('processTelegramQueue: 処理済みは processed_ids_v1（1つのキー）で見る。旧 processed_* も移行期間は見る。一覧は最新 400 件まで', () => {
  const t = makeCtx({ props: {
    processed_ids_v1: JSON.stringify(['10']),
    processed_11: String(Date.now()),
    ['queue_1_10']: JSON.stringify({ botType: 'booking', update: { update_id: 10 } }),
    ['queue_2_11']: JSON.stringify({ botType: 'booking', update: { update_id: 11 } }),
    ['queue_3_12']: JSON.stringify({ botType: 'booking', update: { update_id: 12 } })
  } });
  const handled = [];
  t.ctx.handled = handled;
  t.run(`function handleBookingBotUpdate(u) { handled.push(u.update_id); }`);
  t.run(`processTelegramQueue()`);
  assert.deepEqual(handled, [12]);                              // 10 は一覧に、11 は旧マーカーに → 飛ばす
  assert.deepEqual(JSON.parse(t.props.get('processed_ids_v1')), ['10', '12']);
  assert.equal(Array.from(t.props.keys()).filter((k) => k.indexOf('queue_') === 0).length, 0);
  assert.equal(Array.from(t.props.keys()).filter((k) => k.indexOf('processed_') === 0 && k !== 'processed_ids_v1').length, 1);   // 旧は cleanup が消す

  // 400 件を超えたら古い方から落とす
  const many = []; for (let i = 0; i < 400; i++) many.push(String(1000 + i));
  t.props.set('processed_ids_v1', JSON.stringify(many));
  t.props.set('queue_4_5000', JSON.stringify({ botType: 'booking', update: { update_id: 5000 } }));
  t.run(`processTelegramQueue()`);
  const ids = JSON.parse(t.props.get('processed_ids_v1'));
  assert.equal(ids.length, 400);
  assert.equal(ids[0], '1001');
  assert.equal(ids[399], '5000');
});

// ====== 値は文字のまま（2026-10-31 @105 で Hiro さんのグループにチラシが再送された不具合） ======

test('日時・数字の形の文字も、文字のまま書いて読める（書式を @ にしてから書く。別の実行が読んでも同じ文字）', () => {
  const t = makeCtx();
  t.run(`kvSetAll_({
    'shop_greeting_sent_SHOP-H': '2026-10-26 15:25:36',
    'shopref_dates_migrated_v1': '2026-10-27',
    'selfreg_used_SHOP-H': '1000000001',
    'selfreg_tok_12345678901234567890': 'SHOP-H'
  })`);
  rawRows(t).slice(1).forEach((r) => r.forEach((v) => assert.ok(isText(v), String(r))));   // セルは全部文字
  t.newExecution();
  t.cache.clear();                                             // Cache も無い＝タブを読み直す
  assert.equal(t.run(`kvGet_('shop_greeting_sent_SHOP-H')`), '2026-10-26 15:25:36');
  assert.equal(t.run(`kvGet_('shopref_dates_migrated_v1')`), '2026-10-27');
  assert.equal(t.run(`kvGet_('selfreg_used_SHOP-H')`), '1000000001');
  assert.equal(t.run(`kvGet_('selfreg_tok_12345678901234567890')`), 'SHOP-H');
});

test('@105 で日付・数値に化けた値: 元の文字の形で読む（日付はシートのタイムゾーン・端数は丸める）。次に書く時に文字へ書き直す。v1 の Cache は読まない', () => {
  const ss = fakeSpreadsheet();
  const sh = ss.insertSheet('状態');
  sh.rows.push(['キー(key)', '値(value)', '更新日時(updated_at)']);
  sh.rows.push(['shop_greeting_sent_SHOP-H', sheetDate('2026-10-26 15:25:36'), sheetDate('2026-10-30 23:14:09')]);
  sh.rows.push(['shopref_dates_migrated_v1', sheetDate('2026-10-27'), sheetDate('2026-10-30 23:14:09')]);
  sh.rows.push(['shop_greeting_sent_SHOP-K', new Date(sheetDate('2026-10-26 7:54:38').getTime() - 1), sheetDate('2026-10-30 23:14:09')]);
  sh.rows.push(['selfreg_used_SHOP-H', 1000000001, sheetDate('2026-10-30 23:14:09')]);
  sh.rows.push(['shop_ref_2000000002', 'SHOP-B', '2026-10-30 23:14:09']);
  const t = makeCtx({ ss });
  t.cache.set('kv_state_v1_meta', '1');                        // @105 が残した Cache（化けた値入り）
  t.cache.set('kv_state_v1_c0', JSON.stringify({ 'shop_greeting_sent_SHOP-H': 'Mon Oct 26 2026 15:25:36 GMT+0900 (Japan Standard Time)' }));

  assert.equal(t.run(`kvGet_('shop_greeting_sent_SHOP-H')`), '2026-10-26 15:25:36');
  assert.equal(t.run(`kvGet_('shopref_dates_migrated_v1')`), '2026-10-27');
  assert.equal(t.run(`kvGet_('shop_greeting_sent_SHOP-K')`), '2026-10-26 07:54:38');   // 1ミリ秒前でも 1 秒ずれない
  assert.equal(t.run(`kvGet_('selfreg_used_SHOP-H')`), '1000000001');
  assert.deepEqual(plain(t.run(`kvGetAll_('shop_greeting_sent_')`)),
    { 'shop_greeting_sent_SHOP-H': '2026-10-26 15:25:36', 'shop_greeting_sent_SHOP-K': '2026-10-26 07:54:38' });

  t.run(`kvSet_('shop_ref_1', 'SHOP-A')`);                    // 何か1つ書くと、化けていた行も文字に書き直す
  const m = tabMap(t);
  assert.equal(m['shop_greeting_sent_SHOP-H'], '2026-10-26 15:25:36');
  assert.equal(m['shopref_dates_migrated_v1'], '2026-10-27');
  assert.equal(m['shop_greeting_sent_SHOP-K'], '2026-10-26 07:54:38');
  assert.equal(m['selfreg_used_SHOP-H'], '1000000001');
  assert.equal(m['shop_ref_2000000002'], 'SHOP-B');
  rawRows(t).slice(1).forEach((r) => r.forEach((v) => assert.ok(isText(v), String(r))));
  assert.equal(rawRows(t)[1][2], '2026-10-30 23:14:09');        // 更新日時も文字の形に戻す（書き直しで今の日時にしない）
});

test('化けた行の書き直しは、同じ実行で消したキーを生き返らせない', () => {
  const ss = fakeSpreadsheet();
  const sh = ss.insertSheet('状態');
  sh.rows.push(['キー(key)', '値(value)', '更新日時(updated_at)']);
  sh.rows.push(['selfreg_need_SHOP-H', sheetDate('2026-10-30 10:00:00'), sheetDate('2026-10-30 10:00:00')]);
  const t = makeCtx({ ss });
  t.run(`kvDelete_('selfreg_need_SHOP-H')`);
  assert.deepEqual(tabRows(t)[1], ['', '', '']);
  assert.equal(t.run(`kvGet_('selfreg_need_SHOP-H')`), null);
});

test('毎分のキュー処理: 6 時間に 1 回、化けた行を文字に書き直す（何も書かない時間帯でも本番へ入れた直後に直る）', () => {
  const ss = fakeSpreadsheet();
  const sh = ss.insertSheet('状態');
  sh.rows.push(['キー(key)', '値(value)', '更新日時(updated_at)']);
  sh.rows.push(['shop_greeting_sent_SHOP-H', sheetDate('2026-10-26 15:25:36'), sheetDate('2026-10-30 23:14:09')]);
  const t = makeCtx({ ss });
  assert.ok(!isText(rawRows(t)[1][1]));
  t.run(`processTelegramQueue()`);
  assert.equal(rawRows(t)[1][1], '2026-10-26 15:25:36');
  assert.equal(t.cache.get('kv_text_checked_v1'), '1');

  sh.rows[1][1] = sheetDate('2026-10-26 15:25:36');           // 6 時間の間は確かめ直さない（毎分タブを読まない）
  t.run(`processTelegramQueue()`);
  assert.ok(!isText(rawRows(t)[1][1]));
  t.cache.delete('kv_text_checked_v1');                        // 6 時間たった
  t.state.sheetBroken = true;                                  // 確かめに失敗した時は 10 分あける（毎分やり直さない）
  t.run(`processTelegramQueue()`);
  assert.equal(t.cache.get('kv_text_checked_v1'), 'trying');
  t.state.sheetBroken = false;
  t.cache.delete('kv_text_checked_v1');                        // 10 分たった
  t.run(`processTelegramQueue()`);
  assert.equal(rawRows(t)[1][1], '2026-10-26 15:25:36');
});

test('化けた行の書き直しは行数によらずシートへの書き込み 2 回（本番は @105 の移行で全行の更新日時が日付に化けている）', () => {
  const ss = fakeSpreadsheet();
  const sh = ss.insertSheet('状態');
  sh.rows.push(['キー(key)', '値(value)', '更新日時(updated_at)']);
  for (let i = 0; i < 300; i++) sh.rows.push(['shop_ref_' + (1000 + i), 'SHOP-' + i, sheetDate('2026-10-30 23:14:09')]);
  sh.rows.push(['', '', '']);                                  // 消した行（空）もそのまま
  sh.rows.push(['selfreg_used_SHOP-H', 1000000001, sheetDate('2026-10-30 23:14:09')]);
  const t = makeCtx({ ss });
  assert.equal(t.run(`kvRepairTextValues()`), true);
  assert.equal(ss.calls.setValues, 1);
  assert.equal(ss.calls.setNumberFormat, 1);
  rawRows(t).slice(1).forEach((r) => r.forEach((v) => assert.ok(isText(v), String(r))));
  assert.equal(rawRows(t)[1][2], '2026-10-30 23:14:09');
  assert.deepEqual(plain(rawRows(t)[301]), ['', '', '']);
  assert.equal(rawRows(t)[302][1], '1000000001');
  assert.ok(t.state.log.some((m) => m.indexOf('301 行を文字に書き直した') >= 0 && m.indexOf('selfreg_used_SHOP-H') >= 0));   // 値が数値だった行はキーを出す

  ss.calls.setValues = 0;
  t.run(`kvRepairTextValues()`);                               // 2回目: 直すものが無いので書かない
  assert.equal(ss.calls.setValues, 0);
});
