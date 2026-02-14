// deno-lint-ignore-file
/// <reference lib="deno.unstable" />

export const config = {
  auth: { verify_jwt: false },
};

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ✅ CORS 헤더 (중요)
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type StopLite = { id: string; lat: number; lng: number };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const KAKAO_REST_KEY = Deno.env.get("KAKAO_REST_KEY");

// Kakao 미래 길찾기
const KAKAO_FUTURE_ENDPOINT_URL = "https://apis-navi.kakaomobility.com/v1/future/directions";

const MAX_TRAVEL_MIN = 1440;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

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

function normalizeDepartAtToHHmm(departAt?: string | null) {
  if (!departAt) return null;
  const m1 = /^(\d{2}):(\d{2})$/.exec(departAt);
  if (m1) return `${m1[1]}:${m1[2]}`;
  const m2 = /^(\d{2}):(\d{2}):(\d{2})$/.exec(departAt);
  if (m2) return `${m2[1]}:${m2[2]}`;
  return null;
}

function hhmmToMin(hhmm: string) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error("departure_time must be HH:mm");
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) throw new Error("departure_time out of range");
  return h * 60 + mm;
}

function toKakaoDeparture(planDate: string, hhmm: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate);
  if (!m) throw new Error("plan_date must be YYYY-MM-DD");
  const [_, y, mo, d] = m;
  const t = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!t) throw new Error("departure_time must be HH:mm");
  return `${y}${mo}${d}${t[1]}${t[2]}`;
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const n = Math.min(concurrency, items.length);

  async function w() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: n }, () => w()));
  return results;
}

type KakaoFutureResp = {
  routes?: Array<{
    summary?: {
      duration?: number;
      distance?: number;
    };
  }>;
};

type Failure = {
  origin: string;
  dest: string;
  reason: string;
  duration_raw?: number | null;
  duration_sec_norm?: number | null;
  distance_m?: number | null;
  used_minutes: number;
  mode: "KAKAO" | "FALLBACK";
};

function clampTravelMin(x: number) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > MAX_TRAVEL_MIN) return MAX_TRAVEL_MIN;
  return Math.trunc(x);
}

function normalizeDurationSeconds(durationRaw: number): number | null {
  if (!Number.isFinite(durationRaw) || durationRaw < 0) return null;
  if (durationRaw <= 200000) return durationRaw;
  const sec = durationRaw / 1000;
  if (sec > 0 && sec <= 200000) return sec;
  return null;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function dayTypeFromPlanDate(planDate: string): "WEEKDAY" | "WEEKEND" {
  const d = new Date(`${planDate}T00:00:00+09:00`);
  const day = d.getDay();
  return day === 0 || day === 6 ? "WEEKEND" : "WEEKDAY";
}

function bucketSizeMinForDayType(dayType: "WEEKDAY" | "WEEKEND") {
  return dayType === "WEEKDAY" ? 30 : 60;
}

function bucketStartMin(minOfDay: number, bucketSize: number) {
  const b = Math.floor(minOfDay / bucketSize) * bucketSize;
  return Math.min(1439, Math.max(0, b));
}

function fallbackTravelMinutes(oLat: number, oLon: number, dLat: number, dLon: number, dayType: "WEEKDAY" | "WEEKEND", departMinOfDay: number) {
  const distM = haversineMeters(oLat, oLon, dLat, dLon);
  if (distM < 1) return { minutes: 0, distance_m: 0 };

  const roadKm = (distM * 1.3) / 1000;

  const isRush =
    dayType === "WEEKDAY" &&
    ((departMinOfDay >= 7 * 60 && departMinOfDay <= 10 * 60) || (departMinOfDay >= 17 * 60 && departMinOfDay <= 20 * 60));
  const isNight = departMinOfDay >= 21 * 60 || departMinOfDay <= 5 * 60;

  let speed = 22;
  if (dayType === "WEEKEND") speed = 26;
  if (isRush) speed = 16;
  if (isNight) speed = 30;

  const minutes = Math.ceil((roadKm / speed) * 60);
  return { minutes: clampTravelMin(minutes), distance_m: Math.round(distM) };
}

Deno.serve(async (req) => {
  // ✅ preflight 먼저 처리
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    assert(req.method === "POST", "POST only");

    assert(SUPABASE_URL, "SUPABASE_URL missing (Functions secrets)");
    assert(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY missing (Functions secrets)");
    assert(KAKAO_REST_KEY, "KAKAO_REST_KEY missing (Functions secrets)");

    const bodyAny = (await req.json()) as any;

    const plan_date_raw = typeof bodyAny?.plan_date === "string" ? bodyAny.plan_date : "";
    const plan_date = plan_date_raw && /^\d{4}-\d{2}-\d{2}$/.test(plan_date_raw) ? plan_date_raw : kstDateISO();

    const departure_time_raw = typeof bodyAny?.departure_time === "string" ? bodyAny.departure_time : "";
    const departAtHHmm = normalizeDepartAtToHHmm(bodyAny?.departAt ?? null);
    const departure_time =
      departure_time_raw && /^\d{2}:\d{2}$/.test(departure_time_raw) ? departure_time_raw : (departAtHHmm ?? "09:00");

    assert(/^\d{4}-\d{2}-\d{2}$/.test(plan_date), "plan_date invalid");
    assert(/^\d{2}:\d{2}$/.test(departure_time), "departure_time must be HH:mm");

    const stops_in = Array.isArray(bodyAny?.stops) ? bodyAny.stops : null;
    const client_ids_in = Array.isArray(bodyAny?.client_ids) ? bodyAny.client_ids : null;

    let client_ids: string[] = [];
    if (stops_in) {
      client_ids = stops_in.map((s: any) => String(s?.id ?? ""));
      assert(client_ids.length >= 2 && client_ids.length <= 15, "stops length 2..15");
      for (const id of client_ids) assert(id && typeof id === "string", "stops[].id required");
    } else {
      assert(Array.isArray(client_ids_in), "client_ids required (or stops required)");
      client_ids = client_ids_in.map((x: any) => String(x));
      assert(client_ids.length >= 2 && client_ids.length <= 15, "client_ids length 2..15");
    }

    const departMinOfDay = hhmmToMin(departure_time);
    const day_type = dayTypeFromPlanDate(plan_date);
    const bucket_size_min = bucketSizeMinForDayType(day_type);
    const depart_bucket_min = bucketStartMin(departMinOfDay, bucket_size_min);
    const kakao_departure = toKakaoDeparture(plan_date, departure_time);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const coordById = new Map<string, { lat: number; lon: number }>();

    if (stops_in) {
      for (const s of stops_in as any[]) {
        const id = String(s?.id ?? "");
        const lat = Number(s?.lat);
        const lng = Number(s?.lng);
        assert(id.length > 0, "stops[].id required");
        assert(Number.isFinite(lat), "stops[].lat must be number");
        assert(Number.isFinite(lng), "stops[].lng must be number");
        coordById.set(id, { lat, lon: lng });
      }
      assert(coordById.size === client_ids.length, "stops missing coords");
    } else {
      const { data: clients, error: cErr } = await supabase.from("clients").select("id, lat, lon").in("id", client_ids);
      if (cErr) throw new Error(cErr.message);
      assert(clients && clients.length === client_ids.length, "clients missing (or lat/lon missing)");
      for (const c of clients as any[]) coordById.set(String(c.id), { lat: Number(c.lat), lon: Number(c.lon) });
    }

    const pairs: Array<{ o: string; d: string }> = [];
    for (const o of client_ids) for (const d of client_ids) if (o !== d) pairs.push({ o, d });

    const { data: cached, error: cacheErr } = await supabase.rpc("get_kakao_cache_batch", {
      p_plan_date: plan_date,
      p_depart_bucket_min: depart_bucket_min,
      p_origin_ids: client_ids,
      p_dest_ids: client_ids,
    });
    if (cacheErr) throw new Error(cacheErr.message);

    const cacheMap = new Map<string, { travel: number; dist: number | null }>();
    for (const row of (cached ?? []) as any[]) {
      cacheMap.set(`${row.origin_client_id}→${row.dest_client_id}`, {
        travel: Number(row.travel_minutes),
        dist: row.distance_m === null ? null : Number(row.distance_m),
      });
    }

    const misses = pairs.filter(({ o, d }) => !cacheMap.has(`${o}→${d}`));

    const failures: Failure[] = [];
    let kakao_called = 0;
    let skipped_same_coord = 0;

    const CONCURRENCY = 6;

    async function fetchOrFallback(oId: string, dId: string) {
      const o = coordById.get(oId)!;
      const d = coordById.get(dId)!;

      if (o.lat === d.lat && o.lon === d.lon) {
        skipped_same_coord++;
        failures.push({ origin: oId, dest: dId, reason: "same_coord -> 0min", used_minutes: 0, mode: "FALLBACK" });
        return { o: oId, d: dId, travel_minutes: 0, distance_m: 0, raw: { fallback: true, reason: "same_coord" } };
      }

      const origin = `${o.lon},${o.lat}`;
      const destination = `${d.lon},${d.lat}`;
      const u = new URL(KAKAO_FUTURE_ENDPOINT_URL);
      u.searchParams.set("origin", origin);
      u.searchParams.set("destination", destination);
      u.searchParams.set("departure_time", kakao_departure);

      kakao_called++;

      try {
        const res = await fetch(u.toString(), {
          method: "GET",
          headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}`, "Content-Type": "application/json" },
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          const fb = fallbackTravelMinutes(o.lat, o.lon, d.lat, d.lon, day_type, departMinOfDay);
          failures.push({ origin: oId, dest: dId, reason: `kakao_http_${res.status}`, distance_m: fb.distance_m, used_minutes: fb.minutes, mode: "FALLBACK" });
          return { o: oId, d: dId, travel_minutes: fb.minutes, distance_m: fb.distance_m, raw: { fallback: true, reason: `kakao_http_${res.status}`, body: txt } };
        }

        const json = (await res.json()) as KakaoFutureResp;
        const durationRaw = json?.routes?.[0]?.summary?.duration;
        const distanceM = json?.routes?.[0]?.summary?.distance;

        const durSec = Number.isFinite(durationRaw as number) ? normalizeDurationSeconds(Number(durationRaw)) : null;
        if (durSec === null) {
          const fb = fallbackTravelMinutes(o.lat, o.lon, d.lat, d.lon, day_type, departMinOfDay);
          failures.push({ origin: oId, dest: dId, reason: "missing_or_bad_duration", distance_m: fb.distance_m, used_minutes: fb.minutes, mode: "FALLBACK" });
          return { o: oId, d: dId, travel_minutes: fb.minutes, distance_m: fb.distance_m, raw: { fallback: true, reason: "missing_or_bad_duration", kakao: json } };
        }

        const travelMin = clampTravelMin(Math.ceil(durSec / 60));
        if (travelMin >= MAX_TRAVEL_MIN) {
          const fb = fallbackTravelMinutes(o.lat, o.lon, d.lat, d.lon, day_type, departMinOfDay);
          failures.push({ origin: oId, dest: dId, reason: "kakao_duration_too_large -> fallback", used_minutes: fb.minutes, distance_m: fb.distance_m, mode: "FALLBACK" });
          return { o: oId, d: dId, travel_minutes: fb.minutes, distance_m: fb.distance_m, raw: { fallback: true, reason: "kakao_duration_too_large", kakao: json } };
        }

        const distance_m = Number.isFinite(distanceM) ? Number(distanceM) : null;
        return { o: oId, d: dId, travel_minutes: travelMin, distance_m, raw: json };
      } catch (e) {
        const fb = fallbackTravelMinutes(o.lat, o.lon, d.lat, d.lon, day_type, departMinOfDay);
        failures.push({ origin: oId, dest: dId, reason: `exception:${String((e as any)?.message ?? e)}`, distance_m: fb.distance_m, used_minutes: fb.minutes, mode: "FALLBACK" });
        return { o: oId, d: dId, travel_minutes: fb.minutes, distance_m: fb.distance_m, raw: { fallback: true, reason: "exception" } };
      }
    }

    const fetched = await runPool(misses, CONCURRENCY, (p) => fetchOrFallback((p as any).o, (p as any).d));

    if (fetched.length > 0) {
      const rows = fetched.map((r: any) => ({
        plan_date,
        depart_bucket_min,
        origin_client_id: r.o,
        dest_client_id: r.d,
        travel_minutes: clampTravelMin(r.travel_minutes),
        distance_m: r.distance_m,
        raw: r.raw,
      }));

      const { error: upErr } = await supabase.from("kakao_travel_cache").upsert(rows, {
        onConflict: "plan_date,depart_bucket_min,origin_client_id,dest_client_id",
      });
      if (upErr) throw new Error(upErr.message);

      for (const r of fetched as any[]) {
        cacheMap.set(`${r.o}→${r.d}`, { travel: clampTravelMin(r.travel_minutes), dist: r.distance_m ?? null });
      }
    }

    const n = client_ids.length;
    const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const o = client_ids[i];
        const d = client_ids[j];
        const v = cacheMap.get(`${o}→${d}`);
        matrix[i][j] = v ? clampTravelMin(v.travel) : MAX_TRAVEL_MIN;
      }
    }

    return json({
      plan_date,
      day_type,
      departure_time,
      depart_bucket_min,
      bucket_size_min,
      client_ids,
      matrix_minutes: matrix,
      cache_hit: pairs.length - misses.length,
      cache_miss: misses.length,
      kakao_called,
      skipped_same_coord,
      kakao_failures: failures.length,
      failures,
      cache_mode: "v2_plandate_bucket",
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message ?? e) }, 400);
  }
});
