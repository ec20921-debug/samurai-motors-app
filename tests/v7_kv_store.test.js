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
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// ====== スタブ ======

function fakeSpreadsheet() {
  const sheets = {};
  const make = (name) => {
    const rows = [];
    return {
      name, rows,
      getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
      getRange: (r, c, nr, nc) => ({
        setValues: (vals) => {
          for (let i = 0; i < nr; i++) {
            while (rows.length < r + i) rows.push(['', '', '']);
            rows[r - 1 + i] = vals[i].slice();
          }
          return { setFontWeight: () => ({}) };
        }
      }),
      setFrozenRows: () => {},
      setColumnWidth: () => {}
    };
  };
  return {
    sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = make(n); return sheets[n]; }
  };
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
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 19).replace('T', ' ') },
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
