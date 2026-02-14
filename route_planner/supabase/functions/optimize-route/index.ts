// route_planner/supabase/functions/optimize-route/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Stop = {
  id: string; // client_id (HOME 포함 가능)
  lat: number;
  lng: number;
  service_minutes?: number; // 없으면 0
  priority?: boolean; // 없으면 false
  locked?: boolean; // locked=true면 seq 기반으로 고정
  seq?: number | null; // locked=true일 때 사용 (예: 1,2,3...)
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

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// KST(Asia/Seoul) 기준 YYYY-MM-DD
function kstDateISO(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function normalizeSolverUrl(url: string) {
  if (!url) return url;
  const u = url.trim();
  if (u.endsWith("/docs")) return u.replace(/\/docs$/, "/solve");
  try {
    const parsed = new URL(u);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/solve";
      return parsed.toString();
    }
  } catch {
    // ignore
  }
  return u;
}

async function callSolverApi(solverUrlRaw: string, payload: unknown) {
  const solverUrl = normalizeSolverUrl(solverUrlRaw);

  console.log("SOLVER_API_URL(raw) =", solverUrlRaw);
  console.log("SOLVER_API_URL(norm) =", solverUrl);

  let payloadStr = "";
  try {
    payloadStr = JSON.stringify(payload);
  } catch (e: any) {
    throw new Error(`solver payload stringify failed: ${String(e?.message ?? e)}`);
  }

  console.log("solver payload preview =", payloadStr.slice(0, 800));

  const res = await fetch(solverUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payloadStr,
    redirect: "manual",
  });

  console.log("solver status =", res.status, "redirected=", res.redirected, "url=", res.url);

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`solver-api error ${res.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

Deno.serve(
  async (req) => {
    try {
      if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
      if (req.method !== "POST") return new Response("Use POST", { status: 405, headers: corsHeaders });

      // ✅ req.json 실패를 {}로 삼키지 말고 400으로 명확히
      let body: any;
      try {
        body = await req.json();
      } catch {
        return badRequest("Invalid JSON body (req.json failed). Check client request body.");
      }

      const stops: Stop[] = body?.stops;

      // env (secrets)
      const SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") ?? "";
      const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ?? "";
      const SOLVER_API_URL = Deno.env.get("SOLVER_API_URL") ?? "";

      if (!SUPABASE_URL) return badRequest("Missing env: PUBLIC_SUPABASE_URL");
      if (!SERVICE_ROLE_KEY) return badRequest("Missing env: SERVICE_ROLE_KEY");
      if (!SOLVER_API_URL) return badRequest("Missing env: SOLVER_API_URL");
      if (!Array.isArray(stops) || stops.length < 2) {
        return badRequest("Body.stops must be an array length >= 2");
      }

      // ✅ plan_date 강제 생성/주입
      const plan_date: string =
        typeof body?.plan_date === "string" && body.plan_date.length >= 10
          ? body.plan_date.slice(0, 10)
          : kstDateISO();

      // validate stops
      for (const s of stops) {
        assert(typeof s?.id === "string" && s.id.length > 0, "stop.id must be string");
        assert(typeof s?.lat === "number" && isFinite(s.lat), "stop.lat must be number");
        assert(typeof s?.lng === "number" && isFinite(s.lng), "stop.lng must be number");
        if (s.service_minutes != null) {
          assert(Number.isInteger(s.service_minutes) && s.service_minutes >= 0, "service_minutes must be int>=0");
        }
        if (s.seq != null) {
          assert(Number.isInteger(s.seq) && s.seq >= 0, "seq must be int>=0 or null");
        }
      }

      const n = stops.length;
      const client_ids = stops.map((s) => s.id);
      const service_minutes = stops.map((s) => s.service_minutes ?? 0);
      const priority_flags = stops.map((s) => Boolean(s.priority));

      // locked_positions 규칙: idx0(HOME)=0, locked면 seq, 아니면 null
      const locked_positions: (number | null)[] = stops.map((s, idx) => {
        if (idx === 0) return 0;
        if (s.locked) return s.seq ?? null;
        return null;
      });

      const fixed = locked_positions.filter((v) => v !== null) as number[];
      const uniq = new Set(fixed);
      if (fixed.length !== uniq.size) {
        return badRequest("locked_positions conflict: duplicate fixed position values");
      }

      const start_index = 0;
      const end_index = 0;
      const time_limit_seconds = Number.isInteger(body?.time_limit_seconds) ? body.time_limit_seconds : 3;

      // 1) call kakao-matrix
      const kakaoUrl = `${SUPABASE_URL}/functions/v1/kakao-matrix`;

      const matrixRes = await fetch(kakaoUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          apikey: SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({
          plan_date,
          stops: stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng })),
          departAt: body?.departAt ?? null,
        }),
      });

      if (!matrixRes.ok) {
        const t = await matrixRes.text().catch(() => "");
        return json({ ok: false, error: "kakao-matrix failed", status: matrixRes.status, body: t }, 502);
      }

      const matrixJson = await matrixRes.json();
      const matrix_minutes = matrixJson?.matrix_minutes;

      if (!Array.isArray(matrix_minutes) || matrix_minutes.length !== n) {
        return json({ ok: false, error: "kakao-matrix response missing matrix_minutes NxN", got: matrixJson }, 502);
      }

      // 2) call solver (디버깅용 wrapper)
      let solved: any;
      try {
        solved = await callSolverApi(SOLVER_API_URL, {
          client_ids,
          matrix_minutes,
          service_minutes,
          priority_flags,
          locked_positions,
          start_index,
          end_index,
          time_limit_seconds,
          plan_date,
        });
      } catch (e: any) {
        return json(
          {
            ok: false,
            error: "solver failed",
            detail: String(e?.message ?? e),
          },
          502,
        );
      }

      return json({
        ok: true,
        plan_date,
        client_ids,
        matrix_minutes,
        solver: solved,
      });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500);
    }
  },
  { verify_jwt: false }, // ✅ 핵심
);
