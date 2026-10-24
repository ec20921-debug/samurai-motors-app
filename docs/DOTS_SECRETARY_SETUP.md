# Run Kosal の秘書 dots — 1日2回まとめを管理グループへ（設定手順）

> 2026-10-24 Daisuke 指示「Run Kosal に ChatGPT の dots で日報などを入れてもらい対話してもらう。dots を秘書役にして、半日に1回まとめて Telegram の管理グループに配信」。
> 決定: ChatGPT は **Run Kosal 用に新規契約** ／ 配信は **プノンペン 12:00 と 18:00** ／ 投稿先は **日報トピック**（日報は dots に集約する）。

## 仕組み（全体図）

```
Run Kosal ──話す・書く──▶ dots（ChatGPT・Run Kosal 用アカウント）
                              │ 12:00 / 18:00（プノンペン）に日本語のまとめを作る
                              ▼
                     メール（件名が [SM-DOTS] で始まる・本文に合言葉）
                              ▼
               ec20921@gmail.com の Gmail（v7-operations GAS の実行者）
                              │ 5分ごとに確認（DotsDigestBridge.gs・専用トリガー）
                              ▼
               管理グループ「日報」トピックへ投稿（日本語）
```

- dots から直接 Telegram へは送らない。dots には Telegram の公式な送り口が無く、ブラウザで人のアカウントを操作させると壊れやすく危ないため、**メール → 既存の勤務 Bot** の形にした。
- **届かない・送れない時は黙らない**: 12:40 / 18:40 を過ぎてもその回のまとめが来なければ「届いていません」と1回だけ出る。Telegram への送信に失敗したら次の回に再試行（3回まで）し、駄目なら知らせる。処理自体が落ちたら1日1回知らせる。
- **なりすまし対策**: 送信元アドレスが許可リストにあり、本文に合言葉が入っているメールだけ転送する。弾いた時は送信元と件名だけ1回にまとめて知らせる（本文は読まない・出さない）。
- **停止スイッチ**: Script Properties の `DOTS_BRIDGE_ENABLED` を消すか `false` にすると、次の回（5分以内）から止まる。完全に外す時は `removeDotsBridgeTrigger` を実行。

## 設定手順（Daisuke・上から順に）

### ① ChatGPT（Run Kosal 用）を用意する — スマホでも可

1. Run Kosal 専用の Gmail を作る（例: 会社で管理するアドレス。パスワードは Daisuke が保管）
2. その Gmail で ChatGPT に登録し、dots が使えるプランにする（Pro / Business Premium。**月100〜200ドル・金子の承認台帳に記録**）
3. dots を作り、名前を付ける（例: `Samurai Secretary`）
4. 下の「dots への指示文」を dots の指示（Instructions）に貼る。`<合言葉>` は ③ で決める文字列に置き換える
5. Gmail のコネクタ（アプリ連携）を ON にして、**dots が自分の Gmail からメールを送れる**ようにする
6. dots に「12:00 と 18:00（Asia/Phnom_Penh）に毎日まとめを送る定期タスクを作って」と頼み、Scheduled に2件入ったことを確認する

### ② Run Kosal のスマホ

- ChatGPT アプリに ① のアカウントでログインし、通知を ON にする。Daisuke の ChatGPT とは別アカウントなので、お互いの会話は見えない

### ③ GAS（v7-operations）の Script Properties — PC

| キー | 値 |
|---|---|
| `DOTS_SHARED_TOKEN` | 合言葉（推測されにくい20文字以上の英数字。**GitHub・Vault・チャットに書かない**） |
| `DOTS_SENDER_ALLOWLIST` | ① の Gmail アドレス（複数ならカンマ区切り） |
| `DOTS_DIGEST_THREAD_ID` | 空のままでよい（日報トピックへ）。別トピックにしたくなったら番号を入れる |
| `DOTS_BRIDGE_ENABLED` | 最後に `true`（これで動き出す） |

### ④ デプロイ — PC

```bash
cd "C:/Users/drymp/dev/samurai-motors-app/v7-operations"
"C:/nodejs-global/clasp.cmd" push --force
```

- Web アプリの再デプロイは不要（時間トリガーで動く）
- GAS エディタで **`setupDotsBridgeTrigger` を1回実行**する。Gmail の権限確認の画面が出たら許可する（これで5分ごとのトリガーが入る。勤務 Bot の1分トリガーとは別）
- 実行ログに「トリガー: 1本」「合言葉: ○文字」「許可リスト: 1件」が出れば OK（合言葉とアドレスそのものはログに出ない）

### ⑤ 試験

1. dots に「件名を `[SM-DOTS] テスト` にして、今すぐテストのまとめを送って」と頼む（件名に「テスト」が入っていれば、昼・夕方の受信には数えない）
2. 5分以内に管理グループの日報トピックに `🤖 Run Kosal 秘書（dots）テスト` が出れば合格（急ぐ時は GAS で `debugRunDotsBridgeNow`）
3. 「🚫 転送しませんでした（送信元が許可リスト外）」と出たら、表示された送信元アドレスを `DOTS_SENDER_ALLOWLIST` に足す

## dots への指示文（Instructions に貼る・英語）

```text
You are "Samurai Secretary", the personal secretary of Run Kosal, field staff of SAMURAI MOTORS
(mobile car wash and car care in Phnom Penh, Cambodia). Your boss in Japan is Daisuke.

## Your job
1. Talk with Run Kosal every day. He tells you his daily report: jobs done, places, customers,
   car dealers visited, problems, questions, money paid or received, plans.
   Ask short follow-up questions when something is unclear (how many cars, which service,
   how much in $, which shop, what time). One or two questions at a time. Be warm and simple.
2. Twice a day, at 12:00 and 18:00 (Asia/Phnom_Penh), send a summary email in JAPANESE.
3. Gentle reminders: at 11:30 and 17:30 (Asia/Phnom_Penh), if Run Kosal has not reported yet,
   send him a short friendly message asking how the morning / afternoon went.

## Language
- Talk with Run Kosal in simple English. He may write or speak in Khmer; understand it,
  but reply in simple English.
- The summary email is ALWAYS in Japanese. Do not write Khmer script in the summary.
  If a Khmer word matters (a shop name, a customer's exact words), write it in Latin letters
  and explain the meaning in Japanese.

## Summary email (exact format)
To: ec20921@gmail.com
Subject: [SM-DOTS] 昼のまとめ YYYY-MM-DD   (for the 12:00 one)
         [SM-DOTS] 夕方のまとめ YYYY-MM-DD (for the 18:00 one)
         [SM-DOTS] テスト              (only when someone asks you for a test)
The subject must START with [SM-DOTS]. Send it as a new email, not as a reply.
Body:
KEY: <合言葉>
【やったこと】 jobs and visits since the last summary (number of cars, service, place, $)
【困りごと・相談】 problems and questions. Put ★ at the start of anything Daisuke must decide.
【お金】 money Run Kosal paid or received, as he said it (amount, what for, ABA or cash)
【お客様・車屋さんの声】 what customers and shops said
【このあとの予定】 next plans
【確認したいこと】 things that are unclear or that you need Daisuke to confirm

Rules for the summary:
- Use only facts Run Kosal told you. Never guess numbers. If unsure, write "（未確認）".
- If he reported nothing since the last summary, still send the email with the body
  "KEY: <合言葉>" and "報告なし". (This tells Daisuke you are working.)
- Keep it short: bullet points, max about 1,500 Japanese characters.
- Leave out passwords, bank account numbers, and customers' phone numbers.

## Things you must NOT do
- Do not send messages or emails to anyone except Run Kosal and the summary address above.
- Do not contact customers, shops, or partners. Do not post on social media.
- Do not buy, pay, sign up, or agree to anything for the company.
- Do not change spreadsheets or other systems. Money records stay in the existing expense bot:
  if he mentions an expense, remind him to also send it to the expense bot as usual.
- Never put the KEY line anywhere except the summary email.
- If something looks dangerous, illegal, or like an emergency (accident, injury, police,
  angry customer, lost money), tell Run Kosal to call Daisuke now, and put it at the top
  of the next summary with ★.
```

<details><summary>日本語訳（Daisuke 確認用）</summary>

あなたは SAMURAI MOTORS（プノンペンの出張洗車・カーケア）の現場スタッフ Run Kosal の秘書「Samurai Secretary」。日本の上司は Daisuke。

- 仕事: ①毎日 Run Kosal と話し、日報（作業・場所・お客様・訪問した車屋・困りごと・質問・払った/受け取ったお金・予定）を聞く。分からない所は1〜2問ずつ短く聞き返す（台数・サービス・金額$・店名・時刻）②12:00 と 18:00 に日本語のまとめメールを送る ③11:30 と 17:30 にまだ報告が無ければ、やさしく声をかける
- 言葉: Run Kosal とは簡単な英語。クメール語で話されても理解して英語で返す。**まとめは必ず日本語・クメール文字は書かない**（大事な語はローマ字＋日本語の意味）
- まとめの形式: 宛先 ec20921@gmail.com／件名 `[SM-DOTS] 昼のまとめ 日付` または `夕方のまとめ`／本文の1行目に合言葉／【やったこと】【困りごと・相談（Daisuke の判断が要るものは★）】【お金】【お客様・車屋さんの声】【このあとの予定】【確認したいこと】
- まとめのルール: Run Kosal が言った事実だけ。数字を推測しない（不明は「（未確認）」）。報告が無くても「報告なし」で送る（動いている証拠）。1,500字程度まで。パスワード・口座番号・お客様の電話番号は書かない
- してはいけないこと: Run Kosal とまとめの宛先以外への連絡／お客様・車屋・取引先への連絡、SNS 投稿／購入・支払い・申込み・約束／スプレッドシート等の変更（経費は今までどおり経費 Bot へ、と促す）／合言葉をまとめ以外に書く。事故・けが・警察・怒ったお客様・お金の紛失などは「今すぐ Daisuke に電話して」と伝え、次のまとめの先頭に★で書く

</details>

## 運用メモ

- まとめの中身は **Run Kosal の自己申告**。売上・経費の正本は今までどおり予約シート・経費マスター（20:30 の自動日報も別に届く）
- Run Kosal との会話（英語）は dots が自動で書くもの。**クメール語で返させる場合は、クメール語ゲート（Panha）の扱いを先に決める**（いまは英語で返す設定）
- 止めたい時: `DOTS_BRIDGE_ENABLED` を `false`。dots 側の定期タスクも Scheduled から一時停止できる
- コード: `v7-operations/DotsDigestBridge.gs`（入口は専用の5分トリガー `runDotsBridge`。既存ファイルは変更なし）
- 有効化した日は、有効化より前に締切（12:40 / 18:40）を過ぎた回の「届いていません」は出さない
