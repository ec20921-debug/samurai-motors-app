// Supabase Edge Function: tg-relay（予約Bot の受付・2026-11-09）
// 本体は relay.js。ここは Supabase の実行環境（Deno）とつなぐだけ。
// デプロイ時は「JWT の確認（Verify JWT）」を必ずオフにする（Telegram は Supabase の鍵を持たないため）。
// 代わりに合言葉（TG_WEBHOOK_SECRET / GAS_RELAY_KEY）で守る。手順: docs/TG_RELAY_SUPABASE.md
import { createHandler } from './relay.js';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const handle = createHandler({
  env: (k: string) => Deno.env.get(k),
  fetch: (input: string, init: RequestInit) => fetch(input, init),
  waitUntil: (p: Promise<unknown>) => EdgeRuntime.waitUntil(p),
});

Deno.serve((req: Request) => handle(req));
