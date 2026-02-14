/// <reference lib="deno.ns" />

export const config = {
  auth: { verify_jwt: false },
};

import { corsHeaders } from "../_shared/cors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

const VERSION = "apply-result v7.3 (seq 2-phase + travel_minutes, safe) 2026-02-15";

type ApplyBody = {
  plan_date: string; // "YYYY-MM-DD"
  result_id: string; // uuid
  departAt?: string; // "YYYY-MM-DDTHH:mm:ss"
  origin_id?: string; // "ORI1"
};

type DailyPlanItemRow = {
  id: string;
  plan_date: string;
  client_id: string;
  seq: number | null;
  locked: boolean | null;
  is_manual: boolean | null;
  week_start: string | null;
  day_of_week: number | null;
  travel_minutes?: number | null;
  source?: string | null;
};

type OptimizeResultRow = {
  id: string;
  plan_date: string;
  output_solution: any; // jsonb
};

function errToJson(e: unknown) {
  return e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e;
}

function extractClientOrder(output_solution: any): string[] {
  if (!output_solution || typeof output_solution !== "object") {
    throw new Error("output_solution is missing or invalid");
  }
  const clients = output_solution.clients;
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error("output_solution.clients must be a non-empty array");
  }
  for (const c of clients) {
    if (typeof c !== "string" || c.length < 1) {
      throw new Error("output_solution.clients contains invalid client_id");
    }
  }
  return clients;
}

function toInt(n: number | null): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  return 0;
}

function hhmmFromDepartAt(departAt?: string): string {
  if (!departAt) return "09:00";
  const m = departAt.match(/T(\d{2}):(\d{2})/);
  if (!m) return "09:00";
  return `${m[1]}:${m[2]}`;
}

function getSupabaseEnv() {
  // Supabase Edge runtime env
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  // ✅ 우리가 secrets로 넣을 JWT (eyJ...)
  const anonJwt =
    Deno.env.get("ANON_JWT") ??
    Deno.env.get("SUPABASE_ANON_JWT") ??
    Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_JWT") ??
    "";

  return { url, anonKey, serviceRole, anonJwt };
}

async function callKakaoMatrix(plan_date: string, departure_time: string, client_ids: string[]) {
  const { url, anonKey, anonJwt, serviceRole } = getSupabaseEnv();
  if (!url || !anonKey) throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY in Edge env");

  const endpoint = `${url}/functions/v1/kakao-matrix`;

  // ✅ Gateway 통과용 Authorization은 "JWT(eyJ...)" 가 필요
  const jwt =
    (serviceRole.startsWith("eyJ") ? serviceRole : "") ||
    (anonJwt.startsWith("eyJ") ? anonJwt : "");

  if (!jwt) {
    throw new Error(
      `kakao-matrix call needs a JWT in Authorization header. Set function secret ANON_JWT (eyJ...) and redeploy apply-result.`,
    );
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      plan_date,
      departure_time,
      client_ids,
    }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`kakao-matrix failed: status=${res.status} body=${text}`);

  const json = JSON.parse(text);
  if (!Array.isArray(json?.matrix_minutes)) throw new Error("kakao-matrix: matrix_minutes missing");
  return json as { matrix_minutes: number[][] };
}

Deno.serve(
  async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, version: VERSION, error: "POST only" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const body = (await req.json()) as ApplyBody;
      if (!body?.plan_date || !body?.result_id) {
        throw new Error("Missing required fields: plan_date, result_id");
      }

      const originId = body.origin_id?.trim() || "ORI1";
      const departure_time = hhmmFromDepartAt(body.departAt);

      const supabase = supabaseAdmin();

      // 1) rows for plan_date
      const { data: planRows, error: planErr } = await supabase
        .from("daily_plan_items")
        .select("id, plan_date, client_id, seq, locked, is_manual, week_start, day_of_week, travel_minutes, source")
        .eq("plan_date", body.plan_date);

      if (planErr) throw planErr;
      if (!planRows || planRows.length === 0) {
        throw new Error(`No daily_plan_items rows for plan_date=${body.plan_date}`);
      }

      const rows = planRows as DailyPlanItemRow[];

      // 2) optimize_results row
      const { data: resRow, error: resErr } = await supabase
        .from("optimize_results")
        .select("id, plan_date, output_solution")
        .eq("id", body.result_id)
        .single();

      if (resErr) throw resErr;

      const result = resRow as OptimizeResultRow;
      if (String(result.plan_date) !== String(body.plan_date)) {
        throw new Error("result_id does not match the plan_date");
      }

      const optimizedOrder = extractClientOrder(result.output_solution);

      // 3) locked seq fixed + available slots
      const lockedRows = rows.filter((r) => !!r.locked);
      const unlockedRows = rows.filter((r) => !r.locked);

      const seqFallbackMap = new Map<string, number>();
      {
        const sorted = [...rows].sort((a, b) => toInt(a.seq) - toInt(b.seq));
        sorted.forEach((r, idx) => seqFallbackMap.set(r.id, idx + 1));
      }

      const lockedSeqs = new Set<number>();
      for (const r of lockedRows) {
        const seq = toInt(r.seq) || seqFallbackMap.get(r.id)!;
        lockedSeqs.add(seq);
      }

      const allSeqs: number[] = [];
      for (let i = 1; i <= rows.length; i++) allSeqs.push(i);
      const availableSeqs = allSeqs.filter((s) => !lockedSeqs.has(s));

      if (availableSeqs.length !== unlockedRows.length) {
        throw new Error(
          `Seq slots mismatch. availableSeqs=${availableSeqs.length}, unlockedRows=${unlockedRows.length}. Consider reset-plan first.`,
        );
      }

      // 4) remove locked clients from optimized
      const lockedClientSet = new Set(lockedRows.map((r) => r.client_id));
      const optimizedUnlockedClients = optimizedOrder.filter((cid) => !lockedClientSet.has(cid));

      const unlockedClientSet = new Set(unlockedRows.map((r) => r.client_id));
      const filtered = optimizedUnlockedClients.filter((cid) => unlockedClientSet.has(cid));

      const filteredSet = new Set(filtered);
      const missing = [...unlockedRows]
        .sort((a, b) => toInt(a.seq) - toInt(b.seq))
        .map((r) => r.client_id)
        .filter((cid) => !filteredSet.has(cid));

      const finalUnlockedOrder = [...filtered, ...missing];

      if (finalUnlockedOrder.length !== unlockedRows.length) {
        throw new Error(
          `Unlocked count mismatch. final=${finalUnlockedOrder.length}, unlockedRows=${unlockedRows.length}`,
        );
      }

      // 5) map client_id -> new seq
      const clientToNewSeq = new Map<string, number>();
      finalUnlockedOrder.forEach((clientId, idx) => {
        clientToNewSeq.set(clientId, availableSeqs[idx]);
      });

      // 6) ✅ seq 업데이트는 "2단계"로 (TEMP -> FINAL) 해서 uq(plan_date,seq) 충돌 방지
      //    - 6a) unlockedRows를 TEMP seq(10000 + newSeq)로 먼저 옮겨서, 1..N 공간을 비움
      //    - 6b) TEMP seq에서 최종 newSeq로 내려놓음
      const TEMP_BASE = 10000;

      // 6a) TEMP
      for (const r of unlockedRows) {
        const newSeq = clientToNewSeq.get(r.client_id);
        if (!newSeq) continue;

        const tmpSeq = TEMP_BASE + newSeq;

        const { error: uErr } = await supabase
          .from("daily_plan_items")
          .update({ seq: tmpSeq, is_manual: true, source: "OPTIMIZED" })
          .eq("id", r.id);

        if (uErr) throw uErr;
      }

      // 6b) FINAL
      for (const r of unlockedRows) {
        const newSeq = clientToNewSeq.get(r.client_id);
        if (!newSeq) continue;

        const { error: uErr } = await supabase
          .from("daily_plan_items")
          .update({ seq: newSeq, is_manual: true, source: "OPTIMIZED" })
          .eq("id", r.id);

        if (uErr) throw uErr;
      }

      // 7) read back in final seq order
      const { data: afterRows, error: afterErr } = await supabase
        .from("daily_plan_items")
        .select("id, plan_date, client_id, seq, locked, is_manual, week_start, day_of_week, travel_minutes, source")
        .eq("plan_date", body.plan_date)
        .order("seq", { ascending: true });

      if (afterErr) throw afterErr;
      const finalRows = (afterRows ?? []) as DailyPlanItemRow[];

      // 8) travel_minutes (best-effort)
      let travelApplied = false;
      let travelError: any = null;

      try {
        const routeClientIds = [originId, ...finalRows.map((r) => r.client_id)];
        const km = await callKakaoMatrix(body.plan_date, departure_time, routeClientIds);
        const matrix = km.matrix_minutes;

        const idxById = new Map<string, number>();
        routeClientIds.forEach((id, i) => idxById.set(id, i));

        for (const r of finalRows) {
          const prevId =
            toInt(r.seq) === 1
              ? originId
              : finalRows.find((x) => toInt(x.seq) === toInt(r.seq) - 1)?.client_id ?? originId;

          const iPrev = idxById.get(prevId);
          const iCur = idxById.get(r.client_id);

          const t =
            iPrev != null && iCur != null && matrix?.[iPrev]?.[iCur] != null
              ? Number(matrix[iPrev][iCur])
              : 0;

          const { error: tErr } = await supabase
            .from("daily_plan_items")
            .update({ travel_minutes: Number.isFinite(t) ? t : 0, is_manual: true, source: "OPTIMIZED" })
            .eq("id", r.id);

          if (tErr) throw tErr;
        }

        travelApplied = true;
      } catch (e) {
        travelError = errToJson(e);
        // travel 실패해도 seq는 이미 적용됐으니 전체 실패 X
      }

      // 9) final readback
      const { data: finalAfter, error: finalAfterErr } = await supabase
        .from("daily_plan_items")
        .select("id, plan_date, client_id, seq, locked, is_manual, week_start, day_of_week, travel_minutes, source")
        .eq("plan_date", body.plan_date)
        .order("seq", { ascending: true });

      if (finalAfterErr) throw finalAfterErr;

      return new Response(
        JSON.stringify({
          ok: true,
          version: VERSION,
          plan_date: body.plan_date,
          applied_result_id: body.result_id,
          origin_id: originId,
          departure_time,
          travel_applied: travelApplied,
          travel_error: travelError,
          rows: finalAfter,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, version: VERSION, error: errToJson(e) }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
  { verify_jwt: false },
);
