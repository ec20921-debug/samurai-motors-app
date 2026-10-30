# HANDOFF: スタッフ専用の操作に本人確認を入れる（StaffGate）— 2026-10-30

> きっかけ: 2026-10-30 の点検で、v7 の Web アプリ（誰でも・ログインなし）の URL を知っていれば、誰でも
> 今日の予約一覧（名前・住所・地図）、顧客チャットの閲覧、予約Bot 名義での送信、作業開始/終了ができると判明。
> 評価メモ: Vault `08_Empire_Security/2026-10-30_Motors_Booking_PII_Exposure_Assessment.md`（L3）。
> Daisuke 裁可: ★1 = **A（本人確認ができたスタッフだけが使えるようにする）**。
> レビュー: code-reviewer ★4・田中（守）とも「audit でのデプロイは可・enforce の前に直すもの」を指摘 → 下の「変更点」に反映済み。

## 変更点（ブランチ `claude/site-monetization-055x7q`）

| ファイル | 中身 |
|---|---|
| `v7/StaffGate.gs`（新規） | スタッフ専用の操作の判定・記録・エディタ用の `showStaffGateAudit()` |
| `v7/Router.gs` | doGet / doPost の入口で判定（enforce の時だけ止める・拒否は `retryable:false`＋`client_id`）。`booking_init` の電話番号は署名で確かめた本人（24時間以内）にだけ返す。冒頭の action 一覧を実物に合わせた |
| `tg-auth.js` | 本人証明を付けるのは**当社の2つの GAS だけ**（`?gas=` の細工で他所に送らない）。Telegram の外では専用リンクの `_fu`/`_fk` を**送る時に**付ける（送信待ち箱の古い記録・旧アプリへの移動も対応） |
| `field/index.html` | 専用リンクの chatId と鍵を同じタブの sessionStorage に置く（tg-auth.js が使う） |
| `job-manager.html` / `job-manager-v2.html` | お客様が入れた名前・場所・車種などを**無害化してから画面に入れる**（ここでスクリプトが動くとスタッフの署名を抜かれる・田中 H1） |
| `saleslog-internal.html` | 専用リンクの鍵は当社の GAS にだけ送る |
| `v7-operations/FieldLink.gs` ほか3か所 | 「FIELD_LINK_SECRET を消せば全員無効」に「v7 と両方同時に」を追記 |
| `v7/TelegramAuth.gs` = `v7-operations/TelegramAuth.gs` | TG_AUTH_MODE が効く範囲のコメント（2つは同一のまま） |
| `tests/v7_staff_gate.test.js`・`tests/tg_auth.test.js`（新規） | 全102件合格（`node --test "tests/*.test.js"`） |

### 判定のしくみ
- スタッフ専用: `booking_today` / `field_partner_shops` / `manual_campaign_list` / `job_start` / `job_start_photos`（10/30 追加・HANDOFF_StartPhotosSplit） / `job_end` / `job` / `chat_history` / `chat_send` / `manual_campaign_create` / `manual_campaign_settle` / `manual_campaign_sale`
- スタッフ = 署名が正しく **24時間以内**の Telegram ユーザーで、スタッフマスター（有効=TRUE）にいる人か管理グループのメンバー／またはホーム画面アプリの専用リンク（鍵が正しく、スタッフマスターにいる人）
- スタッフマスターが一時的に読めない時は、6時間以内に読めた一覧を使う。何も無ければ通さない
- **モード = ScriptProperty `TG_AUTH_MODE`**: 未設定・`audit` は記録だけ（今までどおり動く）／`enforce` で止める。**設定が読めない時は止める側**
- **`STAFF_GATE_ENFORCE_ACTIONS`**（任意・カンマ区切り）: audit のままでも、ここに書いた操作だけ先に止める
- **戻し = `TG_AUTH_MODE` を `audit` に・`STAFF_GATE_ENFORCE_ACTIONS` を空に**（デプロイ不要・すぐ戻る）
- 判定の記録は**ウェブに出さない**。GAS エディタで `showStaffGateAudit` を実行して実行ログで見る

## 本番への反映（PC。順番どおりに）

### 1. v7 の ScriptProperties に2つ足す（Daisuke。秘密を扱うので本人が行う）
Apps Script エディタ（v7）→ プロジェクトの設定 → スクリプト プロパティ:
- `OPERATIONS_SPREADSHEET_ID` = v7-operations の同名プロパティと**同じ値**（スタッフマスターのあるシート）
- `FIELD_LINK_SECRET` = v7-operations の同名プロパティと**同じ値**（ホーム画面アプリの鍵の確認用）
  - ⚠️ 今後この秘密を消す・作り直す時は、**v7 と v7-operations の両方を同時に**
- `TG_AUTH_MODE` は**まだ入れない**（＝audit）。`STAFF_AUTH_MAX_AGE_SEC` は入れなくてよい（既定 24時間）

### 2. 当社の GAS の URL の確認（1回だけ）
`tg-auth.js` の `KNOWN_GAS` は、`field/index.html` の `GAS_URL`（v7）と `OPS_URL`（v7-operations）と同じ2つ。
社内画面（勤怠・経費・日報・営業ログ等）は v7-operations の `INTERNAL_MINIAPP_URL` / `SCOUT_GAS_URL` の `?gas=` や Telegram の起動パラメータで GAS の URL を受け取るので、**その URL が `OPS_URL` と同じか**を確かめる。違ったら `KNOWN_GAS` に足す（足さないと社内画面に署名が付かなくなる）。

### 3. コードの反映
```bash
cd /c/Users/drymp/dev/samurai-motors-app && git fetch origin && git checkout claude/site-monetization-055x7q
node --test "tests/*.test.js"          # 全件合格を確認
cmd //c "C:/Users/drymp/dev/samurai-motors-app/v7/deploy.cmd"   # push → 本番 deploy → ping 確認
```
v7-operations はコメントだけの変更なので、急ぎの反映は不要（次に触る時に一緒に）。

### 4. 画面の配信
`docs/DEPLOY.md` の手順どおり:
- ミニアプリ同期（`tg-auth.js`・`job-manager.html`・`saleslog-internal.html` を含む一覧で配信用リポへコピー）
- 現場アプリ v2（`field/`）: `stamp_build.py` → 配信用リポへコピー → push。スタッフの端末で「新しい版があります」をタップしてもらう
- ※ `job-manager-v2.html` は同期一覧に入っていない（配信していない）。直してはあるが配信は不要

### 5. 記録を見る（反映の翌日から2〜3日）
GAS エディタ（v7）で `showStaffGateAudit` を実行 → 実行ログ:
- `staffSheetReadable: true`・`activeStaffCount` がスタッフの人数・`fieldLinkConfigured: true`
- `counts` のキーは `操作|結果|経路`。経路 = `tg`（Telegram）/ `link`（専用リンク）/ `none`（本人証明なし。匿名の分は10秒に1件だけ記録）、`+cid` は送信待ち箱から
- 下の確認表を、**実際にアプリを操作して1つずつ** `ok_*` にする（数日待つだけでは使われない操作がある）

| 操作 | 現場アプリ（Telegram） | 現場アプリ（ホーム画面） | 業務ミニアプリ（Telegram） | ホーム画面→旧アプリ |
|---|---|---|---|---|
| booking_today | ☐ | ☐ | ☐ | ☐ |
| field_partner_shops | ☐ | ☐ | — | — |
| job_start / job_end | ☐ | ☐ | ☐ | ☐ |
| job_start_photos（10/30 追加） | ☐ | ☐ | — | — |
| job | — | — | ☐ | ☐ |
| chat_history / chat_send | — | — | ☐ | ☐ |
| manual_campaign_list / _settle / _sale | — | — | ☐ | ☐ |

- `deny_*` の読み方: `tg_not_staff` = スタッフマスターに Chat ID が無い人（`fails` の `u4` が Chat ID の末尾4桁）、`no_auth|none` = 本人証明なし（古い版のアプリか外部）、`link_bad` = 鍵の不一致（v7 と v7-operations の FIELD_LINK_SECRET の食い違いを疑う）、`tg_expired` = 24時間より前に開いた画面
- あわせて `?action=auth_audit` で署名の通り具合も確認（9/25〜の記録。14日で消えるので早めに保存）

### 6. 止める（Daisuke の OK のあと）
- 先に止めてよいもの: `chat_send`・`chat_history` は Telegram の業務ミニアプリからしか呼ばれない。`auth_audit` でこの2つが常に `valid_match` なら、手順3の直後に `STAFF_GATE_ENFORCE_ACTIONS` = `chat_send,chat_history` でよい（お客様への送信の穴が初日から閉じる）
- 全部: 確認表が全部 ☑ になったら `TG_AUTH_MODE` = `enforce`。すぐに現場アプリ・業務ミニアプリで予約一覧と作業開始が動くことを確認
- **何か止まったら `TG_AUTH_MODE` を `audit` に戻す**（デプロイ不要）。enforce にした日を評価メモに「§2 を閉じた日」として書く

## まだやっていないこと（別の判断・別の作業）
- お客様側の操作（`booking_init` の名前・流入元、`booking_register_customer`、`booking_create`）の本人確認。chatId を知っていれば名前や住まいのレジデンス名が取れ、予約Bot から確定通知を送れる状態が残る（田中 M1）。`auth_audit` の `booking_create|valid_match` の割合を見てから、本人の署名を必須にするか判断する
- `auth_audit`（TelegramAuth.gs）はまだウェブに公開されている。記録を保存したら閉じる（v7 と v7-operations で同一のファイルなので両方そろえて）
- 社内画面の `?gas=`・起動パラメータで GAS の URL を差し替えられる（本人証明は付かなくなったが、偽の画面は出せる）。URL の確認（手順2）が済んだら、各ページでも当社の GAS だけ受け付けるようにする
- 専用リンクの鍵の確かめ方を、秘密を2か所に置かない形（スタッフマスターに鍵のハッシュの列を v7-operations が書き、v7 は照合だけ）に変える（田中の推奨）
- v7-operations の `exec_chat` / `exec_dashboard` / `exec_share_url` は名乗った管理者の chatId だけで通る（お客様の名前を外部の AI に送る経路を含む）。`fieldLinkIssue_` と同じ「署名＋admin＋24時間」にそろえる（別途 Daisuke 判断）
- 誰がやったかの記録（gate の結果の userId を下流の `_authUserId` に入れる）は enforce と同時に
