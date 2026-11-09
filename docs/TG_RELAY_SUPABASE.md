# 予約Bot の返事を速くする — Supabase の受付（段階①・2026-11-09）

Daisuke「予約の部分もサクサク動くようにしたい」→ 段階①を A で決定（2026-11-09）。

## しくみ（ひとことで）

- **今まで**: GAS が1分に1回、Telegram に「新しいメッセージある？」と聞きに行く（`v7/BotPoller.gs`）→ 返事まで最大60秒待ち
- **これから**: Telegram が届いた瞬間に Supabase の受付（Edge Function `tg-relay`）へ送る → 受付がすぐ GAS に渡す → GAS がその場で処理 → **返事は数秒**
- **データ（シート）・カレンダー・Bot の処理の中身は何も変えない。** 変えるのは「受け取り方」だけ
- 受付が止まっても Bot は黙らない: GAS の見張りが気づいて、自動で今の「1分ごと」に戻し、管理グループに知らせる。未配達のメッセージは Telegram が預かっているので消えない
- 予約がゼロの週でも Supabase は止まらない: GAS が1時間に1回、受付を見回り、受付が Supabase の表に1行書く（無料版の「7日使わないと止まる」は「データベースが使われたか」で決まるため）

| 場所 | ファイル |
|---|---|
| Supabase の受付 | `supabase/functions/tg-relay/index.ts` と `relay.js`（2つで1組） |
| Supabase の表 | `supabase/tg_relay.sql` |
| GAS | `v7/TgRelay.gs`（受け口・見張り・切り替え）、`Router.gs`（`tg_relay` / `tg_drain`）、`QueueManager.gs`（キューの処理を1本ずつに）、`BotPoller.gs`（受付で受けている Bot は聞きに行かない） |
| テスト | `tests/v7_tg_relay.test.js`、`tests/tg_relay_edge.test.js` |

```
お客様 → Telegram ─(届いた瞬間)→ Supabase の受付 ─→ GAS doPost: tg_relay（キューに積むだけ）
                                                 └→ GAS doPost: tg_drain（その場で処理 → 返事）
GAS の1分ごとの処理: 見張り（5分ごとに webhook の状態・1時間ごとに受付の health）＋ 取りこぼしの再処理
```

## 合言葉は2つ（チャット・メール・シートには書かない）

| 名前 | 何と何の間 | 作り方 |
|---|---|---|
| `TG_WEBHOOK_SECRET` | Telegram → 受付 | 1Password で「英数字のみ・40文字」のパスワードを作る |
| `TG_RELAY_KEY`（受付側の名前は `GAS_RELAY_KEY`） | 受付 → GAS | 1Password で別にもう1つ（英数字のみ・40文字） |

1Password に「Samurai Motors 予約Bot 受付」として2つとも保存する。

## 入れる手順

順番が大事です。**1〜3 をやっただけでは何も変わりません**（GAS は今までどおり1分ごと）。4 で初めて切り替わります。営業時間外に。

### 1. Supabase に表と受付を作る（Daisuke・10分・無料）

**プロジェクトは新しく作らない**（無料版は2つまで）。スタッフ名鑑の `samurai-staff`（シンガポール）を使う。

1. Supabase → `samurai-staff` → 左の **SQL Editor** → `supabase/tg_relay.sql` の中身を全部貼る → **Run**（「Success」なら OK）
2. 左の **Edge Functions** → **Deploy a new function** → **Via Editor**
   - 関数の名前: `tg-relay`
   - ファイルを2つにする: `index.ts` に `supabase/functions/tg-relay/index.ts` の中身、**ファイルを追加**して `relay.js` に `supabase/functions/tg-relay/relay.js` の中身
   - **Deploy**
3. できた関数の **Details（設定）** で **JWT の確認（「Verify JWT」「Enforce JWT Verification」などの名前のスイッチ）をオフ** → 保存（Telegram は Supabase の鍵を持っていないため。代わりに合言葉で守る）
4. **Edge Functions → Secrets** に3つ入れる

| 名前 | 値 |
|---|---|
| `GAS_EXEC_URL` | 予約Bot（v7）のウェブアプリの URL（`https://script.google.com/macros/s/…/exec`。予約画面 booking.html の `GAS_URL` と同じ） |
| `GAS_RELAY_KEY` | 1Password の2つ目の合言葉 |
| `TG_WEBHOOK_SECRET` | 1Password の1つ目の合言葉 |

5. 関数の URL を控える: `https://〇〇.supabase.co/functions/v1/tg-relay`（関数の画面に出ている）

### 2. GAS に設定を入れる（Daisuke・PC）

v7 の GAS エディタ → プロジェクトの設定 → **スクリプト プロパティ** に3つ（Script Properties は今 50 個未満であることを `showQueueStatus()` で確認してから）

| プロパティ | 値 |
|---|---|
| `TG_RELAY_URL` | 1-5 の関数の URL |
| `TG_RELAY_KEY` | 1Password の2つ目の合言葉（Supabase の `GAS_RELAY_KEY` と同じ） |
| `TG_WEBHOOK_SECRET` | 1Password の1つ目の合言葉（Supabase と同じ） |

### 3. GAS を反映する（PC）

1. `v7/deploy.cmd`（docs/DEPLOY.md。ウェブアプリの版が新しくなる）→ ping で build を確認
2. GAS エディタで **`tgRelayStatus`** を実行 →「設定: 揃っている」「health: {"ok":true,…}」が出れば準備 OK（まだ切り替わっていない）
   - health が通らない時: Supabase の Secrets（3つ）と、JWT の確認がオフになっているかを見直す

### 4. 予約Bot を受付に切り替える（営業時間外）

1. GAS エディタで **`tgRelayEnableBooking`** を実行 →「✅ booking を受付（Supabase）に切り替えました」
2. 自分の Telegram から予約Bot に `/start` を送る → **数秒で**返事が来れば成功
3. Supabase の Table Editor → `relay_heartbeat` に `booking` と `gas` の行がある
4. 「システム変更」タブに1行（例: 「予約Botの返事が、最大1分待ちから数秒になりました」・対象=予約Bot）
5. 1週間様子を見る。問題なければ業務Bot も `tgRelayEnableField` で切り替えてよい（任意）

## 戻し方

- **すぐ戻す**: GAS エディタで `tgRelayDisableBooking` を実行 → 今までの1分ごとに戻る（未配達のメッセージはそのまま拾う）
- **GAS エディタが開けない時の非常口**: スクリプト プロパティの `TG_RELAY_URL` を消す → 次の1分の見張りで自動的に1分ごとに戻る
- **自動で戻る時**（何もしなくてよい）: 受付への配達失敗が5分おきの見張りで2回続いた／受付の health が1時間おきの見回りで2回続けて失敗した／Telegram の登録先がずれていた → 管理グループに「⚠️ 予約Botの受付（Supabase）を止めて、1分ごとの受け取りに戻しました」が届く。直したら `tgRelayEnableBooking` で受付に戻す
- **v7 の版ごと戻す時**（`rollback.cmd`）: **先に `tgRelayDisableBooking` を実行してから**戻す（古い版は受付を知らないので、webhook が付いたままだと1分ごとの受け取りが止まる）

## Supabase が止まったら（無料版の一時停止）

- 止まることはまず無い（GAS が1時間に1回、表に1行書く）。それでも止まった時は、上の自動の戻しで Bot は1分ごとに戻る
- Supabase の画面でプロジェクトの **Restore**（再開）を押す → 数分で戻る → `tgRelayEnableBooking`
- 公式の説明では、止まってから1年間はデータごと戻せる。この段階の元のデータはシートなので、Supabase 側に失って困るものは無い

## 気をつけること

- **合言葉を変える時**は、Supabase の Secrets と GAS の Script Properties を両方変えてから `tgRelayEnableBooking` を実行し直す（Telegram に新しい合言葉を登録し直すため）
- 予約Bot（v7）のウェブアプリの URL が変わったら（新しいデプロイ ID）、Supabase の `GAS_EXEC_URL` も変える。`deploy.cmd` は同じ URL のまま版を上げるので、通常は変わらない
- お客様のメッセージの中身は Supabase に残らない（表に書くのは Bot の種類・時刻・update_id だけ）
- 受付は Supabase の無料枠の「Edge Function の呼び出し」を使う（1か月 50万回まで。今の規模では1か月数千回の見込み）
- キューの処理は1本ずつになった（UserLock）。同時に届いても二重に返事しない
