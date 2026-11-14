// Marks a participant's assignments submitted once the extension records the JSON download (pending and
// expired both flip — late submissions count; repeated calls are no-ops server-side). Thin glue over the
// submit_assignments Postgres function; same auth/testing notes as allocate/index.ts.
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const { participant_key, stage_id } = await req.json().catch(() => ({}));
    if (!ID.test(participant_key ?? "") || !ID.test(stage_id ?? "")) return json({ error: "invalid request" }, 400);
    const { data, error } = await ctx.supabaseAdmin.rpc("submit_assignments", { p_participant_key: participant_key, p_stage_id: stage_id });
    if (error) return json({ error: error.message }, /no assignments/.test(error.message) ? 404 : 500);
    return json(data);
  }),
};
