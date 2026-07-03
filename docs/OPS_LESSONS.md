# OPS_LESSONS.md — v7-operations 過去のハマりどころ（全文保存版）

> v7-operations/CLAUDE.md から移設（2026-07-03 コンテキストダイエット）。
> 2026-04-18 の Phase 1b 実装中に Claude が実際に踏んだ罠。**新しいミニアプリ・GAS連携を書く前に該当項目を確認すること**。

## 1. 🔥 ミニアプリ → GAS の fetch は v7 booking.html と同じ書式に揃える

**症状**: iOS Safari で `405 Not Allowed`（Google インフラの nginx 405 エラー HTML）。

**原因**: iOS Safari の fetch は GAS の 302 リダイレクト（`script.google.com/.../exec` → `script.googleusercontent.com/macros/echo`）を **POST メソッドを保持したまま**追従する。usercontent サーバは POST を受け付けず 405 を返す。

**解決**: v7 の `booking.html` に実績があるパターンを使う。新しい書き方を試さない。

```javascript
// ✅ 正しい（v7 booking.html と同一）
fetch(GAS_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // ← 明示指定が重要
  body: JSON.stringify({ action: 'xxx', ...params })
}).then(r => r.json())

// ❌ ダメだったパターン（試してはいけない）
// - headers 省略（デフォルト text/plain になるが 405 は出る）
// - body: new URLSearchParams({...})
// - body: FormData
```

GAS 側は `e.postData.contents` を `JSON.parse` する。

**教訓**: 似たシステムに実績のあるパターンがあるなら、まずそれを模倣する。

## 2. 🔥 URL 分解 regex は「先にクエリを落としてから」

**症状**: Telegram WebView で attendance-internal.html へ遷移すると 404。Safari 直打ちでは動く。

**原因**: `window.location.href` が `...html?gas=https://script.google.com/.../exec` のとき、`\/[^\/]*$` が**クエリ内の最後の `/exec`** にマッチし、BASE がファイル名込みになる。

```javascript
// ❌ 順序バグ
var BASE = window.location.href.replace(/\/[^\/]*$/, '').split('?')[0];
// ✅ 先に ? でクエリを落としてから、末尾ファイル名を削る
var BASE = window.location.href.split('?')[0].replace(/\/[^\/]*$/, '');
```

**教訓**: URL を正規表現で切るときは、必ず `?` と `#` を先に落とす。

## 3. 🔥 Telegram Mini App は遷移先ページで `initDataUnsafe.user` が取れない

**症状**: 遷移先ページで chatId が失われ、`first_name` フォールバックで表示名が壊れる。

**原因**: `Telegram.WebApp.initDataUnsafe.user` は**初回起動 URL でのみ**取得できる。ページ間遷移で消える。

**解決**: 初回ページで取得した `chatId` を URL クエリで遷移先に引き継ぐ。

```javascript
// home-internal.html 側
function buildUrl(page) {
  var url = BASE + '/' + page;
  var q = [];
  if (GAS_URL)       q.push('gas=' + encodeURIComponent(GAS_URL));
  if (currentChatId) q.push('chatId=' + encodeURIComponent(currentChatId));
  if (q.length) url += '?' + q.join('&');
  return url;
}
// 遷移先ページ側: URL 優先、なければ Telegram をフォールバック
var params = new URLSearchParams(window.location.search);
if (params.get('chatId')) currentChatId = params.get('chatId');
```

**教訓**: ミニアプリのページ間遷移では、必要な状態は必ず URL クエリで渡す。

## 4. ⚠️ テスト環境は「実際の利用パス」を再現すること

Safari 直打ち（クエリなし）では #2 のバグが発動せず見逃した。Telegram 経由は必ず `?gas=...` 付き。
**教訓**: 動作確認は本番と同じ URL 形式で。クエリの有無で挙動が変わる箇所は要注意。

## 5. 🔥 スタンドアロン GAS で `SpreadsheetApp.getActiveSpreadsheet()` は null

**症状**: 退勤ボタンが常に disabled。日付セルの読み取りが1日ズレる。

**原因**: v7-ops は**スタンドアロン GAS**。`getActiveSpreadsheet()` は null → TZ 参照が `Asia/Phnom_Penh` フォールバックする一方、スプレッドシート本体は別 TZ で日付を保持 → `Utilities.formatDate` と `getValue()` の日付が1日ズレ。

```javascript
// ✅ スタンドアロン GAS では openById を使う
let _sheetTzCache_ = null;
function getSheetTz_() {
  if (_sheetTzCache_) return _sheetTzCache_;
  const id = getConfig().operationsSpreadsheetId;
  _sheetTzCache_ = SpreadsheetApp.openById(id).getSpreadsheetTimeZone() || OPS_TZ;
  return _sheetTzCache_;
}
// ❌ これは v7 (container-bound) でしか動かない
// var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
```

さらにスプレッドシート側 TZ を `Asia/Phnom_Penh` に揃える（`ss.setSpreadsheetTimeZone(OPS_TZ)`）。

**教訓**: container-bound と standalone で GAS API の挙動は違う。日付比較バグは真っ先に「2つの TZ 参照源」を疑う。新プロジェクトでは最初に `getSpreadsheetTimeZone()` をログ出力。

## 6. 💡 Telegram フォーラムトピックの thread_id は URL の真ん中の数字

`https://t.me/c/3856480475/137/142` = `<グループID>/<トピックID=message_thread_id>/<最新メッセージID>`。
**真ん中（137）** が thread_id。末尾を誤認すると `message thread not found` (400)。

## 7. 🧠 Claude 自身への教訓: 分析の繰り返しではなく実行を優先する

ユーザーが原因を理解したら、それ以上の説明は不要。**原因特定 → 修正コード → commit → push → 手順提示を1ターンで完結**させる。デバッグループでは「次の1手」を短く提示してログを待つ。
