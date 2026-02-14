/// <reference lib="deno.ns" />

import { corsHeaders } from "../_shared/cors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

const VERSION = "save-result v1 2026-02-01 16:20 KST";

type Body = {
  plan_date: string;         // "YYYY-MM-DD"
  input_payload?: any;       // optional
  output_solution: any;      // required (jsonb)
  meta?: any;                // optional
};

function normalizeError(e: unknown) {
  if (e instanceof Error) return { kind: "Error", message: e.message, stack: e.stack };
  try { return { kind: "Object", value: JSON.parse(JSON.stringify(e)) }; }
  catch { return { kind: typeof e, value: String(e) }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, version: VERSION, error: "POST only" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as Body;
    if (!body?.plan_date) throw new Error("Missing plan_date");
    if (!body?.output_solution) throw new Error("Missing output_solution");

    const supabase = supabaseAdmin();

    const { data, error } = await supabase
      .from("optimize_results")
      .insert({
        plan_date: body.plan_date,
        input_payload: body.input_payload ?? null,
        output_solution: body.output_solution,
        meta: body.meta ?? null,
      })
      .select("id, plan_date, created_at")
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, version: VERSION, saved: data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, version: VERSION, error: normalizeError(e) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
