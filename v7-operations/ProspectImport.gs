/**
 * ProspectImport.gs — 営業リストの一本化（見込みリスト GSS → 店マスター）
 *
 * 【背景（2026-10-20 Daisuke「営業リストが二つになっている → 一本化して」）】
 *   - 机上で作った「見込みリスト」GSS（3km圏・Tier・住所・FB 等）と、ミニアプリが書く v7 Database
 *     「店マスター」が別々に育ち、未訪問の見込み店（約110軒）はミニアプリから見えなかった
 *   - 店マスターを唯一の営業リストにする。見込みリストにしかない店を「未訪問」として店マスターへ移し、
 *     見込みリストは 2026-10 までの記録として残す（以後は編集しない）
 *
 * 【使い方（GAS エディタから・Daisuke／PC）】
 *   0. スクリプトプロパティ PROSPECT_LIST_SPREADSHEET_ID に見込みリスト GSS の ID を入れる
 *   1. prospectImportPreview() を実行 → v7 Database に「見込み取込_確認」タブができる（書き込みはこのタブだけ）
 *      判定 = 追加 / 重複 / 要確認 / 対象外。要確認の行は、目で見て「追加」か「重複」に書き換える
 *   2. prospectImportRun() を実行 → 判定が「追加」の行だけを店マスターに「未訪問」で登録し、
 *      確認タブの「取込結果」に shop_id を書く。もう一度実行しても二重には入らない（出典で判定）
 *   3. （2026-10-21）電話が #ERROR! の店があれば repairShopPhoneErrors() を1回実行
 *
 * 【同じ店かどうかの判定（上から順に）】
 *   ① 見込みリストの shop_id が店マスターにある → 重複
 *   ② 店名（空白・記号・大文字小文字を無視）が店マスターと同じ → 重複
 *   ③ 見込みリスト内で同じ店名が2回目 → 重複（リスト内）
 *   ④ 30m 以内に店マスターの店があり、店名の一部が重なる → 要確認（自動では入れない）
 *      または、片方の店名がもう片方の先頭と一致する（5文字以上）店が店マスターにある → 距離に関係なく要確認
 *   ⑤ Tier が「競合」「HQ」 → 対象外（営業先ではない）
 */

const PROSPECT_CHECK_SHEET = '見込み取込_確認';
const PROSPECT_CHECK_HEADERS = ['判定', '理由', '近い既存店', 'No', '店名', '種別', 'Tier', 'ステータス', '緯度', '経度',
  '電話', 'Facebook', '住所', '次アクション', 'メモ', '取込結果'];
const PROSPECT_NEAR_METERS = 30;
// 見込みリストの「種別」→ 店マスターの業種（SALESLOG_SHOP_TYPES）
const PROSPECT_TYPE_MAP = {
  '整備': '整備・修理', '整備・修理': '整備・修理', '中古車販売': '中古車販売', 'タイヤ': 'タイヤ', 'パーツ': 'パーツ',
  '洗車': '洗車', '洗車屋': '洗車', '板金': '板金・塗装', '板金・塗装': '板金・塗装'
};

// ====== 1. 試し実行（確認タブを作るだけ。店マスターには書かない） ======

function prospectImportPreview() {
  const prospects = readProspectList_();
  const masters = readSheetObjects_(getShopSheet_()).map(function(r) { return r.obj; })
    .filter(function(o) { return o['shop_id'] && String(o['shop_id']).indexOf('SHOP-SAMPLE') !== 0; });
  const decisions = decideProspects_(prospects, masters);

  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(PROSPECT_CHECK_SHEET);
  if (!sheet) sheet = createHeaderedSheet_(ss, PROSPECT_CHECK_SHEET, PROSPECT_CHECK_HEADERS);
  // 前回の確認結果（Daisuke が書き換えた判定・取込結果）は、No が同じなら引き継ぐ
  const prev = {};
  readSheetObjects_(sheet).forEach(function(r) { prev[String(r.obj['No'])] = r.obj; });
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), PROSPECT_CHECK_HEADERS.length).clearContent();

  const rows = decisions.map(function(d) {
    const p = d.p, old = prev[String(p.no)];
    const verdict = old && old['取込結果'] ? old['判定'] : (old && old['判定'] && d.verdict === '要確認' ? old['判定'] : d.verdict);
    return [verdict, d.reason, d.near || '', p.no, p.name, p.type, p.tier, p.status, p.lat === null ? '' : p.lat,
            p.lng === null ? '' : p.lng, p.phone, p.facebook, p.address, p.nextAction, p.memo, old ? (old['取込結果'] || '') : ''];
  });
  // 電話の列は書く前に文字の形式にする（後からだと「+855 …」が数式として入り #ERROR! になる・先頭ゼロも消える）
  sheet.getRange(2, 11, Math.max(rows.length, 1), 1).setNumberFormat('@');
  // 店名・住所・メモ等は Web で集めた値を読み戻したもの＝' が外れているので safeCellValue_ を通す（2026-10-27）。
  // 電話の列（11列目）は書式なしテキストなので ' を付けない（付けると画面に出る）
  if (rows.length) sheet.getRange(2, 1, rows.length, PROSPECT_CHECK_HEADERS.length).setValues(
    rows.map(function(r) { return r.map(function(v, i) { return i === 10 ? v : safeCellValue_(v); }); }));

  const count = {};
  rows.forEach(function(r) { count[r[0]] = (count[r[0]] || 0) + 1; });
  Logger.log('📋 見込み取込の確認: ' + JSON.stringify(count) + ' → v7 Database「' + PROSPECT_CHECK_SHEET + '」タブを確認してください');
  return count;
}

// ====== 2. 本番（判定が「追加」の行だけ店マスターへ） ======

function prospectImportRun() {
  const ss = getSalesLogSs_();
  const sheet = ss.getSheetByName(PROSPECT_CHECK_SHEET);
  if (!sheet) throw new Error('先に prospectImportPreview() を実行してください');

  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    const shopSheet = getShopSheet_(); // Tier / 住所 / 出典 列もここで揃う
    const already = {};
    readSheetObjects_(shopSheet).forEach(function(r) {
      const src = String(r.obj['出典'] || '');
      if (src) already[src] = String(r.obj['shop_id']);
    });
    const headers = getSheetHeaders_(sheet);
    const resultCol = headers.indexOf('取込結果') + 1;
    let added = 0, skipped = 0;
    readSheetObjects_(sheet).forEach(function(r) {
      const o = r.obj;
      if (String(o['判定']).trim() !== '追加' || String(o['取込結果'] || '')) return;
      const src = '見込みリスト No.' + o['No'];
      if (already[src]) { sheet.getRange(r.row, resultCol).setValue(already[src]); skipped++; return; }
      const lat = parseProspectNum_(o['緯度']), lng = parseProspectNum_(o['経度']);
      const shopId = createShopRow_({
        '店名': String(o['店名']).trim(),
        '業種': PROSPECT_TYPE_MAP[String(o['種別']).trim()] || 'その他',
        '緯度': lat === null ? '' : lat,
        '経度': lng === null ? '' : lng,
        '緯度経度結合': lat === null || lng === null ? '' : lat + ',' + lng,
        'オーナー名': '',
        '電話': String(o['電話'] || '').replace(/^-$/, ''),
        'Facebook': String(o['Facebook'] || '').replace(/^-$/, ''),
        'ステータス': String(o['ステータス']).trim() === '見送り' ? '見送り' : '未訪問',
        'メモ': prospectMemo_(o),
        'Tier': String(o['Tier'] || ''),
        '住所': String(o['住所'] || ''),
        '出典': src
      });
      sheet.getRange(r.row, resultCol).setValue(shopId);
      already[src] = shopId;
      added++;
    });
    Logger.log('✅ 見込み取込: 追加 ' + added + '件 / 登録済みでスキップ ' + skipped + '件');
    return { added: added, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

// ====== 3. 電話が #ERROR! になった店を直す（2026-10-21・GAS エディタから1回実行） ======
// 取込のとき「+855 …」が数式（=+855 …）として入り、店マスターの電話が #ERROR! になった店がある。
// 元の番号を ①店マスターのセルの式 ②確認タブの式（出典の No で引く）③見込みリストの式 の順に探して、文字として書き戻す。
// 見つからない店は書き換えずにログに出す（電話は空のまま手で入れる）
function repairShopPhoneErrors() {
  const shopSheet = getShopSheet_();
  const headers = getSheetHeaders_(shopSheet);
  const phoneCol = headers.indexOf('電話') + 1, srcIdx = headers.indexOf('出典');
  const last = shopSheet.getLastRow();
  if (phoneCol < 1 || last < 2) { Logger.log('対象なし'); return { fixed: 0, missing: [] }; }
  const phoneRange = shopSheet.getRange(2, phoneCol, last - 1, 1);
  const vals = phoneRange.getValues(), fx = phoneRange.getFormulas();
  const srcs = srcIdx < 0 ? [] : shopSheet.getRange(2, srcIdx + 1, last - 1, 1).getValues();

  const byNo = phoneFormulasByNo_(getSalesLogSs_().getSheetByName(PROSPECT_CHECK_SHEET));
  let listByNo = null; // 見込みリストは必要になった時だけ開く
  let fixed = 0;
  const missing = [];
  for (let i = 0; i < vals.length; i++) {
    const bad = fx[i][0] || /^#(ERROR!|N\/A|REF!|VALUE!|NAME\?)$/.test(String(vals[i][0]).trim());
    if (!bad) continue;
    let original = fx[i][0] ? fx[i][0].replace(/^=/, '').trim() : '';
    const m = srcs.length ? String(srcs[i][0]).match(/^見込みリスト No\.(.+)$/) : null;
    if (!original && m) original = byNo[m[1].trim()] || '';
    if (!original && m) {
      if (listByNo === null) listByNo = prospectListPhoneFormulas_();
      original = listByNo[m[1].trim()] || '';
    }
    if (original) {
      shopSheet.getRange(i + 2, phoneCol).setNumberFormat('@').setValue(original); // 文字の形式にしてから書く（JetroCampaignManager と同じ直し方）
      fixed++;
    } else {
      missing.push('行' + (i + 2) + (m ? '（見込みリスト No.' + m[1] + '）' : ''));
    }
  }
  Logger.log('✅ 電話の #ERROR! を直した: ' + fixed + ' 件' + (missing.length ? ' / 元の番号が見つからない: ' + missing.join(', ') : ''));
  return { fixed: fixed, missing: missing };
}

// シートの「No」→ 電話の元の文字（式として入っている時だけ。普通の値は直す必要がないので返さない）
function phoneFormulasByNo_(sheet) {
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  const headers = getSheetHeaders_(sheet).map(function(h) { return h.trim(); });
  const noCol = headers.indexOf('No'), telCol = headers.indexOf('電話');
  if (noCol < 0 || telCol < 0) return out;
  const n = sheet.getLastRow() - 1;
  const nos = sheet.getRange(2, noCol + 1, n, 1).getValues();
  const fx = sheet.getRange(2, telCol + 1, n, 1).getFormulas();
  for (let i = 0; i < n; i++) {
    if (fx[i][0]) out[String(nos[i][0]).trim()] = fx[i][0].replace(/^=/, '').trim();
  }
  return out;
}

function prospectListPhoneFormulas_() {
  const id = PropertiesService.getScriptProperties().getProperty('PROSPECT_LIST_SPREADSHEET_ID');
  if (!id) return {};
  const ss = SpreadsheetApp.openById(id);
  return phoneFormulasByNo_(ss.getSheetByName('営業リスト') || ss.getSheets()[0]);
}

// ====== 判定（テストしやすいよう純粋関数） ======

function decideProspects_(prospects, masters) {
  const masterIds = {}, masterNames = {};
  masters.forEach(function(m) {
    masterIds[String(m['shop_id'])] = true;
    const k = normProspectName_(m['店名']);
    if (k) masterNames[k] = true;
  });
  const located = masters.map(function(m) {
    return { name: String(m['店名'] || ''), key: normProspectName_(m['店名']),
             lat: parseProspectNum_(m['緯度']), lng: parseProspectNum_(m['経度']) };
  }).filter(function(m) { return m.lat !== null && m.lng !== null; });

  const seen = {};
  return prospects.map(function(p) {
    const key = normProspectName_(p.name);
    if (p.shopId && masterIds[p.shopId]) return { p: p, verdict: '重複', reason: 'shop_id が店マスターにある' };
    if (key && masterNames[key]) return { p: p, verdict: '重複', reason: '店マスターに同じ店名' };
    if (key && seen[key]) return { p: p, verdict: '重複', reason: '見込みリスト内で同じ店名（No.' + seen[key] + '）' };
    if (key) seen[key] = p.no;
    if (p.tier === '競合' || p.tier === 'HQ') return { p: p, verdict: '対象外', reason: 'Tier が ' + p.tier };
    if (p.lat !== null && p.lng !== null) {
      let best = null;
      located.forEach(function(m) {
        const d = prospectDistM_(p.lat, p.lng, m.lat, m.lng);
        if (d <= PROSPECT_NEAR_METERS && namesOverlap_(key, m.key) && (!best || d < best.d)) best = { d: d, name: m.name };
      });
      if (best) return { p: p, verdict: '要確認', reason: Math.round(best.d) + 'm 以内に名前の似た店', near: best.name };
    }
    // 位置が住所からの推定で外れていることがあるので、店名がほぼ含まれる店は距離に関係なく目で確認する
    if (key && key.length >= 5) {
      const twin = masters.filter(function(m) {
        const mk = normProspectName_(m['店名']);
        return mk.length >= 5 && (mk.indexOf(key) === 0 || key.indexOf(mk) === 0); // 先頭が一致（「RTN Auto Garage ＋クメール名」等）
      })[0];
      if (twin) return { p: p, verdict: '要確認', reason: '店名がほぼ同じ店が店マスターにある', near: String(twin['店名']) };
    }
    return { p: p, verdict: '追加', reason: p.lat === null ? '位置なし（地図には出ない）' : '' };
  });
}

function normProspectName_(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_.,()（）・'"&\/]+/g, '');
}

// 片方がもう片方を含む、または4文字以上の共通部分がある
function namesOverlap_(a, b) {
  if (!a || !b) return false;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  for (let i = 0; i + 4 <= a.length; i++) {
    if (b.indexOf(a.substr(i, 4)) >= 0) return true;
  }
  return false;
}

function prospectDistM_(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseProspectNum_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) && n !== 0 ? n : null;
}

function prospectMemo_(o) {
  const parts = ['【見込みリストより・2026-10 一本化】'];
  if (o['Tier']) parts.push('Tier ' + o['Tier']);
  if (String(o['種別'] || '') && !PROSPECT_TYPE_MAP[String(o['種別']).trim()]) parts.push('種別 ' + o['種別']);
  if (String(o['ステータス'] || '') && o['ステータス'] !== '未接触') parts.push('見込みリストの状態: ' + o['ステータス']);
  if (o['次アクション']) parts.push('次アクション: ' + o['次アクション']);
  if (o['メモ']) parts.push(String(o['メモ']));
  return parts.join(' / ');
}

// ====== 見込みリストの読み取り ======

function readProspectList_() {
  const id = PropertiesService.getScriptProperties().getProperty('PROSPECT_LIST_SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ PROSPECT_LIST_SPREADSHEET_ID が未設定です');
  const ss = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName('営業リスト') || ss.getSheets()[0];
  const all = sheet.getDataRange().getValues();
  return parseProspectRows_(all);
}

// 見込みリストは「メモ」列が2つある（2列目は #2 として読む）
function parseProspectRows_(all) {
  if (all.length < 2) return [];
  const headers = [], count = {};
  all[0].forEach(function(h) {
    h = String(h).trim();
    count[h] = (count[h] || 0) + 1;
    headers.push(count[h] > 1 ? h + '#' + count[h] : h);
  });
  return all.slice(1).map(function(row) {
    const o = {};
    headers.forEach(function(h, i) { o[h] = row[i]; });
    const memo = [o['メモ'], o['メモ#2'], o['連絡方法、進捗']].map(function(x) { return String(x || '').trim(); })
      .filter(function(x) { return x; }).join(' / ');
    return {
      no: String(o['No'] || '').trim(),
      name: String(o['店名'] || '').trim(),
      type: String(o['種別'] || '').trim(),
      tier: String(o['Tier'] || '').trim(),
      status: String(o['ステータス'] || '').trim(),
      lat: parseProspectNum_(o['緯度']),
      lng: parseProspectNum_(o['経度']),
      phone: String(o['電話'] || '').trim(),
      facebook: String(o['Facebook'] || '').trim(),
      address: String(o['住所・通り'] || '').trim(),
      nextAction: String(o['次アクション'] || '').trim(),
      memo: memo,
      shopId: String(o['shop_id'] || '').trim()
    };
  }).filter(function(p) { return p.name; });
}
