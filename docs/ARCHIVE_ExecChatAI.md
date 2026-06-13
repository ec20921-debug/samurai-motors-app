# ARCHIVE: 経営AIチャット（exec_chat）— 封印中の機能

> **ステータス: 実装済み・本番デプロイ済み・封印中（2026-06-13 の経営判断）**
> 「APIを使ってできることは分かった。一旦APIを使わずダッシュボード表示のみで運用し、
> 今回の内容は記録として残す」— 鈴木代表の指示により、コードは温存したままUI非表示・課金ゼロの状態にしてある。

---

## 1. なにを作ったか

経営コックピット（exec-dashboard.html）内のAIチャット。管理者が自然文で質問すると、
実データを根拠に Claude（Anthropic API）が日本語で回答する。

動作確認済みの質問例:
- 「今週のロン君の残金はいまいくら？」→ 前払い管理シート − ロン君負担経費 から残金算出
- 「売上上位の人はだれ？」→ v7予約×顧客の全期間ランキング
- 「今週の経費は？内訳も」「未回収の状況は？」「今後の予約は？」
- フォローアップ質問対応（会話履歴8ターン保持）

## 2. 関連ファイル（すべて現存・削除しないこと）

| ファイル | 内容 |
|---|---|
| `v7-operations/ExecChat.gs` | 本体。データパック生成 + Anthropic Messages API 呼び出し |
| `v7-operations/Router.gs` | `case 'exec_chat'`（exec_share_url の下） |
| `exec-dashboard.html` | チャットUI（FAB・パネル・チップ）。`?chat=1` でのみ表示 |

実装コミット: `14ae85e`（2026-06-13）

## 3. アーキテクチャ要点

- **データパック方式**: 質問ごとに以下を1つのJSONにまとめ、system prompt に同梱
  - v7「予約」「顧客」: 月次売上6ヶ月・今週/本日・顧客別累計TOP10・未回収・今後14日の予約
  - 経費マスター: 今月/先月/今週（明細付き）・カテゴリ別・負担先別・ロン君累計
  - 前払い管理: 送金履歴（列構造は自動検出）→ **残金 = 送金合計 − ロン君負担経費（USD換算）**
  - 設定: 為替（B4/B5）・残金アラート閾値
  - 予約カレンダー（`BOOKING_CALENDAR_ID` 設定時のみ・今後14日）
- パックは CacheService 120秒キャッシュ + system に `cache_control`（プロンプトキャッシュ）
- モデル: `claude-opus-4-8`（`EXEC_CHAT_MODEL` プロパティで変更可）/ adaptive thinking / max_tokens 2048
- 認可: スタッフマスター `role=admin` の chatId のみ（共有キーでは使えない）
- ガード: 質問500字・履歴8ターン・Markdown禁止指示・データ外は「ありません」と答える指示

## 4. 再開手順（3ステップ）

1. GASエディタ（v7-operations）→ プロジェクトの設定 → スクリプトプロパティに
   **`ANTHROPIC_API_KEY`** を追加（console.anthropic.com で発行）
2. ダッシュボードURLに **`&chat=1`** を付けて開く（home-internal経由なら遷移後のURLに手動付与）
   → 右下に💬ボタンが出る
3. （任意）`BOOKING_CALENDAR_ID` = `samuraimotors.japan@gmail.com` を追加するとカレンダー予定も回答対象になる

恒久的に有効へ戻す場合は `exec-dashboard.html` の `CHAT_ENABLED` 初期値を `true` にして push。

## 5. コスト目安（封印理由）

- 1質問あたり入力 ~5-10K tokens + 出力 ~500 tokens
- claude-opus-4-8（$5/$25 per 1M）で **約 $0.04〜0.08/質問**（連続質問はプロンプトキャッシュで割安）
- 安くする場合: `EXEC_CHAT_MODEL` = `claude-haiku-4-5`（約1/5のコスト、精度はやや低下）

## 6. UIだけ確認したいとき（API不要・課金なし）

```
exec-dashboard.html?mock=1&chat=1
```
モック応答でチャットUI・吹き出し・チップの挙動を確認できる。
