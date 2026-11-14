// Allocates one prompt per battery category for a participant, idempotently. All allocation logic lives
// in the allocate_prompts Postgres function (supabase/migrations/20261113120000_allocation.sql); this glue
// validates input, resolves eligibility from GitHub's battery.json (the source of truth for which prompts
// CAN run, cached ~60 s per instance), and calls the RPC as service role. Accepts the publishable key:
// a Prolific ID is identification, not authentication — see README "Prompt allocation" for the threat model.
// Not runnable in this repo (no supabase CLI here): behavior is covered by scripts/simulate_allocation.py
// and the extension e2e's endpoint mocks; smoke-test after deploying (README).
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const BATTERY_URL = "https://raw.githubusercontent.com/hafsa-akbar/llm-personalization-ecological-validity/main/battery.json";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

let cache: { at: number; eligible: Record<string, string[] | null> } | null = null;
async function eligibility() {
  if (cache && Date.now() - cache.at < 60_000) return cache.eligible;
  const res = await fetch(BATTERY_URL);
  if (!res.ok) throw new Error(`battery.json → HTTP ${res.status}`);
  const eligible: Record<string, string[] | null> = {};
  for (const d of (await res.json()).datasets) {
    const [name, ids] = typeof d === "string" ? [d, null] : Object.entries(d)[0];
    eligible[(name as string).replace(/\.csv$/, "")] = ids as string[] | null; // null = no GitHub restriction
  }
  cache = { at: Date.now(), eligible };
  return eligible;
}

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const { participant_key } = await req.json().catch(() => ({}));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(participant_key ?? "")) return json({ error: "invalid participant_key" }, 400);
    let eligible;
    try { eligible = await eligibility(); } catch { return json({ error: "battery.json unavailable" }, 503); } // fail closed, never assign from targets alone
    const { data, error } = await ctx.supabaseAdmin.rpc("allocate_prompts", {
      p_participant_key: participant_key,
      p_eligible: eligible,
      p_alpha: Number(Deno.env.get("PIW_ALPHA") ?? 0.6),
      p_ttl_minutes: Number(Deno.env.get("PIW_TTL_MINUTES") ?? 70),
    });
    if (error) return json({ error: error.message }, /active stage|eligible active prompts/.test(error.message) ? 409 : 500);
    return json(data);
  }),
};
