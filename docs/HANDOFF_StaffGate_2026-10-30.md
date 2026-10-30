# HANDOFF: スタッフ専用の操作に本人確認を入れる（StaffGate）— 2026-10-30

> きっかけ: 2026-10-30 の点検で、v7 の Web アプリ（誰でも・ログインなし）の URL を知っていれば、誰でも
> 今日の予約一覧（名前・住所・地図）、顧客チャットの閲覧、予約Bot 名義での送信、作業開始/終了ができると判明。
> 評価メモ: Vault `08_Empire_Security/2026-10-30_Motors_Booking_PII_Exposure_Assessment.md`（L3）。
> Daisuke 裁可: ★1 = **A（本人確認ができたスタッフだけが使えるようにする）**。

## 変更点（ブランチ `claude/site-monetization-055x7q`）

| ファイル | 中身 |
|---|---|
| `v7/StaffGate.gs`（新規） | スタッフ専用の操作の判定・記録・`staff_gate_audit` |
| `v7/Router.gs` | doGet / doPost の入口で判定（enforce の時だけ止める）。`booking_init` の電話番号は署名で確かめた本人にだけ返す。冒頭の action 一覧を実物に合わせた |
| `field/index.html` | ホーム画面アプリ（専用リンク）の時、予約一覧・提携店・作業の開始/終了に chatId と鍵（`_fu` / `_fk`）を付ける |
| `tests/v7_staff_gate.test.js`（新規） | 判定・audit/enforce・電話番号の確認 |

- スタッフ専用: `booking_today` / `field_partner_shops` / `manual_campaign_list` / `job_start` / `job_end` / `job` / `chat_history` / `chat_send` / `manual_campaign_create` / `manual_campaign_settle` / `manual_campaign_sale`
- スタッフ = 署名が正しい（7日以内）Telegram ユーザーで、スタッフマスター（有効=TRUE）にいる人か管理グループのメンバー／またはホーム画面アプリの専用リンク（鍵が正しく、スタッフマスターにいる人）
- **モード = ScriptProperty `TG_AUTH_MODE`**: 未設定・`audit` は記録だけ（今までどおり動く）／`enforce` で止める。**戻しは `audit` に戻すだけ（デプロイ不要）**

## 本番への反映（PC。順番どおりに）

### 1. v7 の ScriptProperties に2つ足す（Daisuke。秘密を扱うので本人が行う）
Apps Script エディタ（v7）→ プロジェクトの設定 → スクリプト プロパティ:
- `OPERATIONS_SPREADSHEET_ID` = v7-operations の同名プロパティと**同じ値**（スタッフマスターのあるシート）
- `FIELD_LINK_SECRET` = v7-operations の同名プロパティと**同じ値**（ホーム画面アプリの鍵の確認用）
- `TG_AUTH_MODE` は**まだ入れない**（＝audit）

### 2. コードの反映
```bash
cd /c/Users/drymp/dev/samurai-motors-app && git fetch origin && git checkout claude/site-monetization-055x7q
node --test "tests/*.test.js"          # 全件合格を確認
cmd //c "C:/Users/drymp/dev/samurai-motors-app/v7/deploy.cmd"   # push → 本番 deploy → ping 確認
```

### 3. 現場アプリ（field/）の配信
`docs/DEPLOY.md`「現場アプリ v2（field/）の配信」の手順どおり（`stamp_build.py` → 配信用リポジトリへコピー → push）。
スタッフの端末で「新しい版があります」をタップしてもらう。

### 4. 記録を見る（反映の翌日から2〜3日）
ブラウザで `<v7 の /exec の URL>?action=staff_gate_audit&days=3`
- `configured.staffList` と `configured.fieldLink` が両方 `true`
- 現場アプリ・業務ミニアプリを使った操作が全部 `ok_tg_staff` / `ok_tg_admin` / `ok_link_staff`
- `deny_*` が出ていたら理由を見る（`tg_not_staff` = スタッフマスターに Chat ID が無い人、`link_bad` = 古い版の現場アプリ など）。正規の人の deny が0になるまで直す
- あわせて `?action=auth_audit` で署名の通り具合も確認

### 5. 止める（Daisuke の OK のあと）
ScriptProperty `TG_AUTH_MODE` = `enforce`。すぐに現場アプリ・業務ミニアプリで予約一覧と作業開始が動くことを確認。
**何か止まったら `TG_AUTH_MODE` を `audit` に戻す**（デプロイ不要・すぐ戻る）。

## まだやっていないこと（別の判断・別の作業）
- お客様側の操作（`booking_register_customer` / `booking_create`）の本人確認は、署名の記録を見てから別に判断する
- v7-operations 側（営業アプリの合言葉の取り出し等）は今回の範囲外
- 署名の記録（`auth_audit`）は14日で消える。消える前に保存（評価メモの後始末チェック表）
