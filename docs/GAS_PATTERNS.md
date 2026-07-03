# GAS_PATTERNS.md — v7 実装パターン集（コード例・詳細版）

> CLAUDE.md から移設（2026-07-03 コンテキストダイエット）。ルールの要点は CLAUDE.md、コード例と背景はこちら。

## 1. doPost 非同期キュー方式（v6 崩壊の再発防止・最重要）

Telegram Webhook（`doPost`）は**必ず1秒以内に `ok` を return**。遅いと Telegram がリトライ → 重複通知スパム（v6 崩壊の直接原因）。

```javascript
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const updateId = data.update_id;

    // ① 重複排除チェック
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('processed_' + updateId)) {
      return ContentService.createTextOutput('ok'); // 既に処理済み
    }

    // ② キューに投入（これだけ。重い処理は絶対にしない）
    enqueueTelegramUpdate(data, botType);

    // ③ 即return（1秒以内）
    return ContentService.createTextOutput('ok');
  } catch (err) {
    Logger.log('doPost error: ' + err);
    return ContentService.createTextOutput('ok'); // エラーでも ok（リトライ防止）
  }
}
```

- 実処理（送信・シート書込・画像保存）はすべて `processTelegramQueue()`（1分トリガー）側で実行

### ❌ アンチパターン

```javascript
// 絶対ダメ（Telegram がリトライ→重複スパム）
function doPost(e) {
  sendMessage(...);        // API呼び出し
  saveToSheet(...);        // シート書き込み
  uploadToDrive(...);      // 画像保存
  return ContentService.createTextOutput('ok');
}
```

## 2. PropertiesService / CacheService 使い分け

### ScriptProperties（永続・失うと業務影響が出るもの）

| データ | キー形式 | 理由 |
|---|---|---|
| Telegramキュー | `queue_{timestamp}_{update_id}` | GAS再起動でも失えない |
| update_id重複排除マーカー | `processed_{update_id}` | 24h保持が必要（Cacheの6h制限では不足） |
| Botトークン・設定値 | `BOT_TOKEN_BOOKING` 等 | 永続必須 |

### CacheService（短期・揮発でよいもの）

| データ | キー形式 | TTL | 理由 |
|---|---|---|---|
| 管理者返信状態 | `admin_reply_{admin_chat_id}` | 300秒 | 放置されれば自動失効すべき |
| 料金表キャッシュ | `plan_prices_cache` | 60秒 | 失っても再取得可能 |
| 空き枠キャッシュ | `available_slots_{date}` | 60秒 | 失っても再取得可能 |

### 判断フロー

```
このデータは失われると業務影響が出る？ / GAS再起動・6時間後も保持が必要？
├── YES → ScriptProperties（永続）
└── NO  → CacheService（揮発）
```

### ❌ アンチパターン（v6 で実際に通知消失した）

```javascript
// 絶対ダメ（6時間TTL・サイズ制限でデータ損失）
CacheService.getScriptCache().put('queue_' + ts, payload);

// 正しい（永続）
PropertiesService.getScriptProperties().setProperty('queue_' + ts, payload);
```

## 3. トークン・機密情報

```javascript
// ❌ 絶対ダメ
const BOT_TOKEN = "1234567890:ABCdef...";

// ✅ 正しい
const BOT_TOKEN = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN_BOOKING');
```

対象: Botトークン、スプレッドシートID、管理者chat_id、ADMIN_GROUP_ID など。コミット前に必ずチェック。

## 4. v6 から学んだこと（歴史的教訓）

- v6 は単一 GAS ファイルが 6,000行超に肥大化 → 通知遅延・重複送信・動作不安定で崩壊（2026-04-18 廃止）
- 「あとで消そう」は絶対に消されない → **書くときに分離する**
- 「念のため残しておこう」は積もる → **使わないものは即削除**
- テスト関数 `testXXX()` は本番にコミットしない → Debug.gs へ隔離し本番マージ前に削除
- セットアップ・移行コード（`Setup*.gs` / `Migration_*.gs`）は初回実行後、本番 GAS から削除（ローカル & GitHub には残す）
- `Setup.gs` が空の場合それは正常（セットアップ済みの意味）。復元しないこと

## 5. 実装時の自問ルール

1. この関数は毎日/毎週動く？ → NO なら本番コードから分離
2. 同じようなコードが他にある？ → 共通化チェック
3. 今後も使う可能性が高い？ → 低いなら削除候補マーク
4. コメント・ログが過剰でない？ → 必要最小限に
