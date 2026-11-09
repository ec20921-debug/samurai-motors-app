// tg-relay の本体（2026-11-09）。index.ts から読み込む。Node のテスト（tests/tg_relay_edge.test.js）からも読む。
//
// しくみ:
//   Telegram ─(届いた瞬間)→ この受付 ─(すぐ)→ GAS の doPost（action=tg_relay・キューに積むだけ）
//                                        └→ 続けて GAS の doPost（action=tg_drain・キューをその場で処理）
//   GAS がキューに積めなかった時は 502 を返す → Telegram が後で送り直す（メッセージは消えない）
//
// 守り方:
//   - Telegram からの呼び出しは、setWebhook で渡した合言葉（ヘッダー X-Telegram-Bot-Api-Secret-Token）が合う時だけ受ける
//   - GAS へは別の合言葉（relayKey）を付ける。GAS 側も合わない呼び出しは捨てる
//   - お客様のメッセージの中身はログにも表にも残さない（Bot の種類と update_id だけ）
//
// 環境変数（Supabase の Edge Functions → Secrets）:
//   GAS_EXEC_URL       予約Bot（v7）のウェブアプリの URL（https://script.google.com/macros/s/…/exec）
//   GAS_RELAY_KEY      GAS と受付の合言葉（v7 の Script Property TG_RELAY_KEY と同じ値）
//   TG_WEBHOOK_SECRET  Telegram と受付の合言葉（v7 の Script Property TG_WEBHOOK_SECRET と同じ値）
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  Supabase が自動で入れる（設定不要）

export const BOTS = ['booking', 'field'];
const MAX_BODY_BYTES = 1024 * 1024;
const ENQUEUE_TIMEOUT_MS = 20000;
const DRAIN_TIMEOUT_MS = 60000;

/** 長さが同じでも中身を1文字ずつ全部比べる（合言葉の当て推量で時間差を出さない） */
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

function sbHeaders(key) {
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  return h;
}

/**
 * @param {{env:(name:string)=>string|undefined, fetch:Function, waitUntil:(p:Promise<any>)=>void, log?:Function}} deps
 * @return {(req: Request) => Promise<Response>}
 */
export function createHandler(deps) {
  const env = (k) => String(deps.env(k) || '').trim();
  const log = deps.log || ((m) => console.log(m));

  async function callGas(body, timeoutMs) {
    const url = env('GAS_EXEC_URL');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // GAS の /exec は 302 で別の URL に答えを置くので redirect: 'follow'（POST は GET に変わって答えを取りに行く）
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ relayKey: env('GAS_RELAY_KEY') }, body)),
        redirect: 'follow',
        signal: ctl.signal
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      return { status: res.status, data };
    } finally {
      clearTimeout(t);
    }
  }

  async function heartbeat(source, updateId) {
    const url = env('SUPABASE_URL').replace(/\/+$/, '');
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return false;
    try {
      const res = await deps.fetch(url + '/rest/v1/relay_heartbeat?on_conflict=source', {
        method: 'POST',
        headers: Object.assign(sbHeaders(key), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ source, last_seen_at: new Date().toISOString(), last_update_id: updateId == null ? null : updateId }])
      });
      if (!res.ok) log('heartbeat ' + source + ' -> ' + res.status);
      return res.ok;
    } catch (e) {
      log('heartbeat ' + source + ' error ' + e);
      return false;
    }
  }

  function configured() {
    return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env('GAS_EXEC_URL')) &&
      env('GAS_RELAY_KEY').length >= 24 && env('TG_WEBHOOK_SECRET').length >= 24;
  }

  return async function handle(req) {
    const u = new URL(req.url);

    // GAS からの見回り（1時間に1回）。データベースに1行書く＝無料版の「7日使わないと止まる」にかからない
    if (req.method === 'GET') {
      if (!configured() || !safeEqual(req.headers.get('x-relay-key'), env('GAS_RELAY_KEY'))) return json({ ok: false }, 404);
      const db = await heartbeat('gas', null);
      return json({ ok: true, db });
    }

    if (req.method !== 'POST') return json({ ok: false }, 405);
    if (!configured()) { log('not configured'); return json({ ok: false }, 503); }
    if (!safeEqual(req.headers.get('x-telegram-bot-api-secret-token'), env('TG_WEBHOOK_SECRET'))) return json({ ok: false }, 401);

    const bot = u.searchParams.get('bot') || '';
    if (BOTS.indexOf(bot) < 0) return json({ ok: false }, 400);

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) { log('too large ' + bot); return json({ ok: true, ignored: 'too_large' }); }
    let update;
    try { update = JSON.parse(raw); } catch (_) { update = null; }
    // 形が壊れたものは 200 で捨てる（Telegram に送り直させても直らない）
    if (!update || typeof update !== 'object' || !Number.isInteger(update.update_id)) return json({ ok: true, ignored: 'bad_update' });

    let r;
    try {
      r = await callGas({ action: 'tg_relay', botType: bot, update }, ENQUEUE_TIMEOUT_MS);
    } catch (e) {
      log('enqueue error ' + bot + ' ' + update.update_id + ' ' + e);
      return json({ ok: false }, 502);   // Telegram が送り直す
    }
    if (!r.data || r.data.ok !== true) {
      log('enqueue rejected ' + bot + ' ' + update.update_id + ' status=' + r.status + ' msg=' + String(r.data && r.data.message || ''));
      return json({ ok: false }, 502);
    }

    // 積めたら、その場で処理を頼む（結果は待たない。失敗しても GAS の1分ごとの処理が拾う）
    deps.waitUntil(Promise.all([
      callGas({ action: 'tg_drain' }, DRAIN_TIMEOUT_MS).catch((e) => log('drain error ' + e)),
      heartbeat(bot, update.update_id)
    ]));
    return json({ ok: true });
  };
}
