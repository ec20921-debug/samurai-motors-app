/**
 * ProspectManager.gs — B2B車屋営業 見込みリスト連携（2026-08-03 Daisuke 裁可7点）
 *
 * 【責務】
 *   - 見込みリストGSS「SamuraiMotors_B2B車屋営業リスト_3km圏_2026-07」の「営業リスト」タブを
 *     ミニアプリ（地図の見込み店レイヤ）へ読取専用で提供する
 *   - 日次同期バッチ: 店マスター（現場の訪問実績）→ 見込みリストへステータス・最終接触日を反映
 *
 * 【設計方針】
 *   - 列参照はヘッダー名ベース（SalesLogManager.gs の共通ヘルパーを再利用）
 *   - 見込みリスト側に「shop_id」列を自動追加し、店マスターとの紐付けキーにする
 *   - 行削除・列削除は一切しない。同期は冪等（2回実行しても無変化）
 *   - 読取失敗時はレイヤ非表示・同期スキップのグレースフル・デグラデーション
 *
 * 【営業リスト列】（A-R + 自動追加の shop_id）
 *   No / Tier / 店名 / 種別 / 距離km / 住所・通り / 電話 / Facebook / FB規模 / Google評価 /
 *   ステータス / 担当 / 初回接触日 / 最終接触日 / 次アクション / メモ / 緯度 / 経度 / shop_id
 *   ※ 競合行は No='-'・ステータス=ウォッチ、自社行は No='-'。数値 No の行のみ営業対象
 */

// ====== 定数 ======

// プロパティ PROSPECT_SPREADSHEET_ID 優先＋コード内デフォルト（SetupProperties.gs の v7 ID と同じ前例）
const PROSPECT_SPREADSHEET_ID_DEFAULT = '1hdqIFXA9JFN-UN5P72nlIxrablEtQpi7xBHUan6ReQA';
const PROSPECT_SHEET_NAME = '営業リスト';

// 高確度突合の初期マッピング（2026-08-03 真田確認済み・店マスター店名 → リスト No）
// ※ 中確度の 3IN1-Auto ≈ No.49 LD9 Auto Car は要現地確認のため意図的に含めない（別行扱い）
const PROSPECT_SEED_MATCHES = {
  'PLP Auto World':          7,
  'KL Auto motive':          32,
  'US Auto lmport Cambodia': 8,   // リスト側は Auto US Direct CO., LTD
  'CAR PLUS':                73
};

// 自動同期が管理してよいステータス値（この4値と空欄以外は営業担当の手入力とみなす）
const PROSPECT_MANAGED_STATUSES = ['商談中', '再訪予定', '見送り', '提携成約'];

/**
 * 既存の「ステータス」セルを自動同期で上書きしてよいか
 * 空欄 or 自動管理4値 → 上書き可 / それ以外（ウォッチ・手入力メモ等）→ 保護して触らない
 */
function prospectStatusOverwritable_(current) {
  const v = String(current || '').trim();
  if (!v) return true;
  return PROSPECT_MANAGED_STATUSES.indexOf(v) >= 0;
}

/**
 * 店マスターの状態 → 見込みリストのステータス（2026-08-03 裁可済みマッピング）
 * 店マスターステータス優先: 提携済→提携成約 / 見送り→見送り
 * 次に最新反応: A→商談中 / B・C→再訪予定 / D→見送り。該当なしは ''（上書きしない）
 */
function prospectStatusFor_(shop) {
  if (shop.status === '提携済') return '提携成約';
  if (shop.status === '見送り') return '見送り';
  if (shop.lastReaction === 'A') return '商談中';
  if (shop.lastReaction === 'B' || shop.lastReaction === 'C') return '再訪予定';
  if (shop.lastReaction === 'D') return '見送り';
  return '';
}

/**
 * 新規行の Tier を業種から推定（凡例準拠: S=中古車・新車販売 / A=整備・修理等）
 */
function prospectTierFor_(shop) {
  return (shop.shopTypes || []).indexOf('中古車販売') >= 0 ? 'S' : 'A';
}

// ====== シート取得 ======

function getProspectSheet_() {
  const cfg = getConfig();
  const id = cfg.prospectSpreadsheetId || PROSPECT_SPREADSHEET_ID_DEFAULT;
  const sheet = SpreadsheetApp.openById(id).getSheetByName(PROSPECT_SHEET_NAME);
  if (!sheet) throw new Error('❌ 見込みリスト「' + PROSPECT_SHEET_NAME + '」タブ未発見');
  ensureColumnAfter_(sheet, '経度', 'shop_id'); // 店マスター紐付けキー（無ければ自動追加）
  return sheet;
}

/**
 * 見込みリストの日付セルを 'yyyy-MM-dd' に正規化（Sheets が Date 化したセル対策）
 */
let _prospectTzCache_ = null;
function formatProspectDateCell_(cell) {
  if (cell instanceof Date) {
    if (!_prospectTzCache_) {
      try {
        const cfg = getConfig();
        _prospectTzCache_ = SpreadsheetApp
          .openById(cfg.prospectSpreadsheetId || PROSPECT_SPREADSHEET_ID_DEFAULT)
          .getSpreadsheetTimeZone() || OPS_TZ;
      } catch (e) { _prospectTzCache_ = OPS_TZ; }
    }
    return Utilities.formatDate(cell, _prospectTzCache_, 'yyyy-MM-dd');
  }
  return String(cell || '').trim().substring(0, 10);
}

// ====== 公開 API（Router からディスパッチ・読取専用） ======

/**
 * 未訪問の見込み店一覧（地図レイヤ用）
 * 対象: 数値 No の営業対象行（競合ウォッチ・自社は No='-' なので自動除外）かつ
 *       shop_id 空欄（=未訪問）かつ緯度経度あり
 */
function listProspects(chatId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  try {
    const prospects = [];
    readSheetObjects_(getProspectSheet_()).forEach(function(r) {
      const o = r.obj;
      const no = Number(o['No']);
      if (!isFinite(no) || no <= 0) return;                 // 競合・自社行を除外
      if (String(o['shop_id'] || '').trim()) return;        // 訪問済み（店マスター紐付け済み）
      if (o['緯度'] === '' || o['緯度'] === null || o['経度'] === '' || o['経度'] === null) return;
      const lat = Number(o['緯度']), lng = Number(o['経度']);
      if (!isFinite(lat) || !isFinite(lng)) return;
      const phone = String(o['電話'] || '').trim();
      prospects.push({
        no:       no,
        shopName: String(o['店名'] || ''),
        tier:     String(o['Tier'] || '').trim().toUpperCase(),
        shopType: String(o['種別'] || ''),
        status:   String(o['ステータス'] || ''),
        phone:    phone === '-' ? '' : phone,
        lat:      lat,
        lng:      lng
      });
    });
    prospects.sort(function(a, b) { return a.no - b.no; });
    return { ok: true, prospects: prospects };
  } catch (err) {
    Logger.log('❌ listProspects: ' + err);
    return { ok: false, error: String(err) };
  }
}

// ====== 日次同期バッチ（店マスター → 見込みリスト） ======

/**
 * JST 21:00台の定時同期チェック（pollInternalBot から毎分呼ばれる。
 * maybeSendDailyReport_ と同型: 時刻窓 + Script Properties 日付マーカーで1日1回）
 */
function maybeDailyProspectSync_() {
  const now = new Date();
  const hm = Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');
  if (hm < '21:00' || hm > '21:59') return;

  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  if (props.getProperty('prospect_sync_last_run') === today) return;
  props.setProperty('prospect_sync_last_run', today); // 実行前にマーク（多重実行防止優先）

  try {
    dailyProspectSync_();
  } catch (e) {
    Logger.log('❌ dailyProspectSync_ 失敗（他処理は継続）: ' + e);
  }
}

/**
 * 店マスター全行 → 見込みリストへ反映（冪等・行/列削除なし）
 * - shop_id 一致行: ステータス（マッピング表）・最終接触日を上書き（差分がある時のみ書込）
 * - 一致なし: 高確度突合の初期マッピング（店名→No）で紐付け、それも無ければ行追加
 *
 * ※ No 採番〜行追加は LockService で排他（pollInternalBot が毎分走るため、
 *   マーカー書込前に多重着火すると No 衝突・同一行の競合更新が起きうる。
 *   ensureColumnAfter_ / ensureSalesLogV2Migration_ と同じ保護パターン）
 * ※ ロックは getProspectSheet_() の後に取る（内部の ensureColumnAfter_ が
 *   自前でスクリプトロックを取るため、入れ子取得を避ける）
 */
function dailyProspectSync_() {
  const sheet = getProspectSheet_();
  const shops = readSheetObjects_(getShopSheet_())
    .map(function(r) { return shopRowToApi_(r.obj); })
    .filter(function(s) { return s.shopId; });
  if (!shops.length) return;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30 * 1000);
  } catch (e) {
    Logger.log('⚠️ dailyProspectSync_ lock取得失敗（先行実行が処理中の可能性）: ' + e);
    return;
  }
  try {
    runProspectSync_(sheet, shops);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 見込みリスト同期の本体（ロック取得後に呼ばれる。シートの読込もロック内で行う）
 */
function runProspectSync_(sheet, shops) {
  const rows = readSheetObjects_(sheet);
  const rowByShopId = {};
  const rowByNo = {};
  const rowByName = {};   // 未紐付けの営業対象行のみ（店名完全一致用）
  let maxNo = 0;
  rows.forEach(function(r) {
    const sid = String(r.obj['shop_id'] || '').trim();
    if (sid) rowByShopId[sid] = r;
    const no = Number(r.obj['No']);
    if (isFinite(no) && no > 0) {
      rowByNo[no] = r;
      if (no > maxNo) maxNo = no;
      const name = String(r.obj['店名'] || '').trim();
      if (!sid && name && !rowByName[name]) rowByName[name] = r;
    }
  });

  let updated = 0, appended = 0;
  shops.forEach(function(shop) {
    const shopName = String(shop.shopName || '').trim();
    let target = rowByShopId[shop.shopId];
    let linkedNow = false;   // この実行で新たに紐付けた（shop_id をシートへ書く必要がある）
    if (!target) {
      // 高確度突合の初期紐付け（対象行が未紐付けの時だけ）
      const seedNo = PROSPECT_SEED_MATCHES[shop.shopName];
      if (seedNo && rowByNo[seedNo] && !String(rowByNo[seedNo].obj['shop_id'] || '').trim()) {
        target = rowByNo[seedNo];
      }
      if (!target) {
        // 店名の完全一致（見込みピン経由で作った店はリストと同名 → 重複行追加を防ぐ）
        const nameHit = rowByName[shopName];
        if (nameHit && !String(nameHit.obj['shop_id'] || '').trim()) target = nameHit;
      }
      if (target) {
        // 同一実行内で同名の別店が同じ行を取り合わないよう、ローカル索引を即座に更新
        linkedNow = true;
        delete rowByName[String(target.obj['店名'] || '').trim()];
        target.obj['shop_id'] = shop.shopId;
        rowByShopId[shop.shopId] = target;
      }
    }

    const status = prospectStatusFor_(shop);
    if (target) {
      const updates = {};
      if (linkedNow || String(target.obj['shop_id'] || '').trim() !== shop.shopId) {
        updates['shop_id'] = shop.shopId;
      }
      // 定義済み4値・空欄以外（営業担当の手入力メモ等）は保護して上書きしない
      if (status &&
          prospectStatusOverwritable_(target.obj['ステータス']) &&
          String(target.obj['ステータス'] || '').trim() !== status) {
        updates['ステータス'] = status;
      }
      if (shop.lastVisit && formatProspectDateCell_(target.obj['最終接触日']) !== shop.lastVisit) {
        updates['最終接触日'] = shop.lastVisit;
      }
      if (Object.keys(updates).length) {
        updateSheetRow_(sheet, target.row, updates);
        updated++;
      }
    } else {
      // ロン君の現場開拓による新規店（リスト未掲載）を行追加
      maxNo++;
      appendSheetRow_(sheet, {
        'No':         maxNo,
        'Tier':       prospectTierFor_(shop),
        '店名':       shop.shopName,
        '種別':       (shop.shopTypes || []).join(', '),
        '電話':       shop.phone,
        'Facebook':   shop.facebook,
        'ステータス': status || '再訪予定', // 反応未記録の訪問済店は再訪扱い（暫定）
        '担当':       'ロン君',
        '初回接触日': shop.firstVisit,
        '最終接触日': shop.lastVisit,
        'メモ':       '現場開拓(ミニアプリ)',
        '緯度':       shop.lat !== null ? shop.lat : '',
        '経度':       shop.lng !== null ? shop.lng : '',
        'shop_id':    shop.shopId
      });
      appended++;
    }
  });

  Logger.log('🔄 見込みリスト日次同期: 店マスター' + shops.length + '店 → 更新' + updated + ' / 追加' + appended);
}

// ====== デバッグ用 ======

function debugListProspects() {
  const res = listProspects('7500384947'); // ロンの chatId
  Logger.log('件数: ' + (res.prospects ? res.prospects.length : res.error));
}

function debugDailyProspectSync() {
  dailyProspectSync_();
}
