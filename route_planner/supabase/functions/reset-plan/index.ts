/// <reference lib="deno.ns" />

import { corsHeaders } from "../_shared/cors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

const VERSION = "reset-plan v5.2 (update-only) 2026-02-01 15:40 KST";
const TABLE = "daily_plan_items";

type ResetBody = { plan_date: string };

type Row = { id: string; seq: number | null };

function toInt(n: number | null): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  return 0;
}

function normalizeError(e: unknown) {
  if (e instanceof Error) return { kind: "Error", message: e.message, stack: e.stack };
  try {
    return { kind: "Object", value: JSON.parse(JSON.stringify(e)) };
  } catch {
    return { kind: typeof e, value: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, version: VERSION, table: TABLE, error: "POST only" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as ResetBody;
    if (!body?.plan_date) throw new Error("Missing plan_date");

    const supabase = supabaseAdmin();

    const { data: rows, error } = await supabase
      .from(TABLE)
      .select("id, seq")
      .eq("plan_date", body.plan_date);

    if (error) throw error;
    if (!rows || rows.length === 0) throw new Error(`No rows for plan_date=${body.plan_date}`);

    const sorted = [...(rows as Row[])].sort((a, b) => toInt(a.seq) - toInt(b.seq));

    // UPDATE-only: upsert 금지 (NOT NULL week_start 때문에 insert 경로 타면 터짐)
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const newSeq = i + 1;

      const { error: upErr } = await supabase
        .from(TABLE)
        .update({ seq: newSeq })
        .eq("id", r.id);

      if (upErr) throw upErr;
    }

    const { data: after, error: afterErr } = await supabase
      .from(TABLE)
      .select("id, plan_date, client_id, seq, locked, is_manual, week_start")
      .eq("plan_date", body.plan_date)
      .order("seq", { ascending: true });

    if (afterErr) throw afterErr;

    return new Response(
      JSON.stringify({ ok: true, version: VERSION, table: TABLE, plan_date: body.plan_date, rows: after }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, version: VERSION, table: TABLE, error: normalizeError(e) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
