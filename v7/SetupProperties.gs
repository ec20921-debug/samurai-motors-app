/**
 * 一時スクリプト: PropertiesService に v7 の設定値を一括登録
 *
 * 【目的】
 *   v7 で使用する全ての設定値（トークン・ID類）を ScriptProperties に登録する。
 *   コードへのハードコードを防ぐための基盤整備。
 *
 * 【実行手順】
 *   1. 下の TOKEN_BOOKING / TOKEN_FIELD にトークンを貼り付け（GASエディタ上のみ）
 *      ⚠️ GitHubコミット前に必ず空文字に戻すこと
 *   2. 関数選択プルダウンで `setupProperties` を選んで ▶ 実行
 *   3. 実行ログで「✅ 登録完了: 8件」が表示されれば成功
 *   4. 確認: `verifyProperties` を実行して全キーが登録されたかチェック
 *
 * 【実行後】
 *   - TOKEN_BOOKING / TOKEN_FIELD を空文字に戻す
 *   - Phase 1 のコーディング開始後は、このファイルは削除してOK（ローカル＆GitHubには残す）
 */

// ⚠️ 実行時のみトークンを貼り付け。実行後は必ず空文字に戻すこと
const TOKEN_BOOKING = '';  // 予約Bot (@samurai_motors_booking_bot)
const TOKEN_FIELD   = '';  // 業務Bot (@quickwash_kh_bot)

// ── 固定値（機密性なし、ハードコードOK） ──
const V7_PROPERTIES = {
  // Telegram
  ADMIN_GROUP_ID: '-1003856480475',

  // Google Workspace
  SPREADSHEET_ID: '1Fa-bmpObZ9ZdvtaRIZVzsH2yYDw1ZgBnAkGWmY3b5XI',
  BOOKING_CALENDAR_ID: 'samuraimotors.japan@gmail.com',

  // Drive フォルダID
  DRIVE_FOLDER_WASH_PHOTOS: '1Mun233vVmNscae8VaVgD2iHKCFArkXsH',
  DRIVE_FOLDER_QR_CODES: '1P1uUGupRxe1-VTsNK1aMOla9NXa355zA',
  DRIVE_FOLDER_PAYMENT_SCREENSHOTS: '16UZvAvNiNhXTbtyJUwQEFY0GOveKm6qp'
};

function setupProperties() {
  if (!TOKEN_BOOKING || !TOKEN_FIELD) {
    Logger.log('❌ TOKEN_BOOKING または TOKEN_FIELD が未設定です');
    Logger.log('   スクリプト冒頭の定数にトークンを貼り付けてから再実行してください');
    return;
  }

  const props = PropertiesService.getScriptProperties();

  // トークン登録
  props.setProperty('BOT_TOKEN_BOOKING', TOKEN_BOOKING);
  props.setProperty('BOT_TOKEN_FIELD', TOKEN_FIELD);

  // 固定値登録
  Object.keys(V7_PROPERTIES).forEach(function(key) {
    props.setProperty(key, V7_PROPERTIES[key]);
  });

  const total = 2 + Object.keys(V7_PROPERTIES).length;
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ 登録完了: ' + total + '件');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📋 次のステップ:');
  Logger.log('   1. verifyProperties を実行して登録内容を確認');
  Logger.log('   2. スクリプト冒頭の TOKEN_BOOKING / TOKEN_FIELD を空文字に戻す');
  Logger.log('   3. 保存');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 登録内容の確認（トークンはマスク表示）
 */
function verifyProperties() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const expectedKeys = [
    'BOT_TOKEN_BOOKING',
    'BOT_TOKEN_FIELD',
    'ADMIN_GROUP_ID',
    'SPREADSHEET_ID',
    'BOOKING_CALENDAR_ID',
    'DRIVE_FOLDER_WASH_PHOTOS',
    'DRIVE_FOLDER_QR_CODES',
    'DRIVE_FOLDER_PAYMENT_SCREENSHOTS'
  ];

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📋 PropertiesService 登録状況');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  let missing = 0;
  expectedKeys.forEach(function(key) {
    const val = all[key];
    if (!val) {
      Logger.log('❌ ' + key + ' : 未登録');
      missing++;
    } else if (key.indexOf('TOKEN') >= 0) {
      // トークンは先頭10文字のみ表示
      Logger.log('✅ ' + key + ' : ' + val.substring(0, 10) + '...（マスク）');
    } else {
      Logger.log('✅ ' + key + ' : ' + val);
    }
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (missing === 0) {
    Logger.log('🎉 全' + expectedKeys.length + '件 登録済み');
  } else {
    Logger.log('⚠️ 未登録: ' + missing + '件');
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Bot疎通テスト（トークンが正しいか確認）
 * Telegram API の getMe を叩いて Bot情報が返るかチェック
 */
function testBotTokens() {
  const props = PropertiesService.getScriptProperties();
  const tokens = {
    '予約Bot': props.getProperty('BOT_TOKEN_BOOKING'),
    '業務Bot': props.getProperty('BOT_TOKEN_FIELD')
  };

  Object.keys(tokens).forEach(function(label) {
    const token = tokens[label];
    if (!token) {
      Logger.log('❌ ' + label + ': トークン未登録');
      return;
    }
    try {
      const res = UrlFetchApp.fetch(
        'https://api.telegram.org/bot' + token + '/getMe',
        { muteHttpExceptions: true }
      );
      const data = JSON.parse(res.getContentText());
      if (data.ok) {
        Logger.log('✅ ' + label + ': @' + data.result.username + ' (' + data.result.first_name + ')');
      } else {
        Logger.log('❌ ' + label + ': ' + data.description);
      }
    } catch (err) {
      Logger.log('❌ ' + label + ': ' + err);
    }
  });
}
