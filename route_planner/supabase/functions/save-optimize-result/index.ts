// supabase/functions/save-optimize-result/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}
function badRequest(msg: string) {
  return json({ ok: false, error: msg }, 400);
}

Deno.serve(
  async (req) => {
    try {
      if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
      if (req.method !== "POST") return new Response("Use POST", { status: 405, headers: corsHeaders });

      const body = await req.json().catch(() => ({}));
      const plan_date = body?.plan_date;
      const clients = body?.clients; // array of client_id strings
      const meta = body?.meta ?? {};

      if (typeof plan_date !== "string" || !plan_date) return badRequest("plan_date required");
      if (!Array.isArray(clients) || clients.length < 2) return badRequest("clients must be array length >= 2");

      for (const c of clients) {
        if (typeof c !== "string" || !c) return badRequest("clients[] must be non-empty string");
      }

      const SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") ?? "";
      const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ?? "";

      if (!SUPABASE_URL) return badRequest("Missing env: PUBLIC_SUPABASE_URL");
      if (!SERVICE_ROLE_KEY) return badRequest("Missing env: SERVICE_ROLE_KEY");

      const url = `${SUPABASE_URL}/rest/v1/optimize_results?select=id`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          plan_date,
          input_payload: body?.input_payload ?? null,
          output_solution: { clients },
          meta,
        }),
      });

      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return json({ ok: false, error: "insert optimize_results failed", status: res.status, body: text }, 502);
      }

      const rows = JSON.parse(text);
      const result_id = rows?.[0]?.id;
      if (!result_id) return json({ ok: false, error: "missing id from insert response", raw: rows }, 502);

      return json({ ok: true, result_id });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500);
    }
  },
  { verify_jwt: false }, // ✅ 핵심
);
