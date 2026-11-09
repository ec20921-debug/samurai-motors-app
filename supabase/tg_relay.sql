-- 予約Bot の受付（Supabase Edge Function tg-relay）用の表（2026-11-09）
-- Supabase の SQL Editor に全部貼り付けて Run を1回押す。何度実行しても同じ結果になる。
-- 手順と考え方: docs/TG_RELAY_SUPABASE.md / 受付の本体: supabase/functions/tg-relay/index.ts
--
-- この表の役目は「データベースを毎日使った」という記録を残すことだけ（無料版の「7日使わないと止まる」対策）。
--   - 受付が Telegram から1件受けるたびに、その Bot の行を書き換える
--   - GAS が1時間に1回、受付の health を呼ぶたびに 'gas' の行を書き換える（予約が何週間なくても毎日書かれる）
-- お客様のメッセージの中身はここに残さない（Bot の種類・時刻・update_id だけ）。
--
-- 守り方: RLS を有効にしてポリシーを1つも作らない → 公開してよい鍵では読めも書けもしない。書くのは受付（service_role）だけ。

create table if not exists public.relay_heartbeat (
  source         text primary key,          -- 'booking' / 'field' / 'gas'
  last_seen_at   timestamptz not null default now(),
  last_update_id bigint
);

alter table public.relay_heartbeat enable row level security;
revoke all on table public.relay_heartbeat from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.relay_heartbeat to service_role;
