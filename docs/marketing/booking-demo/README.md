# Booking デモ GIF (`booking-demo.gif` / `.mp4`)

`booking.html`（予約ミニアプリ）の 4 ステップを、スマホモックアップ＋ブランド背景で
スクロール紹介するアニメーション。Facebook 集客・Telegram 告知用の説明素材。

## 構成（5 画面・指タップ演出つき）
各操作に**指タップのアニメーション**（押下ドット＋広がるリング）を入れ、
「タップ → 選択状態が変わる」流れが分かるようにしている（選択前／後の実画面を撮影して切替）。

1. WASH / 車種選択（キャンペーン割引表示）
   - 車種をタップ → SAMURAI WASH をタップ → SAMURAI GLASS（ALL WINDOWS↔FRONT 3 WINDOWS）をタップ
2. 日付・時間スロット選択（日付タップ→スロット出現→スロットタップ）
3. 場所（地図タップ→ピン留め）
4. 内容確認（料金内訳）→ Confirm タップ
5. 予約完了（Reserved + What Happens Next）

各画面下部には実アプリ相当の **固定 CTA バー**（Next / Confirm / Close）を描画。
キャンペーンは **GRAND OPENING 30% OFF**（`capture.py` の `campaign.percent` で変更）。

言語ルール準拠：顧客向けのため **英語メイン＋クメール語** のみ（日本語は出さない）。

## Facebook 投稿キャプション
`facebook-caption.md` にクメール語＋英語のキャプション（フル版／ショート版）を用意。

## 再生成方法
ヘッドレス Chrome（Playwright）で `booking.html` を実レンダリングし、
モックの `booking_init` / `booking_slots` レスポンスを注入して各画面を撮影 → Pillow で
モックアップ合成 → ffmpeg でエンコード。

```bash
pip install playwright pillow imageio-ffmpeg
# Khmer フォント (Noto Sans Khmer) を OS に導入しておくこと（クメール文字化け防止）
python3 capture.py     # → /tmp/shots/*.png
python3 gifmake.py      # → /tmp/anim/*.png
ffmpeg ... (README 末尾参照)
```

`capture.py` 内の `INIT` / `SLOTS` を編集すれば料金・プラン・キャンペーン内容を差し替え可能。
バックエンド（GAS）には一切アクセスしないため、本番データに影響しない。
