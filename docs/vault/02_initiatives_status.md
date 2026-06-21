# 02 進行中施策ステータス

最終更新: 2026-06-21

## 🎬 TikTok / ショート動画

- 元動画（Samurai Motors プロモ 53s・16:9）から**縦型9:16の10本**を制作済み（`tiktok_exports/tt_01〜tt_10`）。
- フックは **英語＋クメール語**の2行。BGMは著作権フリーの自前合成。
- キャプションは **クメール語＋英語＋ハッシュタグ**（`docs/marketing/sns_captions_km_en.md`）。
- **是正・再レンダリング（2026-06-21 完了・利休）**: ゴールドを **#D4AF37** に統一（旧 #E9C46A 廃止）＋ 末尾エンドカードに **タグライン**「Japanese Craftsmanship. Delivered.」(#D4AF37)＋ **CTA「Tel / Telegram: 096-713-8456」**(白) を重畳。ロゴ非干渉位置。10本上書き済み（H.264/yuv420p/crf19/30fps/aac160k）。
- **BGM（2026-06-21 刷新・利休）**: 2種を動画タイプ別に適用。
  - **beat**（lo-fi boom-bap・88BPM）: サブベース＋柔らかキック＋2&4スネア＋スウィング8分ハット＋ジャジーコード(Am7→Dm7)＋薄いvinyl crackle、キックでサイドチェイン。mean約 -7dB。
  - **cine**（シネマティック）: デチューンパッド＋サブドローン＋緩やかスウェル＋長リバーブ＋lowpass。mean約 -11dB（控えめ・上品）。
  - ミックス: 元動画の環境音を約25%残し amix→alimiter。先頭/末尾フェード付き。
  - ⚠️ 制約: 現環境では音を試聴不可。合成BGMの品質に限界あり。さらに上を狙うなら「自前ロイヤリティフリー音源の支給」or「アプリ内トレンド楽曲付与」も選択肢（要判断）。
- 担当: 利休（制作）/ 政宗（段取り・他施策整合）。

## 📣 SNS自動投稿（FB / IG / TikTok）

- 比較資料作成済み（`docs/marketing/SNS_AUTOPOST_COMPARISON.md`）。
- 要点: **FB/IGは完全自動化が現実的**。**TikTokは審査通過まで半自動**（下書き止め）。
- IG/TikTokは**動画の公開URL**が必要 → GitHub Pages で `tiktok_exports/*.mp4` を公開URL化（無料）で対応可。
- キャプション方針: **KM+EN+ハッシュタグ自動生成**（決定済み）。
- **未決**: 方式A（ノーコード）/ B（ローコード）/ C（フルカスタム）のどれで進めるか。比較資料を見て判断待ち。

## 🌧️ 撥水キャンペーン（雨季）

- ドライバー経由の口コミ獲得を狙う「トロイの木馬」戦略（`docs/WATER_REPELLENT_TROJAN_CAMPAIGN.md`）。
- 資材: `docs/WATER_REPELLENT_CAMPAIGN_MATERIALS.md`。

## 🤝 パートナー / VIPプログラム

- `docs/PARTNER_PROGRAM_DESIGN_v3.md` ほか。VIP Partnership PDF を改訂運用中。

## ⚙️ システム（v7）

- v7 単独稼働中。Phase 0〜の基盤整備フェーズ。SPEC は v7.3〜v8 で更新。
- clasp 自動デプロイ運用。

> 更新ルール: 状況が動いたら本ファイルを書き換え、`03_decisions_log.md` に決定を1行追記する。
