# 2026年5月 プノンペン出張 — 事前準備サマリー

- **期間**: 2026-05-18(日) 〜 2026-05-23(金)
- **作成日**: 2026-05-16
- **作成者**: 鈴木大輔（Claude Code 支援）
- **共有範囲**: 飯国・鈴木（内部のみ）
- **注意**: ⚠️ 本ドキュメントには認証情報（PW・PIN）は含めていません。全て Notion を参照してください

---

## 1. 概要

2026 年 5 月のプノンペン出張に向けた事前準備の記録。今回の重点は **「現地スタッフ Run Kosal 君（通称ロン君）の業務用 PC を、日本から遠隔管理できる体制を整える」** こと。

---

## 2. 完了した準備（2026-05-16 時点）

### 2-1. 出張レポート用フォルダ整備

- `reports/2026-05-phnom-penh/` 配下にテンプレ一式
- 日次ログ（day0〜day5）、写真フォルダ、最終レポートのスケルトン
- 現地で起きたことを Claude Code セッションに投げる → 整理 → 最終レポート自動生成のフローを構築

### 2-2. 現地スタッフ用 PC（貸出 PC）のセットアップ

#### PC 情報

| 項目 | 値 |
|---|---|
| 貸出元 | GNPC（貸出 PC） |
| OS | Windows 11（最新版） |
| Office | Word / Excel インストール済み |
| 設置場所（予定） | プノンペン店舗 |
| 設置予定日 | 2026-05-19 |
| 機種 | FUJITSU 製ノート PC |

#### Windows アカウント構成

| アカウント | 種類 | 用途 | 使う人 |
|---|---|---|---|
| GNPC-03 | ローカル管理者 | 貸出元提供、温存 | 触らない |
| samuraimotors.kron（Microsoft） | Windows 管理者 | 鈴木のセットアップ・リモート管理用 | 鈴木 |
| **kosal** | ローカル標準ユーザー | 日常業務 | **ロン君** |
| visitor | ローカル一般 | 貸出元提供、温存 | 触らない |

→ ロン君は標準ユーザー権限のみ。勝手なソフトインストール・設定変更を制限。

#### Google アカウント

| アカウント | 役割 |
|---|---|
| `samuraimotors.japan@gmail.com`（既存） | 鈴木メイン。Drive 素材集・GSS全権限・Facebook管理・Bot管理 |
| **`samuraimotors.kron@gmail.com`**（新規） | ロン君用。Chrome ログイン、Chrome Remote Desktop 認証、業務メール |

→ メアドの "kron" は当初の表記取り違えによるもの。本人の名前は Kosal だが、Google はメアド変更不可のため kron のまま運用。Gmail 表示名のみ「Kosal」に変更予定。

#### リモート管理体制

- **方式**: Chrome Remote Desktop（完全無料・業務利用OK）
- **PC 名**: Cambodia-Kosal-PC
- **認証**: `samuraimotors.kron@gmail.com`
- **接続テスト**: 2026-05-16 完了 ✅

> ※ 当初は AnyDesk を検討したが、業務利用が規約違反のため Chrome Remote Desktop に変更

### 2-3. ドキュメント整備

#### セットアップ手順書
- [`docs/cambodia-pc-setup.md`](../../docs/cambodia-pc-setup.md) に完全な手順書を整備
- 全 17 セクション、約 400 行
- 返却前クリーンアップ手順も含む（業務データ削除・kosal アカウント削除・設定戻し）

#### 認証情報の集約（Notion）

全パスワード・PIN・アカウント情報は Notion のパスワード DB に集約：

| エントリ | 用途 |
|---|---|
| [カンボジア店舗PC(管理者) GNPC-03](https://www.notion.so/361731350b0e81d3a08ffe1d34ba4663) | 管理者ログイン情報 + Chrome Remote Desktop PIN |
| [カンボジア店舗PC(現地スタッフ) Kosal](https://www.notion.so/361731350b0e8168ab14eede5b8403ef) | ロン君用 Windows ログイン情報 |
| [Gmail(samuraimotors.kron) Kosal 君用](https://www.notion.so/361731350b0e81e88c9eeab57a9371b8) | Google アカウント情報 |

---

## 3. 認証情報の共有方針

機密情報（パスワード、PIN）は全て Notion に集約。**外部・スタッフへの直接共有はしない**。

| 情報種別 | 格納場所 | 共有範囲 |
|---|---|---|
| Windows 管理者 PW | Notion パスワード DB（管理者エントリ） | 飯国・鈴木のみ |
| Windows kosal PW | Notion パスワード DB（スタッフエントリ） | 飯国・鈴木のみ |
| Gmail PW | Notion パスワード DB（Gmail エントリ） | 飯国・鈴木のみ |
| Chrome Remote Desktop PIN | Notion パスワード DB（管理者エントリ本文） | 飯国・鈴木のみ |
| ロン君に伝える情報 | Windows ログイン PW のみ（口頭または紙で） | ロン君 |

### Notion 共有設定の推奨

- 対象: 「[リンク集（SamuraiMotors）](https://www.notion.so/350731350b0e80c291c3dbe92c78afd3)」とその配下の「パスワード」DB
- **共有先**: 飯国・鈴木のみに「編集」権限
- **外部共有**: OFF（「Web に公開」「リンクを知っている人」は両方OFF）

---

## 4. 残タスク

### 出発前（〜2026-05-17）

- [ ] 出張背景・目的・アジェンダの記入（`reports/2026-05-phnom-penh/00_background.md` / `01_objectives.md` / `02_agenda.md`）
- [ ] Notion パスワード DB の共有設定確認（飯国・鈴木のみになっているか）
- [ ] Gmail (samuraimotors.kron) の 2段階認証有効化
- [ ] Gmail 表示名を「Kosal」に変更
- [ ] パスポート・ビザ・現地通貨・電源アダプタ等の最終確認

### 現地着任後（2026-05-19〜2026-05-22）

- [ ] **ロン君の社用携帯の Google アカウント変更**（samuraimotors.japan → samuraimotors.kron）
  - 詳細手順: [`notes/onsite-tasks.md`](notes/onsite-tasks.md)
  - **理由**: 権限分離・退職時対応・誤操作リスク低減
- [ ] PC を現地に持ち込み、稼働確認
- [ ] ロン君に Windows PW を伝達、PC 運用ルール説明（業務専用・遠隔監視あり）
- [ ] 業務システム（顧客GSS / 勤務GSS）の samuraimotors.kron への共有設定
- [ ] Drive 素材集の必要フォルダのみ samuraimotors.kron に「閲覧のみ」で共有

### 返却時（PC返却タイミング）

- [ ] [`docs/cambodia-pc-setup.md`](../../docs/cambodia-pc-setup.md) の「返却前クリーンアップ手順」を実行
- [ ] kosal アカウント削除、業務データ消去
- [ ] 電源・スリープ・Windows Update・BIOS の設定を元に戻す
- [ ] Google アカウント (samuraimotors.kron) の処遇判断（削除 or 保留）

---

## 5. 振り返り（事前準備で得た学び）

- **Microsoft アカウントを Windows サインインに使うと脱却が難しい** → 今回は samuraimotors.kron アカウントを Windows 管理者として残しつつ、kosal 標準ユーザーを並行運用する形で着地
- **Windows 11 のローカルユーザー作成 UI には罠が多い**（メアド入力を求められる）→ コマンドプロンプトでの `net user` コマンドが確実
- **Chrome Remote Desktop は AnyDesk より無料・規約クリーン**、業務利用に最適
- **Gmail 新規作成は電話番号認証で詰まる可能性**（電話番号上限）→ 既存アカウントの流用 + Chrome プロファイル分離で代替可能
- **アカウント名は本名を確認してから決める** → 当初 "Kron"（誤り）で作成、後で本名「Run Kosal」と判明 → Notion 等は Kosal に統一、Gmail のみ既存 kron を流用

---

## 6. 関連リンク

- 出張レポート README: [reports/2026-05-phnom-penh/README.md](README.md)
- 現地タスクリスト: [notes/onsite-tasks.md](notes/onsite-tasks.md)
- セットアップ手順書: [docs/cambodia-pc-setup.md](../../docs/cambodia-pc-setup.md)
- Notion パスワード DB: [リンク集（SamuraiMotors）](https://www.notion.so/350731350b0e80c291c3dbe92c78afd3)

---

## 7. 改訂履歴

| 日付 | 改訂者 | 内容 |
|---|---|---|
| 2026-05-16 | 鈴木（Claude Code 支援） | 初版作成。事前準備の一区切り（PC セットアップ完了、リモート接続テスト成功） |
