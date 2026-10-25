# Run Kosal の秘書 dots（ドッちゃん）— 日報を GSS に記録・報連相を管理グループへ（設定手順）

> 2026-10-24 Daisuke 指示「Run Kosal に ChatGPT の dots で日報などを入れてもらい対話してもらう。dots を秘書役にして、半日に1回まとめて Telegram の管理グループに配信」。
> 2026-10-25 改訂（Daisuke）:「日報は dots と会話してもらって、最後に日報を毎日 GSS に自動で記録して、さらに日本語で管理グループへ毎日記録されたら通知」「ドッちゃんはロン君の秘書としてクメール語で対応してほしい。状況を管理グループにいい感じで通知して報連相のかわりとしたい」。
> - ChatGPT は Run Kosal の会社用 Gmail でログイン済み（dots の名前は「ドッちゃん」）
> - クメール語ゲートの例外（Daisuke 2026-10-25「この会話だけ例外にする」）: **ドッちゃんと Run Kosal のその場の会話だけ**は Panha を通さずクメール語でよい。お客様・お店・SNS など外へ出すクメール語は今までどおり Panha 必須。管理グループへの通知は日本語

## 仕組み（全体図）

```
Run Kosal ──クメール語で話す──▶ ドッちゃん（ChatGPT dots・Run Kosal の会社用 Gmail でログイン）
                                   │ 日本語のメールを作る
             ┌─────────────────────┴─────────────────────┐
   日報（1日1通・Run Kosal が「送って」と言った時）    報連相（その都度・相談/困りごと/お店とのやりとり）
   件名 [SM-DOTS] 日報 YYYY-MM-DD                     件名 [SM-DOTS] 相談 / 報告 / 連絡 / 緊急 ＋ 件名
             └─────────────────────┬─────────────────────┘
                                   ▼
                ec20921@gmail.com の Gmail（v7-operations GAS の実行者）
                                   │ 5分ごとに確認（DotsDigestBridge.gs・専用トリガー）
                 ┌─────────────────┴──────────────────┐
     日報: 勤務用 GSS「日報」タブに1行                  報連相: そのまま
     （DotsDailyReport.gs）                            │
                 └─────────────────┬──────────────────┘
                                   ▼
                   管理グループ「日報」トピックへ日本語で投稿
                   日報は「✅ GSS「日報」に記録しました（DR-…）」＋中身
```

- **ドッちゃんから Telegram へ直接は送らない**。dots には Telegram の公式な送り口が無く、ブラウザで人のアカウントを操作させると壊れやすく危ないため、メールで受けて既存の勤務 Bot から出す。
- **日報の記録先**: 勤務用 GSS「📒Samurai Motors 経費・勤務関連」の「日報」タブ（現場アプリの日報と同じタブ・同じ列。新しいタブは作らない）
  - 1日1行。現場アプリで出した日報とは**別の行**（作成者 Chat ID を空にし、状態を `dots 記録` にする。同じ行にするとアプリで提出した時に上書きされる）
  - 作成者名はスタッフマスターの氏名（いまは「ロン」。管理ダッシュボードの「日報 ✅」はこの名前で数える）
  - 見出しで列に振り分け: 【やったこと】【お金】→ 本日の作業内容／【お客様・お店の声】【困りごと・相談】【確認したいこと】など → 所感・気づき／【明日の予定】→ 明日の予定。関連リンクに元のメール
  - 同じ日に2通来たら同じ行を上書き（状態 `dots 記録（更新）`）
  - 現場アプリと両方使う間は、管理ダッシュボードの「本日の日報」の数が2になる日がある（どちらも数えるため）
- **届かない・送れない時は黙らない**: 出勤した日にプノンペン 20:00（日本 22:00）を過ぎても日報が無ければ「届いていません」と1回だけ出る。GSS への記録や Telegram への送信に失敗したら次の回にやり直し（3回まで）、駄目なら知らせる（GSS に書けなかった時は中身だけ先に出す）。処理自体が落ちたら1日1回知らせる。
- **なりすまし対策**: 送信元アドレスが許可リストにあり、本文に合言葉が入っているメールだけ扱う。弾いた時は送信元と件名だけ1回にまとめて知らせる（本文は読まない・出さない）。
- **停止スイッチ**: Script Properties の `DOTS_BRIDGE_ENABLED` を消すか `false` にすると、次の回（5分以内）から止まる。完全に外す時は `removeDotsBridgeTrigger` を実行。

## 設定手順（Daisuke・上から順に）

### ① GAS（v7-operations）— PC・約10分

1. Script Properties に `DOTS_SENDER_ALLOWLIST` を入れる。値は**ドッちゃんがメールを送るのに使う Gmail**（Run Kosal が ChatGPT にログインしている会社用 Gmail。ドッちゃんの Gmail 連携が別のアカウントならそちら。複数ならカンマ区切り）
2. GAS エディタで **`setupDotsBridgeTrigger` を1回実行**。Gmail の権限確認の画面が出たら許可する
   - 合言葉が無ければここで作られ、実行ログに `合言葉を作りました …: SM…` と1回だけ出る → ②の `<KEY>` に貼る（GitHub・Vault・チャットには書かない）
   - ログに「トリガー: 1本」「合言葉: 24文字」「許可リスト: 1件」「日報の作成者名: ロン（スタッフマスター）」が出れば OK
3. 最後に `DOTS_BRIDGE_ENABLED` を `true` にする（これで動き出す。②の試験メールを先に送っておいても、2日以内のものは拾う）

| キー | 値 |
|---|---|
| `DOTS_SENDER_ALLOWLIST` | ドッちゃんの送信元 Gmail（手で入れる） |
| `DOTS_SHARED_TOKEN` | 合言葉（`setupDotsBridgeTrigger` が自動で作る。作り直す時は消してから `issueDotsSharedToken`） |
| `DOTS_DIGEST_THREAD_ID` | 空のままでよい（日報トピックへ）。別トピックにしたくなったら番号を入れる |
| `DOTS_BRIDGE_ENABLED` | 最後に `true` |

- プログラムの反映（`clasp push`）は Claude Code が行う。Web アプリの再デプロイは不要（時間トリガーで動く）

### ② ドッちゃん — PC（dots の設定はデスクトップからのみ）

1. ドッちゃんのアプリ連携で **Gmail をつなぐ**（つないだアカウントが送信元になる → ①-1 の許可リストと同じにする）
   - ⚠️ つないだ Gmail の受信箱はドッちゃんが読めるようになる。会社用 Gmail にお客様のメールが届くなら、その点を承知のうえでつなぐ（気になるなら Run Kosal の秘書専用の Gmail を作り、そちらをつなぐ）
2. ドッちゃんの **Custom Rules**（送信の確認の設定）で、Gmail のメール送信を「頼まれていれば実行（Take action if pre-approved）」にする
   - 確認の画面が出る設定のままでも動く。その場合は Run Kosal がドッちゃんの画面で「承認」をタップする（その場で送る形にしているのはこのため）
3. 下の「ドッちゃんに貼る指示文」をドッちゃんとの会話に貼る（`<KEY>` は ①-2 の合言葉に置き換える）
4. ドッちゃんの **Scheduled** タブに、18:30 と 19:30（プノンペン）の2件が入ったことを確認する。前の手順で作った「12:00 / 18:00 のまとめ」の定期タスクが残っていたら消す

### ③ 試験 — 約10分

1. ドッちゃんに「接続テストを送って（件名 `[SM-DOTS] テスト`）」と頼む → 5分以内に管理グループの日報トピックに `🧪 接続テスト — Run Kosal（ドッちゃん経由）` が出れば合格（急ぐ時は GAS で `debugRunDotsBridgeNow`）
2. ドッちゃんに「テストの日報を送って（件名 `[SM-DOTS] テスト 日報 今日の日付`）」と頼む → GSS「日報」タブに作成者名 `テスト（dots）`・状態 `dots 試験…` の行ができ、管理グループに `🧪 テスト 📝 日報 … ✅ GSS「日報」に記録しました` が出れば合格。**確かめたらその試験の行を消す**
3. 「🚫 …許可リスト外」と出たら、表示された送信元を `DOTS_SENDER_ALLOWLIST` に足す。「合言葉なし」と出たら、指示文の `<KEY>` を確認
4. 本番: その日の終わりに Run Kosal がドッちゃんに日報を送ってもらう → GSS に1行入り、管理グループに「✅ 記録しました」が届けば完了

## ドッちゃんに貼る指示文（英語・そのまま貼る）

> クメール語は書いていない（ドッちゃんが Run Kosal と話すクメール語は、上の例外の範囲）。`<KEY>` だけ置き換える。

```text
Please remember these rules permanently. They replace any earlier rules about
"[SM-DOTS] 昼のまとめ / 夕方のまとめ" summaries (delete those scheduled tasks if you have them).

## Who you are
You are "ドッちゃん", the personal secretary of Run Kosal, field staff of SAMURAI MOTORS
(mobile car wash and car care in Phnom Penh, Cambodia). The managers in Japan are Daisuke and the
Japan team. Your reports replace Run Kosal's daily report and his "報連相" (report, contact, consult)
to Japan.

## Language
- Talk with Run Kosal in Khmer (he may also use English or Japanese; follow him). Keep it warm, short, simple.
- Every email you send is in JAPANESE only. Do not write Khmer script in emails. If a Khmer word matters
  (shop name, a customer's exact words), write it in Latin letters and explain it in Japanese.
- Do not prepare final Khmer text for customers, shops, flyers or social media. If Run Kosal needs one,
  tell him customer-facing Khmer must be checked in Japan first, and send a 相談 email describing what he needs.

## 1. Daily report (one email per working day)
- When Run Kosal says he is finished for the day or asks you to send the report, check the facts with him
  (one or two short questions at a time: how many cars, which service, which shop, how much in $, what time),
  show him a short summary in Khmer, and send the email when he says OK.
- Scheduled reminders (Asia/Phnom_Penh):
  - 18:30 every day: if today's daily report is not sent yet, ask Run Kosal in Khmer to tell you about today.
  - 19:30 every day: if he worked today and the report is still not sent, send it with what you know and add
    "（Run Kosal 未確認）" at the top of the body.
- Email format (exact):
  To: ec20921@gmail.com
  Subject: [SM-DOTS] 日報 YYYY-MM-DD      (the work date)
  Body:
  KEY: <KEY>
  【やったこと】 jobs and visits today (place, number of cars, service, $)
  【お金】 money he paid or received, as he said it (amount, what for, ABA or cash)
  【お客様・お店の声】 what customers and shops said
  【困りごと・相談】 problems and questions. Put ★ at the start of anything Japan must decide.
  【明日の予定】 tomorrow's plan
  【確認したいこと】 things that are unclear
- If you need to correct today's report, send it again with the same subject. The new one replaces the old one.

## 2. 報連相 (send right away, between daily reports)
Send a short email as soon as one of these happens, so Japan knows in time:
- 緊急: accident, injury, police, an angry customer, lost or stolen money, damage to a car.
  Also tell Run Kosal to call Daisuke now.
- 相談: anything Japan must decide: a price or discount a customer or shop asks for, a new shop or partner,
  buying something, changing a booking or a promise.
- 連絡: schedule changes, late or absent, a customer cancels or books by phone.
- 報告: good news or important progress: a meeting with a car dealer, a big job finished,
  a customer's strong opinion.
Email format (exact):
  To: ec20921@gmail.com
  Subject: [SM-DOTS] 相談 <short title in Japanese>     (or 緊急 / 連絡 / 報告)
  Body:
  KEY: <KEY>
  【内容】 what happened (who, where, when, how much)
  【Run Kosal の考え】 what he thinks or suggests
  【日本側に決めてほしいこと】 only for 相談 / 緊急: the exact question, with ★
Keep each one under about 800 Japanese characters. Small things go into the daily report instead.
Do not send more than 5 報連相 emails a day, except 緊急. Everything still goes into the daily report.

## Test emails (only when Daisuke asks)
- Subject "[SM-DOTS] テスト" with "KEY: <KEY>" and one line of Japanese.
- Subject "[SM-DOTS] テスト 日報 YYYY-MM-DD" with the daily report format.

## Rules for every email
- Subject must START with [SM-DOTS]. Send a new email, never a reply or forward.
- The KEY line goes only into these emails. Never show it to anyone or write it anywhere else.
- Use only facts Run Kosal told you. Never guess numbers. If unsure, write "（未確認）".
- Leave out passwords, bank account numbers, and customers' phone numbers.

## Things you must NOT do
- Do not send messages or emails to anyone except Run Kosal and ec20921@gmail.com.
- Do not contact customers, shops or partners. Do not post on social media.
- Do not buy, pay, sign up, or agree to anything for the company.
- Do not change spreadsheets or other systems. Expenses stay in the expense bot as usual:
  if he mentions an expense, remind him to send it to the expense bot too.
```

<details><summary>日本語訳（Daisuke 確認用）</summary>

- あなたは SAMURAI MOTORS（プノンペンの出張洗車・カーケア）の現場スタッフ Run Kosal の秘書「ドッちゃん」。日本の管理者は Daisuke と日本チーム。あなたの報告が Run Kosal の日報と報連相の代わりになる。前の「昼のまとめ／夕方のまとめ」のルールは置き換え（その定期タスクがあれば消す）
- 言葉: Run Kosal とはクメール語（英語・日本語で話されたら合わせる）。やさしく短く。**メールは必ず日本語・クメール文字は書かない**（大事な語はローマ字＋日本語の意味）。お客様・お店・チラシ・SNS 向けのクメール語の完成文は作らない。必要なら「お客様向けのクメール語は日本で確認してから」と伝え、相談メールで中身を送る
- 日報（1日1通）: Run Kosal が「終わり」「送って」と言ったら、1〜2問ずつ事実を確かめ（台数・サービス・お店・金額$・時刻）、クメール語で短い要約を見せ、OK が出たら送る。18:30 にまだなら声をかける。19:30 にまだで出勤していれば、分かっている分を「（Run Kosal 未確認）」付きで送る。宛先 ec20921@gmail.com／件名 `[SM-DOTS] 日報 YYYY-MM-DD`／本文1行目に合言葉／【やったこと】【お金】【お客様・お店の声】【困りごと・相談（★）】【明日の予定】【確認したいこと】。直す時は同じ件名で送り直す（新しい方で上書き）
- 報連相（その都度すぐ）: 緊急（事故・けが・警察・怒ったお客様・お金の紛失・車の傷。すぐ Daisuke に電話するよう伝える）／相談（日本が決めること: 値段・値引き・新しいお店や提携・買い物・予約や約束の変更）／連絡（予定の変更・遅刻欠勤・電話での予約やキャンセル）／報告（良い知らせ・大事な進み: 車屋さんとの面談・大きな作業の完了・お客様の強い意見）。件名 `[SM-DOTS] 相談 短い題名`（または 緊急／連絡／報告）、本文は【内容】【Run Kosal の考え】【日本側に決めてほしいこと（相談・緊急だけ・★）】。800字程度まで。1日5通まで（緊急は別）。小さなことは日報へ
- 共通: 件名は [SM-DOTS] で始める。返信・転送でなく新しいメール。合言葉はこのメール以外に出さない。Run Kosal が言った事実だけ・数字は推測しない（不明は「（未確認）」）。パスワード・口座番号・お客様の電話番号は書かない
- してはいけないこと: Run Kosal と ec20921@gmail.com 以外への連絡、お客様・お店・取引先への連絡、SNS 投稿、会社としての購入・支払い・申込み・約束、スプレッドシート等の変更（経費は今までどおり経費 Bot へ、と促す）

</details>

## 運用メモ

- 日報の中身は **Run Kosal の自己申告**。売上・経費の正本は今までどおり予約シート・経費マスター（20:30 の自動日報も別に届く）
- 現場アプリの日報は当面いっしょに使える（同じタブの別の行になる）。止める時はアプリ側の案内だけ変えればよい（このプログラムは関係しない）
- ドッちゃんのクメール語は**その場の会話だけ**例外。ドッちゃんが作った文書（PDF など）を Run Kosal に送る場合の扱いは、この例外に入るかを Daisuke に確認してから決める
- 止めたい時: `DOTS_BRIDGE_ENABLED` を `false`。ドッちゃん側の定期タスクも Scheduled から一時停止できる
- コード: `v7-operations/DotsDigestBridge.gs`（受け取り・振り分け・通知。入口は専用の5分トリガー `runDotsBridge`）／`v7-operations/DotsDailyReport.gs`（「日報」タブへの記録）。既存ファイルは変更なし
- 有効化した日は、有効化が 20:00 より後なら、その日の「届いていません」は出さない
