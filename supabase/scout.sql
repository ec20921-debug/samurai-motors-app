-- SAMURAI SCOUT の「読み取り用の写し」（2026-11-07）
-- Supabase の SQL Editor に全部貼り付けて Run を1回押す。何度実行しても同じ結果になる。
-- 手順と考え方: docs/SCOUT_SUPABASE.md / 書き込み側: v7-operations/ScoutSupabase.gs
--
-- 守り方:
--   - 2つの表は RLS を有効にし、ポリシーを1つも作らない → 公開してよい鍵（publishable / anon）では読めも書けもしない
--   - 書くのは GAS だけ（秘密の鍵 = RLS を通らない）
--   - SCOUT は関数 scout_read だけを呼べる。通行証（GAS がスタッフを確かめてから渡す・30日）のハッシュが
--     scout_tokens にあって期限内の時だけ、写しを1件返す

create extension if not exists pgcrypto with schema extensions;

-- 写し: key = 'shops'（お店の一覧・配列）/ 'detail:<shop_id>'（1店の詳細）
create table if not exists public.scout_cache (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- 通行証（ハッシュだけを持つ。元の文字はスタッフのスマホにしかない）
create table if not exists public.scout_tokens (
  token_hash text primary key,
  chat_id    text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.scout_cache  enable row level security;
alter table public.scout_tokens enable row level security;
revoke all on table public.scout_cache, public.scout_tokens from anon, authenticated;
-- 書くのは GAS（秘密の鍵 = service_role）だけ。「Automatically expose new tables」を外したプロジェクトでも書けるよう、はっきり許可する
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.scout_cache, public.scout_tokens to service_role;

create or replace function public.scout_read(p_token text, p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_data jsonb;
  v_at   timestamptz;
begin
  if p_token is null or length(p_token) < 32 or length(p_token) > 128 then
    raise exception 'SCOUT_TOKEN_INVALID' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.scout_tokens
     where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
       and expires_at > now()
  ) then
    raise exception 'SCOUT_TOKEN_INVALID' using errcode = '28000';
  end if;
  if p_key is null or (p_key <> 'shops' and p_key !~ '^detail:[A-Za-z0-9_-]{1,64}$') then
    return null;
  end if;
  select c.data, c.updated_at into v_data, v_at from public.scout_cache c where c.key = p_key;
  if v_data is null then
    return null;
  end if;
  return jsonb_build_object('data', v_data, 'at', v_at);
end;
$$;

revoke all on function public.scout_read(text, text) from public;
grant execute on function public.scout_read(text, text) to anon, authenticated;
