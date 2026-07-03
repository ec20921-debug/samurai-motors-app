# HANDOFF — ミニアプリ配信リポジトリ分離（2026-07-03）

> **📌 STATUS: 切替保留（2026-07-03 Daisuke 判断）**
> 現状のまま（旧URL配信・本体 public）で全機能正常稼働中。急ぐ理由はなく、下記①〜⑥は Daisuke が実施したくなったタイミングでいつでも再開できる。
> **保留中の絶対条件**: 本体 `samurai-motors-app` を private 化しない（7/3 障害の再発）／ `samurai-motors-miniapp` も消さない・private 化しない（チラシ FLYER_URL がここから配信中）。

Daisuke の手動作業チェックリスト。**上から順に実施**。全部終わるまで本体リポジトリを private 化しないこと（途中で private 化すると旧URLが404になり再障害）。

## 済んでいること（Claude 実施済み）

- ✅ 配信専用 public リポジトリ `ec20921-debug/samurai-motors-miniapp` 作成（配信14ファイル + README）
- ✅ GitHub Pages 有効化（main / root）。**全14ファイル HTTP 200 確認済み**
  - 新ベースURL: `https://ec20921-debug.github.io/samurai-motors-miniapp/`
- ✅ `v7/BookingBot.gs` の `FLYER_URL` を新URLに変更 → clasp push 済み
- ✅ CLAUDE.md / docs/DEPLOY.md / docs/HANDOFF_ManualCampaignBooking.md に配信構成変更を記録

## 残作業（Daisuke の手動作業）

### ① v7（顧客系 GAS）の Script Properties 更新

GAS エディタ（ec20921@gmail.com）→ v7 プロジェクト → ⚙️ プロジェクトの設定 → スクリプト プロパティ:

- URL 系プロパティの値のうち `/samurai-motors-app/` の部分を `/samurai-motors-miniapp/` に置き換える（ファイル名部分はそのまま）
- 対象（存在するもの）: `BOOKING_MINIAPP_URL` / `JOB_MANAGER_MINIAPP_URL`（`FIELD_MINIAPP_URL` という名前で登録されている場合はそれ）
  - 例: `https://ec20921-debug.github.io/samurai-motors-app/booking.html` → `https://ec20921-debug.github.io/samurai-motors-miniapp/booking.html`

### ② 予約Bot メニューボタンの再設定（GAS から1回実行）

v7 GAS エディタ → `BookingBot.gs` → 関数 `setupBookingBotMenuButton` を選択 → 実行

- 全ユーザー共通の「🚗 Booking」ボタンが新URLになる
- 個別設定済みユーザーは /start 時・6時間キャッシュ失効時に自動で新URLに置き換わる（自己修復あり）

### ③ v7-operations（社内業務系 GAS）の Script Properties 更新

同様に `INTERNAL_MINIAPP_URL` の `/samurai-motors-app/` → `/samurai-motors-miniapp/`

### ④ BotFather 側の URL 確認・更新

@BotFather → `/mybots` → 各Bot → **Bot Settings → Menu Button** および **Configure Mini App** を確認:

- **業務Bot**（現場スタッフ用）: 旧URLが設定されていれば新URLに変更（`.../samurai-motors-miniapp/index.html` 等、現在の設定値のリポジトリ名部分だけ差し替え）
- **社内Bot**: 同上
- **予約Bot**: ②の GAS 実行でAPI側から設定されるため原則不要。ただし BotFather に Mini App 設定があれば合わせて更新

### ⑤ 動作確認

- 予約Bot に `/start` → チラシ画像が届く + 左下「🚗 Booking」でミニアプリが開く
- 業務Bot からミニアプリ（job-manager）が開く
- 社内Bot の勤怠ボタン（Open App）が開く
- exec-dashboard: 新共有URL `https://ec20921-debug.github.io/samurai-motors-miniapp/exec-dashboard.html?key=<共有キー>` で表示確認 → **共有相手（飯泉さん等）に新URLを再送**（旧URLは private 化で無効になる）

### ⑥ 本体リポジトリの private 化（最終ステップ）

⑤まで全部OKになってから:

```bash
gh repo edit ec20921-debug/samurai-motors-app --visibility private --accept-visibility-change-consequences
```

（または GitHub Web → samurai-motors-app → Settings → Danger Zone → Change visibility）

private 化後にもう一度 ⑤ の動作確認をして完了。

## 補足

- 旧URL（`.../samurai-motors-app/...`）は private 化するまで生きているため、①〜④ は無停止で切り替え可能
- 今後ミニアプリ・チラシを変更したときの配信側への同期手順は `docs/DEPLOY.md` の「ミニアプリ / 静的アセットの配信」参照
