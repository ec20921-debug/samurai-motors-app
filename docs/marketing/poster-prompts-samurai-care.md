# 🎨 Image Generation Prompts — Samurai Care Posters

**プロジェクト**: Samurai Motors / Samurai Care
**用途**: A4縦ポスター（A3 拡大ラミネートも想定）×2 種
- (1) SAMURAI GLASS 単体ポスター（メイン推し・雨季対策）
- (2) SAMURAI WASH 単体ポスター（基本サービス）

**初版**: 2026-05-20（プノンペン出張中）
**作成**: 鈴木大輔（Claude Code 支援）

---

## 🏯 ブランド前提（プロンプトに織り込む情報）

| 項目 | 値 |
|---|---|
| **マスターブランド** | SAMURAI MOTORS / Samurai Motors |
| **サブブランド（サービス群）** | SAMURAI CARE |
| **タグライン** | "Japanese Craftsmanship. Delivered." |
| **拠点** | プノンペン店舗 + 出張対応 |
| **メインメッセージ** | "WE WASH. YOU SHINE." |
| **電話** | 096-713-8456（Telegram OK） |
| **経験** | 28 YRS EXPERIENCE |
| **担当者** | Run Kosal（フィールドスペシャリスト） |
| **カラー** | 深い炭黒 #0E0B08 ベース + シャンパンゴールド #D4AF37 + 差し色クリムゾン |
| **タイポ** | Cinzel セリフ（ALL CAPS 大見出し） |
| **デザイン参照** | AMCORE TOKYO（モダン・ミニマル・プレミアム自動車エディトリアル） |
| **キャンペーン** | GRAND OPENING -30% OFF（サービス料金のみ） |

### メニュー・料金（プロンプト内の Pricing Block で使用）

| サービス | Sedan | SUV | 所要時間 |
|---|---|---|---|
| SAMURAI WASH（必須ベース） | $12 | $15 | 30 / 45 min |
| + SAMURAI GLASS — 3 Windows + Mirrors | +$15 | +$20 | +30 / +50 min |
| + SAMURAI GLASS — All Windows + Mirrors | +$30 | +$40 | +60 / +100 min |
| 出張料 | $2 | $2 | — |

---

## 📐 全体方針

| 設計判断 | 理由 |
|---|---|
| **英語プロンプト** | Midjourney / Imagen / DALL-E / Flux いずれも英語の方が高精度 |
| **A4 縦 2480 × 3508 px @ 300 DPI** | A3 拡大（4961 × 7016 px）にも耐える解像度。Midjourney 等は `--ar 210:297` |
| **文字は AI に書かせず Canva で後乗せ推奨** | 価格・電話番号・QR は誤りリスク回避。AI には英語タイトルだけ書かせる |
| **AMCORE TOKYO 参照画像を `--cref` で添付** | トーン継承 |
| **2 枚は sister design**（シリーズ感統一） | ロゴ位置・配色・タイポ共通、写真主体度のみ可変 |

---

## 🌧️ プロンプト 1: SAMURAI GLASS（雨季メイン推し）

```
SAMURAI GLASS — Premium A4 Vertical Poster (Print-ready)

[STYLE]
Editorial luxury magazine spread. Dark-mode (deep charcoal #0E0B08 to pure
black gradient background). Champagne gold (#D4AF37) accent lines and seals.
Subtle deep crimson accent. Cinzel serif typography for headlines. Modern
Japanese minimalism inspired by the attached AMCORE TOKYO reference —
refined, technical, premium-automotive editorial. Generous negative space
(black space). Asymmetric Japanese-grid composition. Gold hairline dividers.

[HERO VISUAL — top 55% of poster]
Photorealistic, ultra-detailed close-up of a luxury black sedan windshield
during heavy tropical rain. Water beads up into perfect crystalline spheres
and slides off in elegant streaks (hydrophobic effect clearly visible).
The car's polished black paint reflects warm golden city lights.
Background: blurred Phnom Penh skyline at dusk with hint of Angkor temple
silhouette far behind. Cinematic depth, shallow DOF, dramatic side-lighting
from the right.

[BRAND MARK — top-left]
"SAMURAI MOTORS" wordmark in Cinzel + small samurai-helmet emblem outlined
in gold. Tagline beneath in 9pt: "Japanese Craftsmanship. Delivered."

[HERO TITLE — overlaid on lower hero area]
Main: "SAMURAI GLASS" — Cinzel ALL CAPS, 72pt, champagne gold,
      letter-spacing 4pt
Sub: "Rain-Repellent Glass Coating" — Cinzel italic, 22pt, off-white
Tiny Khmer subtitle placeholder (overlay later): [KH text region]

[BENEFIT GRID — middle 25%, three columns with hairline gold dividers]
1. icon: water droplet bouncing off glass
   "WATER BEADS OFF / Visibility stays crystal-clear in heavy rain"
2. icon: minimalist sparkle
   "RESTORED CLARITY / Glass surface feels brand-new"
3. icon: shield
   "LASTS 6+ MONTHS / One treatment covers the rainy season"

[PRICING BLOCK — bottom 15%, framed in thin gold]
Clean two-row table. Header row: gold thin underline.
"3 Windows + Mirrors    Sedan +$15   SUV +$20"
"All Windows + Mirrors  Sedan +$30   SUV +$40"
Small note in gray italic: "Add-on to SAMURAI WASH base service"

[CTA STRIP — very bottom]
Left: phone "📞 096 713 8456 (Telegram OK)"
Middle: two square QR placeholders (Telegram, Facebook) with gold corner
        brackets
Right: badge "🌧️ Recommended for Rainy Season — Book Now / កក់ឥឡូវនេះ"

[CORNER SEALS]
Top-right: circular gold seal "28 YRS EXPERIENCE"
Bottom-left: minimal "GRAND OPENING -30%" red ribbon

[TECHNICAL]
- Output 2480 × 3508 px minimum (A4 @ 300 DPI), upscale to 4961 × 7016
  (A3 @ 300 DPI) if possible
- CMYK-print-safe colors, no neon
- For Midjourney v6: --ar 210:297 --style raw --v 6 --q 2 --cref [AMCORE_TOKYO_IMAGE_URL]
- For Imagen 3 / DALL-E 3: request "A4 portrait print poster, 300 DPI"
- Render English text crisply; Khmer and Japanese as placeholder regions

[NEGATIVE — avoid]
cluttered, cheap, neon, cartoon, anime mascot, generic stock-photo wash,
soap bubbles, low-resolution, watermark, signature, sun-glare overexposed
```

---

## 🚗 プロンプト 2: SAMURAI WASH（基本サービス）

```
SAMURAI WASH — Premium A4 Vertical Poster (Print-ready, sister design to
SAMURAI GLASS)

[STYLE]
Identical visual language to SAMURAI GLASS poster (must read as same series).
Dark-mode editorial, champagne gold #D4AF37, Cinzel serif, AMCORE
TOKYO-inspired minimalism. Photo-driven, generous black space, gold
hairlines.

[HERO VISUAL — top 55%]
Photorealistic shot of a gloved craftsman's hand polishing a sleek
silver-black sedan's hood with a premium microfiber cloth. Foam-free
(this is waterless wash — emphasize that). The paint shows mirror-deep
reflection of warm golden light. Side-frame includes a glimpse of tire
being treated with shine (deep black gloss on tread). Soft golden-hour
lighting from upper-right. Background suggests the Samurai Motors mobile
service van in deep focus blur. Cinematic, premium-automotive editorial.

[BRAND MARK — top-left]
Same as GLASS poster: "SAMURAI MOTORS" + helmet emblem + "Japanese
Craftsmanship. Delivered."

[HERO TITLE]
Main: "SAMURAI WASH" — Cinzel ALL CAPS, 72pt, champagne gold
Sub: "Waterless Hand Wash + Tire Wax" — Cinzel italic, 22pt, off-white
Khmer subtitle placeholder: [KH text region]

[BENEFIT GRID — middle 25%, three columns]
1. icon: stylized "0" with water drop crossed out
   "ZERO WATER WASTE / Eco-friendly, gentle on paint"
2. icon: house with car
   "WE COME TO YOU / Hand-wash at your home or office"
3. icon: master craftsman silhouette
   "HAND-FINISHED / Trained craftsman, every detail"

[SERVICE DETAIL STRIP — thin row beneath grid]
"Body wash · Tire wax · Door-jamb wipedown · 30 min (Sedan) / 45 min (SUV)"

[PRICING BLOCK — bottom 15%]
Clean three-row table:
"SAMURAI WASH       Sedan $12    SUV $15"
"+ Delivery Fee     Sedan $2     SUV $2"
"TOTAL AT HOME     Sedan $14    SUV $17"
Small note: "Or visit our store — no delivery fee /
មកការិយាល័យ — មិនមានថ្លៃដឹកជញ្ជូន"

[UPSELL STRIP — subtle gold-italic line below pricing]
"⭐ Add SAMURAI GLASS for rainy-season protection — see GLASS poster"

[CTA STRIP — bottom]
Same as GLASS: phone, two QR codes, "BOOK NOW / កក់ឥឡូវនេះ" badge.

[CORNER SEALS]
Top-right: "28 YRS EXPERIENCE" gold seal
Bottom-left: "GRAND OPENING -30%" red ribbon

[TECHNICAL]
Same as GLASS poster.
- 2480 × 3508 px (A4 @ 300 DPI), upscale to 4961 × 7016 (A3)
- Midjourney: --ar 210:297 --style raw --v 6 --q 2
  --cref [AMCORE_TOKYO_IMAGE_URL] [GLASS_POSTER_URL]
  (1枚目で生成した GLASS ポスターを cref に加えると sister design 担保)
- Imagen 3 / DALL-E 3: "A4 portrait print poster, 300 DPI"

[NEGATIVE]
soap suds, water spray, bucket, hose, cartoon, anime mascot, cheap, neon,
cluttered, low-resolution
```

---

## 🎨 ツール別の使い方

| ツール | 使い方 |
|---|---|
| **Midjourney v6** | 上記プロンプトをそのまま貼る。`--cref [AMCORE画像URL]` で参考画像指定。`--ar 210:297` で A4 比率 |
| **DALL-E 3 (ChatGPT)** | プロンプト貼る + AMCORE 画像も添付 + 「Use the attached image as a style reference (composition, color palette, typography mood). Do not copy content.」と追記 |
| **Imagen 3 (Google)** | 同様、参考画像添付可。A4 縦比率を明示 |
| **Adobe Firefly** | 「Aspect: 9:16」設定（A4 比率に近い）、参考画像は Style Reference 機能で |
| **Flux Pro / Ideogram** | テキストレンダリング精度が高い。価格・電話番号も AI に書かせて OK |

---

## ⚠️ 文字レンダリングの取り扱い（重要）

| 文字種 | AI に書かせる？ | 理由 |
|---|---|---|
| **英語タイトル**（SAMURAI GLASS 等） | ✅ OK | Cinzel フォントで綺麗に出る |
| **英語キャッチコピー** | △ Ideogram/Flux なら OK | Midjourney は崩れることあり |
| **価格・電話番号** | ❌ Canva で後乗せ | 数字誤りリスクが致命的 |
| **クメール語** | ❌ Canva で後乗せ | AI はほぼ確実に文字化け |
| **日本語** | ❌ Canva で後乗せ | 同上 |
| **QR コード** | ❌ プレースホルダー → Canva で実物挿入 | スキャン可能性必須 |

→ **推奨運用**: 「AI で背景＋レイアウト＋英語タイトルだけ生成」→「Canva で価格・電話・QR・他言語を上から乗せる」

---

## 🚀 運用フロー（推奨）

```
1. このファイルから該当プロンプトをコピー
2. AMCORE TOKYO 参考画像を別途準備（手元のファイル or URL）
3. 画像生成 AI に投げる
   - Midjourney: プロンプト + --cref [画像URL]
   - DALL-E/Imagen: プロンプト + 画像添付
4. 4枚バリエーション → 1枚選定
5. Canva にインポート
   - 価格表ブロックを正確な数字で上書き
   - QR コード（Telegram / Facebook）を実画像で挿入
   - クメール語・日本語を Khmer OS Siemreap / Noto Sans JP で乗せる
   - 電話番号を正確に上乗せ
6. CMYK 変換 → 印刷業者に入稿
7. A3 拡大ラミネート → 店舗掲示
```

---

## 📝 改訂履歴

| 日付 | 改訂者 | 内容 |
|---|---|---|
| 2026-05-20 | 鈴木（Claude Code 支援） | 初版作成。SAMURAI GLASS / SAMURAI WASH の A4 縦ポスター用プロンプト 2 本 |

---

## 🔗 関連ファイル

- ブランド前提: [`docs/SPEC_v8.md`](../SPEC_v8.md)（メニュー・料金の根拠）
- 出張ログ: [`reports/2026-05-phnom-penh/`](../../reports/2026-05-phnom-penh/)
- SAMURAI バイク（三輪トラック）ラッピング案: [`reports/2026-05-phnom-penh/notes/onsite-tasks.md`](../../reports/2026-05-phnom-penh/notes/onsite-tasks.md)
