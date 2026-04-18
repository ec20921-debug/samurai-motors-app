# CLAUDE.md — Samurai Motors v7-operations

本プロジェクトは、Samurai Motors の**勤務系（現場スタッフの勤怠・日報・経費・タスク管理）** を担う Google Apps Script プロジェクトです。v7（顧客対応系）とは完全に別の GAS プロジェクト・別の Telegram Bot で稼働します。

---

## 🎯 スコープ

| ✅ 対象 | ❌ 対象外 |
|---|---|
| 勤怠打刻（GPS付き） | 予約・顧客チャット |
| タスク管理（配布・完了報告） | 決済・QRコード |
| 日報入力 | 顧客マスター・車両管理 |
| 経費入力（レシートOCR） | 料金設定 |
| 管理コンソール（ダッシュボード） | 業務Bot との通信 |

v7 (顧客系) との分離は厳格に。互いに参照・呼び出ししない。

---

## 🏗 構成

```
v7-operations/ （本ディレクトリ）
├── Config.gs            — 設定定数、PropertiesService 参照
├── Router.gs            — doGet/doPost ルーティング
├── TelegramAPI.gs       — 勤務Bot API ラッパー
├── SheetHelpers.gs      — シート CRUD + スタッフマスターキャッシュ
├── QueueManager.gs      — 非同期キュー
├── BotPoller.gs         — 勤務Bot の getUpdates ポーリング
├── Setup.gs             — 初回シート作成（スタッフマスター・勤怠記録 等）
├── AttendanceManager.gs — 勤怠（Phase 1b で追加）
├── TaskManager.gs       — タスク管理（Phase 2 で追加）
└── ...（日報/経費/管理コンソールは後続 Phase）
```

---

## 🤖 勤務Bot の責務

- ポーリングで update 取得
- ミニアプリ（`home-internal.html`）からの API リクエスト受付（doGet/doPost）
- Admin トピックへの通知（打刻・タスク配布・日報リマインダー等）

---

## 📊 スプレッドシート

v7 の顧客用スプレッドシートとは**別ファイル**（勤務専用）を使う。
- PropertiesService キー: `OPERATIONS_SPREADSHEET_ID`
- 既存の v5/v6 時代のスプレッドシートを流用（Tasks, Expenses, DailyReports, Attendance 等が入っているもの）
- 新設シート: `スタッフマスター`

---

## 🔗 管理グループの共有

Admin グループ（フォーラム）は v7 と v7-ops で共通利用する。
- `ADMIN_GROUP_ID` は v7 と同値
- ただし topic は用途別に使い分ける（顧客トピック ≠ 勤怠通知トピック）
- topic ID 管理は各プロジェクトが独立して行う

---

## 🚫 禁止事項（v7 と共通）

- Botトークン等のハードコード
- CacheService でキュー管理
- doPost 内で重い処理
- `rm -rf` 無確認実行

---

## 🪶 コード肥大化防止

- 1ファイル 500行 超えたら責務分割
- 全体 2,500 行を目標（v7-ops は機能少なめ）
- セットアップ・移行コードは初回実行後削除

---

## ⚠️ 過去のハマりどころ（Phase 1b 実装中に発生、必読）

以下は 2026-04-18 の実装中に Claude が実際に踏んだ罠。**新しいミニアプリを書く時は最初にこのセクションを確認してから実装すること**。

### 1. 🔥 ミニアプリ → GAS の fetch は v7 booking.html と同じ書式に揃える

**症状**: iOS Safari で `405 Not Allowed` が返る（Google のインフラから nginx の 405 エラー HTML）。

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

**教訓**: **似たシステムに実績のあるパターンがあるなら、まずそれを模倣する**。新しい方式を試すのは実績パターンが動かないと確認した後。

### 2. 🔥 URL 分解 regex は「先にクエリを落としてから」

**症状**: Telegram WebView で attendance-internal.html へ遷移すると 404。Safari 直打ちでは動く。

**原因**: home-internal.html の BASE URL 計算：
```javascript
// ❌ 順序バグ
var BASE = window.location.href.replace(/\/[^\/]*$/, '').split('?')[0];
```
`window.location.href` が `.../home-internal.html?gas=https://script.google.com/.../exec` の形式のとき、regex の `\/[^\/]*$` は**クエリ内の最後の `/exec`** にマッチしてしまい、BASE が `.../home-internal.html`（ファイル名込み）になる。結果、遷移先が `.../home-internal.html/attendance-internal.html` で 404。

**解決**:
```javascript
// ✅ 先に ? でクエリを落としてから、末尾ファイル名を削る
var BASE = window.location.href.split('?')[0].replace(/\/[^\/]*$/, '');
```

**教訓**: URL 文字列を正規表現で切るときは、**必ず `?` と `#` を先に落とす**。クエリ値には `/` `?` `&` `=` なんでも入る。

### 3. 🔥 Telegram Mini App は遷移先ページで `initDataUnsafe.user` が取れない

**症状**: home-internal.html で「ロン」と表示できたのに、勤怠打刻ページへ遷移すると chatId が失われ「D」になる（`first_name` にフォールバックして Telegram アカウントの名前になる）。

**原因**: `Telegram.WebApp.initDataUnsafe.user` は**初回起動 URL でのみ**取得できる。ページ間遷移ではその値は消える。

**解決**: 初回ページ（home-internal.html）で取得した `chatId` を URL クエリパラメータで遷移先に引き継ぐ。

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

// 遷移先ページ側
var params = new URLSearchParams(window.location.search);
if (params.get('chatId')) currentChatId = params.get('chatId');
// ↑ URL 優先、なければ Telegram をフォールバックで見る
```

**教訓**: ミニアプリのページ間遷移では、**必要な状態は必ず URL クエリで渡す**。Telegram SDK は初回URLにしか情報を入れない。

### 4. ⚠️ テスト環境は「実際の利用パス」を再現すること

**症状**: Safari 直打ちで動くのに Telegram 経由だと 404（上記 #2 のバグ）。

**原因**: Safari 直打ちの URL にはクエリを付けていなかったため、regex バグが発動せず見逃していた。Telegram 経由だと必ず `?gas=...` が付く。

**教訓**: 動作確認は **本番と同じ URL 形式**で行う。特にクエリパラメータの有無・内容で挙動が変わる箇所は要注意。

### 5. 🔥 スタンドアロン GAS で `SpreadsheetApp.getActiveSpreadsheet()` は null

**症状**: 出勤打刻はシートに書き込めるのに、退勤ボタンが常に disabled。`findTodayRow_` のログで `target=2026-04-18` なのにシート上の日付セルが `2026-04-17` と読める（1日ズレ）。

**原因**: v7-ops は**スタンドアロン GAS**（スプレッドシートに紐付かない独立プロジェクト）。この場合 `SpreadsheetApp.getActiveSpreadsheet()` は **null を返す**。
`getSheetTz_()` が null チェック失敗で OPS_TZ (`Asia/Phnom_Penh`) にフォールバックしていた一方、スプレッドシート本体は別TZ（GMT など）で日付セルを保持していたため、`Utilities.formatDate` の結果と `getValue()` が返す Date オブジェクトの表示日付が1日ズレていた。

**解決**:
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

さらに、スプレッドシート側の TZ を `Asia/Phnom_Penh` に揃えておく（`ss.setSpreadsheetTimeZone(OPS_TZ)`）。

**教訓**:
- **v7（container-bound）と v7-ops（standalone）で GAS API の挙動は違う**。v7 からコピペしたコードはこの差異で壊れる。
- 日付比較系バグは真っ先に **TZ** を疑う。`Utilities.formatDate(tz)` と `Date.getTime()` はズレない、**ズレているのは 2つの TZ 参照源**。
- 新プロジェクトでは最初に `getSpreadsheetTimeZone()` をログ出力して確認する。

### 6. 💡 Telegram フォーラムトピックの thread_id は URL の**真ん中**の数字

**症状**: `sendMessage` で `message thread not found` (400)。ScriptProperty に入れた topic ID が間違っていた。

**原因**: トピック URL `https://t.me/c/3856480475/137/142` の構造を誤解していた。
- `3856480475` = グループ ID
- `137` = **トピック ID（message_thread_id）** ← これが正解
- `142` = そのトピック内の最新メッセージ ID

末尾の `142` を thread_id と誤認していた。

**教訓**: Telegram フォーラムトピックの URL は `t.me/c/<group>/<topic>/<msg>` 形式。**真ん中**を取る。

### 7. 🧠 Claude 自身への教訓：分析の繰り返しではなく実行を優先する

**症状**: ユーザーから「原因の説明は理解した。修正コードを出して、commit して push して。分析の繰り返しではなく、修正の実行を求めてください」と指摘された。

**原因**: バグの原因説明を何度も丁寧に繰り返し、修正コミット＆プッシュに進むのが遅かった。ユーザーはすでに原因を理解しているのに、Claude が説明モードに留まっていた。

**解決・教訓**:
- 原因特定 → 修正コード → commit → push → ユーザーへ手順提示、という**一連を1ターンで完結**させる。
- ユーザーが「わかった」「理解した」と言ったら、**それ以上の原因説明は不要**。即実行。
- デバッグループでは「次の1手」を短く提示し、ログを待つ。長文の解説は後でまとめて CLAUDE.md に書けば良い。

---

## 📋 現在の Phase

**Phase 1a**: 基盤整備（本ドキュメント時点） ⬅️ 現在位置
**Phase 1b**: 勤怠打刻（GPS付き）
**Phase 1c**: Admin通知 + 履歴API
**Phase 1d**: ミニアプリ hub 分離（業務Bot から勤務項目削除、home-internal.html 新設）
**Phase 2**: タスク管理
**Phase 3**: 日報
**Phase 4**: 経費
**Phase 5**: 管理コンソール
