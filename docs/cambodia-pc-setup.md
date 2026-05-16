# カンボジア現地スタッフPC セットアップ手順書（貸出PC + Chrome Remote Desktop 版）

**対象**: GNPC から貸出された Windows 11 PC を、カンボジア現地スタッフ（Run Kosal 君）に使わせつつ、日本から **Chrome Remote Desktop** で遠隔管理する手順
**初版作成**: 2026-05-16
**運用開始**: 2026-05-19（プノンペン到着翌日）
**想定スタッフ数**: 1名（Kosal 君）
**所要時間**: 1〜2 時間

---

## 0. PC 情報（貸出元から提供済み）

| 項目 | 値 |
|---|---|
| 貸出元 | GNPC |
| OS | Windows 11（最新版） |
| Office | Word / Excel インストール済み |
| 管理者アカウント | ID: `GNPC-03` / PW: `adm_n03_03` |
| 一般アカウント | ID: `visitor` / PW: `visitor`（**使用しない、温存**） |

### Windows パスワード変更ポリシー

- **GNPC-03 / visitor のパスワードは変更しない**（貸出元から「変更時は返却前に元に戻す」指示あり）
- 代わりに **新規 `kosal` アカウントを作成** して Kosal 君に使わせる
- 返却時は kosal アカウントを削除すれば、貸出時の状態に戻る

---

## 1. 運用ルール（最初に決める）

### 1-1. アカウントの使い分け

| 用途 | アカウント | 権限 |
|---|---|---|
| 鈴木の管理作業（リモート） | `GNPC-03` | 管理者 |
| Kosal 君の日常業務 | **`kosal`**（新規作成） | 標準ユーザー |
| 貸出時の visitor | `visitor` | 触らず温存 |

### 1-2. リモート手段: Chrome Remote Desktop

- **AnyDesk は使用しない**（個人利用は無料だが業務利用は規約違反 → 月額発生）
- Chrome Remote Desktop は **完全無料・業務利用OK**
- 認証は Kosal 君用 Gmail (`samuraimotors.kron@gmail.com`) で行う
- ファイル転送は Google Drive 経由で（Chrome Remote Desktop は転送機能弱い）

### 1-3. Google アカウント分離

| アカウント | 用途 | Kosal PC で使う？ |
|---|---|---|
| `samuraimotors.japan@gmail.com`（鈴木メイン） | 業務全般・Bot・Drive 素材集等 | ❌ 絶対ログインしない |
| **`samuraimotors.kron@gmail.com`**（Kosal 君用） | Kosal の業務・Chrome Remote Desktop 認証 | ✅ ログイン |

> ⚠️ メアドの "kron" は当初の取り違えによるもの。本人の名前は **Kosal**（フルネーム Run Kosal、通称ロン君）。Google はメアド変更不可のため、kron のまま運用。Gmail 表示名は「Kosal」に変更推奨。

### 1-4. 持ち出し・保管ルール

- PC は基本オフィス内のみで使用
- スタッフ退勤時は **サインアウトのみ（シャットダウンしない）**、電源・WiFi はオン
- 鍵のかかる場所で物理保管

---

## 2. 着手前の準備

- [ ] 貸出 PC が手元にあり、起動できる
- [ ] WiFi 接続環境
- [ ] スマートフォン（Chrome Remote Desktop アプリインストール用）
- [ ] [Notion パスワード DB](https://www.notion.so/350731350b0e80c291c3dbe92c78afd3) アクセス
- [ ] `samuraimotors.kron@gmail.com` の PW を確認済み
- [ ] 鈴木自身の PC（Chrome 入り、接続元として使う）

---

## 3. 電源・スリープ設定（GNPC-03 で実施）

> スリープすると Chrome Remote Desktop で繋がらなくなる。**スリープ無効化が必須**。

### 手順
1. `GNPC-03` でサインイン（PW: `adm_n03_03`）
2. `設定` → `システム` → `電源とバッテリー` → `画面とスリープ`
3. 以下に設定：
   - 電源接続時に画面の電源を切る: **15 分**
   - 電源接続時に PC をスリープ状態にする: **「なし」**
   - バッテリー使用時にスリープ状態にする: **「なし」**（ノート PC の場合）
4. `電源モード` を **「最適なパフォーマンス」** に変更

### BIOS で「停電復旧時の自動起動」を有効化（推奨）

カンボジアは停電が起きやすい。電源復旧後に自動で PC が起動するように：

1. PC を再起動 → メーカーロゴ表示中に `F2` / `Del` / `F12`（機種による）で BIOS 起動
2. `Power` または `Advanced` メニュー
3. **「AC Power Loss」「Restore on AC Power Loss」** 等を **「Power On」** に変更
4. 保存して再起動

⚠️ BIOS 設定変更は貸出元への影響あり → **返却前に元の設定（通常 `Power Off`）に戻す**

---

## 4. Windows Update のスケジュール調整（GNPC-03 で実施）

### 手順
1. `設定` → `時刻と言語` → `日付と時刻` で **タイムゾーンを「(UTC+07:00) バンコク, ハノイ, ジャカルタ」** に変更
2. `設定` → `Windows Update` → `詳細オプション` → `アクティブ時間`
3. **手動で設定**：
   - 開始: 7:00（カンボジア時間）
   - 終了: 22:00（カンボジア時間）

---

## 5. kosal アカウントを新規作成（GNPC-03 で実施）

### 手順
1. `設定` → `アカウント` → `他のユーザー`（または「ファミリーとその他のユーザー」）
2. 「**アカウントの追加**」をクリック
3. Microsoft アカウント要求画面：
   - 「**このユーザーのサインイン情報がありません**」をクリック
   - 次画面で「**Microsoft アカウントを持たないユーザーを追加する**」をクリック
4. 入力：
   - ユーザー名: **`kosal`**
   - パスワード: **`Kosal-Cam-2026`**
   - 確認用 PW: `Kosal-Cam-2026`
   - 秘密の質問 3つ（適当でOK、答えは Notion に記録）
5. 作成後、`kosal` をクリック → 「**アカウントの種類の変更**」
6. **「標準ユーザー」のまま** であることを確認（管理者にしない）

✅ 確認: 「他のユーザー」一覧に `kosal` が表示されればOK

---

## 6. kosal でログインして初期セットアップ

### 6-1. kosal に切り替えてログイン
1. **Ctrl + Alt + Del** → 「**ユーザーの切り替え**」
2. 左下のユーザー一覧から **`kosal`** を選択
3. PW `Kosal-Cam-2026` を入力
4. **初回サインイン** = Windows がプロファイル作成（数分かかる）
5. プライバシー設定の確認画面 → **全部オフ**（推奨）→ 同意

### 6-2. Chrome のインストール（既になければ）
1. デスクトップの **Edge** を起動
2. アドレスバーに `google.com/chrome` と入力 → Enter
3. 「**Chrome をダウンロード**」→ ダウンロードしたファイルを実行
4. インストール完了

---

## 7. Chrome に Gmail ログイン + プロファイル分離

### 7-1. Chrome プロファイル設定
1. Chrome を起動
2. 右上の **人型アイコン** をクリック
3. 「**追加**」または「**ログイン**」をクリック
4. 「**Chrome にログイン**」画面で：
   - メール: `samuraimotors.kron@gmail.com`
   - PW: (Notion 参照)
5. ログイン後、「**同期を有効にする**」→ **「有効にする」**
6. プロファイル名: **`Kosal (Samurai Motors)`**
7. プロファイルテーマカラー: 青系推奨（業務用と分かりやすく）

### 7-2. ⚠️ 鈴木メインアカウント誤ログイン防止
8. Chrome 右上の人型アイコン → 他のプロファイルが見えたら **削除**
9. 設定 → 同期と Google サービス → 「Chrome へのログインを許可」: **ON のまま**
10. ⚠️ Kosal PC で `samuraimotors.japan@gmail.com` を**絶対ログインしない**

✅ 確認: Chrome 右上のアイコンに `K` または Kosal 君のイニシャルが表示されればOK

---

## 8. Chrome Remote Desktop セットアップ（最重要）

### 8-1. インストール
1. Chrome アドレスバーに `remotedesktop.google.com/access` と入力 → Enter
2. 「**このデバイスへのリモート アクセスを設定**」セクションの **ダウンロードボタン** をクリック
3. Chrome ウェブストアの **「Chrome Remote Desktop」** ページに飛ぶ → 「**Chrome に追加**」
4. インストール後、`remotedesktop.google.com/access` のページに戻る
5. 「**リモートアクセスを有効にする**」をクリック
6. **PC 名**: **`Cambodia-Kosal-PC`**
7. **PIN コード**: 6桁以上の数字を入力 → メモ
   - 例: `261902`（覚えやすい意味のある数字 + ランダム性）
   - または完全ランダム6桁を 1Password 等で生成
8. Windows のセキュリティプロンプトが出る → **「はい」**
9. 完了画面で「**オンライン**」と緑色表示されればOK

### 8-2. 接続元の準備（鈴木自身の PC）

1. 鈴木の PC の Chrome で `samuraimotors.kron@gmail.com` でログイン
   - **別プロファイル**を作成して使うのが安全（メインアカウントと混ざらない）
2. `remotedesktop.google.com/access` を開く
3. 「リモート デバイス」一覧に **`Cambodia-Kosal-PC`** が「オンライン」表示されることを確認

---

## 9. 接続テスト（スマホ 4G から実施）

> 自宅 Wi-Fi から接続すると同一 LAN 内になり、実環境のシミュレーションにならない。**必ずスマホ 4G/5G から実施**。

### 手順
1. PC 側: `kosal` でログインしたまま画面ロック（`Win + L`）
2. スマホ側: Wi-Fi を**オフ** → モバイル回線（4G/5G）に切り替え
3. スマホに **Chrome Remote Desktop アプリ** をインストール（App Store / Google Play）
4. アプリで `samuraimotors.kron@gmail.com` でログイン
5. `Cambodia-Kosal-PC` をタップ → PIN を入力
6. 画面が表示されれば成功 ✅

### テスト項目（チェックリスト）
- [ ] 画面が表示される
- [ ] マウス操作ができる
- [ ] キーボード入力ができる
- [ ] ファイル転送（Google Drive 経由でテスト）
- [ ] kosal → GNPC-03 への切替ができる
- [ ] 切断後、再接続できる

---

## 10. デスクトップに業務ショートカット配置

ロン君がすぐ使えるように：

1. デスクトップで右クリック → **「新規作成」→「ショートカット」**
2. 以下を作成：
   - 顧客GSS（URL）
   - 勤務GSS（URL）
   - 業務用 Telegram（[https://web.telegram.org/](https://web.telegram.org/)）
   - Word・Excel はスタートメニューにあればそれでOK

3. Chrome のブックマークバーにも同じリンクを配置すると便利

---

## 11. スタッフへの説明（信頼関係と労務トラブル予防）

### 11-1. 必ず口頭で伝えること
- これは**貸出 PC** で、業務専用である
- 日本から遠隔で操作・閲覧することがある（業務サポート目的）
- 個人利用（SNS、ゲーム等）は禁止
- 困ったら Telegram で連絡

### 11-2. スタッフ向け案内文（英語版、A4 で印刷して PC 横に貼る）

```
================================================
   SAMURAI MOTORS - BUSINESS PC USAGE GUIDE
   For: Kosal
================================================

This PC is a RENTAL business computer.

【LOGIN】
  Username: kosal
  Password: Kosal-Cam-2026

【RULES】
  1. This PC is for WORK USE ONLY.
  2. Use only Word, Excel, and the internet browser.
  3. Do NOT install any software.
  4. Daisuke (Japan office) MAY remotely access this PC
     for support and management. This is normal.
  5. Keep the PC plugged in and connected to Wi-Fi
     when leaving the office.

【WHEN YOU LEAVE THE OFFICE】
  - Sign out (do NOT shut down)
  - Leave the PC plugged in
  - Leave the Wi-Fi on
  - Lock the office door

【IF SOMETHING IS WRONG】
  - Contact Daisuke via Telegram immediately
  - Take a photo of the error screen if possible
  - Do NOT try to fix it yourself

Thank you for your cooperation!
================================================
```

### 11-3. クメール語版
> ⚠️ クメール語訳は現地で信頼できる翻訳者（または Kosal 本人）に依頼してください。Claude 経由の機械翻訳は業務文書としてのニュアンス保証ができないため非推奨。

---

## 🚀 日常運用：日本から現地 PC に接続する手順

> セットアップ完了後、鈴木が日常的に現地 PC へリモート接続する時の手順。所要時間 約 30 秒。

### 接続手順

1. **Chrome を起動**（必ず `samuraimotors.kron` プロファイルで）
   - ⚠️ メインアカウント (samuraimotors.japan) のプロファイルで起動すると、リモートデバイス一覧に表示されない
   - 推奨: デスクトップに専用ショートカットを作成（下記 Pro Tips 参照）
2. アドレスバーに `remotedesktop.google.com/access` を入力 → Enter
   - 推奨: ブックマーク登録しておく
3. 「リモート デバイス」一覧から **`Cambodia-Kosal-PC`** をクリック
4. PIN **`847312`** を入力（Notion 管理者エントリの本文に記録済み）
5. リモート画面が表示されたら、**画面内を1回クリック** してフォーカスを当てる
6. マウス・キーボードで操作開始

### 切断手順

| 方法 | 操作 |
|---|---|
| 速い | ブラウザのタブを閉じる |
| 丁寧 | 画面右端のサイドパネル → 「切断」ボタン |

> ロン君の PC 画面には「日本から接続中」の通知が出るので、見られていることが分かる仕組み。

### Pro Tips

#### 1. samuraimotors.kron プロファイル専用 Chrome ショートカット作成

1. Chrome を `samuraimotors.kron` プロファイルで起動
2. 右上のプロファイルアイコン → **「プロファイルを管理」**
3. 「Kosal (Samurai Motors)」の「**...**」→ **「ショートカットを作成」**
4. デスクトップに専用ショートカットができる（クリック一発で起動）

#### 2. ブックマーク登録

`samuraimotors.kron` プロファイルの Chrome で、ブックマークバーに：
- **「リモート」** = `remotedesktop.google.com/access`

#### 3. オフライン時の対処

接続できないとき：
- ロン君に Telegram で「PC 起動してる？」確認
- Chrome が閉じていたら「Chrome 起動して」と依頼
- それでもダメなら再起動を促す

---

## 12. 月次メンテナンス（日本側で実施）

毎月 1 回、深夜のカンボジア時間（日本の朝）に Chrome Remote Desktop で実施：

- [ ] PC を再起動
- [ ] Windows Update の状態確認
- [ ] Chrome のバージョン確認・更新
- [ ] ディスク空き容量確認（C: ドライブ 20GB 以上空き維持）
- [ ] Windows Defender でクイックスキャン
- [ ] 不要ファイル削除（ダウンロードフォルダ、ゴミ箱）
- [ ] スタッフからの困りごとヒアリング（Telegram で）

---

## 13. トラブルシューティング

### Q1. Chrome Remote Desktop で繋がらない
1. Telegram で Kosal に「PC は起動して、Chrome は起動してますか？」と確認
2. Chrome が起動していない → 「Chrome を起動してください」と指示
3. それでもダメ → 「PC を再起動してください」と依頼
4. 再起動後も繋がらない → リバース接続：Kosal のスマホで Chrome Remote Desktop アプリを起動 → 鈴木 PC へ「招待」方式で接続

### Q2. Kosal が Windows パスワードを忘れた
- AnyDesk じゃなく Chrome Remote Desktop なので、Windows ログイン前は接続不可
- Telegram で PW（`Kosal-Cam-2026`）を再伝達
- もし変更してしまった場合 → 鈴木が現地に行くか、リモートで GNPC-03 に何らかの方法で入って kosal の PW をリセット

### Q3. 停電後 PC が起動しない
- BIOS の「AC Power Loss」設定を確認
- 設定済みでも起動しない場合は、現地スタッフに電源ボタン押下を依頼

### Q4. 動作が重くなった
- まず再起動
- Chrome Remote Desktop で `GNPC-03` でログイン → タスクマネージャーで原因プロセスを特定

### Q5. 回線が不安定
- 短期：モバイルルーター（バックアップ回線）
- 長期：UPS（無停電電源装置、5,000 円程度）

---

## 14. 🔄 返却前のクリーンアップ手順（重要）

> 貸出 PC なので返却時に「貸出時の状態」に戻すことが必須。

### 返却日が決まったら（返却 3 日前〜）

#### Step A. 業務データのバックアップ
1. Chrome Remote Desktop で `GNPC-03` でログイン（または `kosal` で直接）
2. デスクトップ・ドキュメント・ダウンロードの業務データを Google Drive に全てバックアップ
3. ブラウザのブックマーク・パスワードも Google アカウントに同期されているのを確認

#### Step B. インストールしたソフトのアンインストール
1. `設定` → `アプリ` → インストール一覧を確認
2. **5/17 のセットアップ以降にインストールしたものを全て削除**：
   - Chrome（鈴木がインストールした場合のみ）
   - Chrome Remote Desktop の拡張は kosal アカウント削除時に消える
   - その他追加した業務ソフト

#### Step C. kosal アカウントの削除
1. `GNPC-03` でログイン
2. `設定` → `アカウント` → `他のユーザー`
3. `kosal` を選択 → 「**削除**」→ 「**アカウントとデータの削除**」
4. これで kosal のプロファイル・業務データ・Chrome Remote Desktop 設定が完全消去

#### Step D. 設定を元に戻す
1. 電源プラン → 「バランス」に戻す
2. スリープ設定 → 元の設定（15〜30 分でスリープ）に戻す
3. Windows Update のアクティブ時間 → 自動に戻す
4. BIOS の AC Power Loss 設定 → `Power Off` に戻す
5. タイムゾーン → 必要なら日本に戻す

#### Step E. 動作確認
1. PC を再起動
2. `GNPC-03` でログインできる（PW `adm_n03_03`）
3. `visitor` でログインできる（PW `visitor`）
4. `kosal` アカウントが存在しない
5. Chrome Remote Desktop が消えている

#### Step F. 貸出元への返却報告
- **パスワードは変更していないので「変更後パスワードの報告」は不要**
- 「設定を元に戻しました、業務データは全て削除済みです」と一言伝える

### 返却前最終チェックリスト

- [ ] 業務データを Google Drive にバックアップ済み
- [ ] kosal アカウント削除済み（業務データも一緒に消える）
- [ ] Chrome Remote Desktop が消えている（kosal 削除で自動）
- [ ] その他インストールしたソフト全て削除済み
- [ ] 電源・スリープ設定を元に戻した
- [ ] Windows Update アクティブ時間を自動に戻した
- [ ] BIOS の AC Power Loss を元に戻した
- [ ] GNPC-03 でログイン確認（PW `adm_n03_03` で入れる）
- [ ] visitor でログイン確認（PW `visitor` で入れる）
- [ ] Notion 上の認証情報をアーカイブ（即削除はせず、3ヶ月後削除）
- [ ] `samuraimotors.kron@gmail.com` の Google アカウント削除を検討

---

## 15. 将来のスタッフ増加・自社PC購入時

このドキュメントは **貸出PC（GNPC-03）+ Kosal 君1名** 前提なので、自社PC購入時は以下が追加で必要：

- Windows 11 Home → Pro アップグレード（約 13,824 円）
- Office ライセンス購入（Microsoft 365 Business Standard 等）
- 各スタッフ用 Google アカウントの新規作成（または samurai-motors.com 独自ドメイン + Workspace）
- スタッフごとの Chrome プロファイル分離

スタッフ 3 名超時は **Microsoft Intune + Google Workspace** への移行を検討：
- Intune: Microsoft 365 Business Premium（月 3,000 円/人）に含まれる
- Workspace: 月 680 円〜/人、独自ドメインメール（kosal@samurai-motors.com 等）が使える
- 一括ポリシー適用・紛失時リモートワイプが可能

---

## 16. 関連リンク

- Chrome Remote Desktop https://remotedesktop.google.com/
- Microsoft Intune 概要 https://www.microsoft.com/ja-jp/security/business/microsoft-intune
- Google Workspace https://workspace.google.com/
- 既存スタッフマニュアル: [docs/manual_staff_km.md](manual_staff_km.md)
- 既存管理者マニュアル: [docs/manual_admin_jp.md](manual_admin_jp.md)
- Notion パスワード DB: [リンク集（SamuraiMotors）](https://www.notion.so/350731350b0e80c291c3dbe92c78afd3)

---

## 17. 改訂履歴

| 日付 | 改訂者 | 内容 |
|---|---|---|
| 2026-05-16 | 鈴木 | 初版作成（自社PC新規セットアップ前提） |
| 2026-05-16 | 鈴木 | 貸出PC（GNPC-03）前提に全面書き直し、返却前クリーンアップ手順を追加 |
| 2026-05-16 | 鈴木 | **AnyDesk → Chrome Remote Desktop に切り替え。kosal アカウント新規作成 + Gmail プロファイル分離 + samuraimotors.kron@gmail.com 認証ベースに全面書き直し。Run Kosal 君（通称ロン君）専用運用に明確化** |
