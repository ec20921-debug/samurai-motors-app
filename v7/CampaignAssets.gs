/**
 * CampaignAssets.gs — キャンペーン素材カタログ
 *
 * 【責務】
 *   Drive の素材フォルダ（DRIVE_FOLDER_CAMPAIGN）にある画像/動画/ボイスを
 *   「キャンペーン素材」シートに一覧化し、下書きシートで「ファイル名を選ぶだけ」で
 *   送る素材を指定できるようにする。
 *
 * 【解決方針】
 *   下書きの 画像/ボイス/動画 欄(B8/B9/B10)は次のどちらでもOK:
 *     - ファイル名（素材一覧のドロップダウンから選択）→ 送信時にリンクへ自動解決
 *     - Drive 共有リンク or 外部URL を直貼り（従来どおり）
 *   → 「フォルダに何枚溜まっても、今回送る1つを名前で選ぶ」運用が可能。
 *
 * 【使い方】
 *   1. 素材フォルダ(下書きB11のリンク)に画像/動画/ボイスを入れる
 *   2. メニュー「📢 キャンペーン → 📂 素材一覧を更新」
 *   3. 下書きの B8/B9/B10 のドロップダウンからファイル名を選ぶ
 *
 * 【呼び出し元】
 *   - campaignOnOpen_() メニュー「📂 素材一覧を更新」
 *   - setupCampaign() から ensureCampaignAssetsSheet_ / applyAssetDropdowns_
 *   - readCampaignDraft_()（Campaign.gs）から resolveAssetValue_
 */

const CAMPAIGN_ASSETS_SHEET = 'キャンペーン素材';

/**
 * 素材フォルダを走査して「キャンペーン素材」シートを更新する（メニューから実行）
 */
function refreshCampaignAssets() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('DRIVE_FOLDER_CAMPAIGN');
  if (!folderId) {
    ui.alert('素材フォルダが未作成です', 'メニュー「🔧 シート再生成」または setupCampaign を先に実行してください。', ui.ButtonSet.OK);
    return;
  }
  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    ui.alert('素材フォルダが見つかりません', String(e), ui.ButtonSet.OK);
    return;
  }

  const sh = ensureCampaignAssetsSheet_();
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();

  const files = folder.getFiles();
  const rows = [];
  while (files.hasNext()) {
    const f = files.next();
    const sizeMB = Math.round((f.getSize() / 1024 / 1024) * 10) / 10;
    rows.push([
      assetKindFromMime_(f.getMimeType()),
      f.getName(),
      sizeMB,
      f.getLastUpdated(),
      f.getUrl()
    ]);
  }
  // 種別→名前 順に並べる（一覧を見やすく）
  rows.sort(function(a, b) { return (a[0] + '\t' + a[1]).localeCompare(b[0] + '\t' + b[1]); });

  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, 5).setValues(rows);
    // 動画が50MB超なら赤字で警告（送信時にブロックされる）
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === '動画' && Number(rows[i][2]) > 50) {
        sh.getRange(i + 2, 3).setFontColor('#cc0000').setFontWeight('bold');
      }
    }
  }

  applyAssetDropdowns_();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    rows.length + ' 件の素材を読み込みました（B8/B9/B10 で選べます）', '素材一覧 更新', 6);
}

/**
 * 「キャンペーン素材」シートを用意（ヘッダーのみ・冪等）
 */
function ensureCampaignAssetsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CAMPAIGN_ASSETS_SHEET);
  if (sh) return sh;

  sh = ss.insertSheet(CAMPAIGN_ASSETS_SHEET);
  const headers = ['種別', 'ファイル名', 'サイズ(MB)', '更新日', 'リンク'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  const widths = [90, 300, 90, 160, 460];
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });

  // 使い方メモ（1件も無い時の案内）
  sh.getRange('A2').setValue('（素材フォルダにファイルを入れて「📂 素材一覧を更新」を実行してください）')
    .setFontColor('#999').setFontStyle('italic');
  return sh;
}

/**
 * 下書きシートの B8/B9/B10 に「素材ファイル名」ドロップダウンを設定
 * - 素材一覧のファイル名(B列)を選択肢にする
 * - allowInvalid=true なので生リンクの直貼りも引き続き可能
 */
function applyAssetDropdowns_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const draft = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  const assets = ss.getSheetByName(CAMPAIGN_ASSETS_SHEET);
  if (!draft || !assets) return;

  const namesRange = assets.getRange('B2:B500'); // ファイル名列
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(namesRange, true)
    .setAllowInvalid(true)   // ファイル名 or 生リンク どちらも許可
    .build();
  ['B8', 'B9', 'B10'].forEach(function(a) {
    draft.getRange(a).setDataValidation(rule);
  });
}

/**
 * 下書きセルの値を「送信に使えるリンク」へ解決する
 *   - URL（http... / Drive リンク）→ そのまま
 *   - ファイル名 → 素材一覧から該当リンクを引く
 *   - 見つからない → 原文を返す（送信時に失敗 → プレビューで警告）
 *
 * @param {string} value
 * @return {string}
 */
function resolveAssetValue_(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (isAssetUrl_(v)) return v;
  const a = lookupAssetByName_(v);
  return a ? a.link : v;
}

/**
 * 値が URL（http または Drive リンク）かどうか
 */
function isAssetUrl_(v) {
  v = String(v || '');
  return /^https?:\/\//i.test(v) || /\/file\/d\/|[?&]id=/.test(v);
}

/**
 * ファイル名で素材一覧を引く
 * @return {{kind:string, name:string, sizeMB:number, link:string}|null}
 */
function lookupAssetByName_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_ASSETS_SHEET);
  if (!sh) return null;
  const last = sh.getLastRow();
  if (last < 2) return null;
  const data = sh.getRange(2, 1, last - 1, 5).getValues();
  const target = String(name).trim();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1]).trim() === target) {
      return {
        kind:   String(data[i][0]),
        name:   String(data[i][1]),
        sizeMB: Number(data[i][2]) || 0,
        link:   String(data[i][4])
      };
    }
  }
  return null;
}

/**
 * MIME タイプから種別ラベルを決める
 */
function assetKindFromMime_(mime) {
  mime = String(mime || '');
  if (mime.indexOf('image/') === 0) return '画像';
  if (mime.indexOf('video/') === 0) return '動画';
  if (mime.indexOf('audio/') === 0 || /ogg|opus/i.test(mime)) return 'ボイス';
  return 'その他';
}
