"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/src/lib/supabaseClient";

const ORIGIN_ID = "ORI1"; // ✅ clients 테이블에 있는 “집” client_id

type DailyRow = {
  id: string;
  week_start: string;
  day_of_week: number;
  plan_date: string;
  client_id: string;
  seq: number;
  is_manual: boolean;
  locked: boolean;

  service_minutes: number;
  service_minutes_override?: number | null;

  travel_minutes?: number;
  source: string;

  clients?: { id: string; name: string; lat: number | null; lon: number | null } | null;
};

type Stop = {
  id: string;
  lat: number;
  lng: number; // ✅ Edge optimize-route expects lng
  service_minutes?: number;
  priority?: boolean;
  locked?: boolean;
  seq?: number | null;
};

type SaveOptimizeResp = {
  ok: boolean;
  result_id?: string;
  error?: any;
};

type ApplyEdgeResp = {
  ok: boolean;
  error?: any;
  applied_result_id?: string;
};

// ✅ 요일 한글 표시
const DOW_LABEL: Record<number, string> = {
  1: "월",
  2: "화",
  3: "수",
  4: "목",
  5: "금",
  6: "토",
  7: "일",
};

// ---------- date/time helpers ----------
function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function toISODate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function getWeekStartMonday(date: Date) {
  const d = new Date(date);
  const day = d.getDay(); // Sun=0 ... Sat=6
  const isoDow = day === 0 ? 7 : day; // Mon=1 ... Sun=7
  const diff = isoDow - 1;
  d.setDate(d.getDate() - diff);
  return toISODate(d);
}
function getIsoDow(date: Date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}
function timeToMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function minutesToHHMM(mins: number) {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad2(h)}:${pad2(mm)}`;
}
function planDateFromWeekStart(weekStart: string, dow: number) {
  const d = new Date(`${weekStart}T00:00:00`);
  if (Number.isNaN(d.getTime())) return weekStart;
  d.setDate(d.getDate() + (dow - 1));
  return toISODate(d);
}

// ---------- normalize ----------
function normalizeDailyRows(data: unknown): DailyRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((r: any) => ({
    id: String(r.id),
    week_start: String(r.week_start),
    day_of_week: Number(r.day_of_week),
    plan_date: String(r.plan_date ?? ""),
    client_id: String(r.client_id),
    seq: Number(r.seq),
    is_manual: Boolean(r.is_manual),
    locked: Boolean(r.locked),

    service_minutes: Number(r.service_minutes ?? 10),
    service_minutes_override:
      r.service_minutes_override === null || r.service_minutes_override === undefined
        ? null
        : Number(r.service_minutes_override),

    travel_minutes: Number(r.travel_minutes ?? 0),
    source: String(r.source ?? ""),
    clients: r.clients
      ? {
          id: String(r.clients.id),
          name: String(r.clients.name),
          lat: r.clients.lat == null ? null : Number(r.clients.lat),
          lon: r.clients.lon == null ? null : Number(r.clients.lon),
        }
      : null,
  }));
}

// ----- Edge Function direct fetch helpers -----
function getSupabaseEnv() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    (process.env as any).VITE_SUPABASE_URL ||
    "";

  // ✅ supabase-js / apikey 헤더에 들어갈 키 (sb_publishable_... 가능)
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    (process.env as any).VITE_SUPABASE_ANON_KEY ||
    "";

  // ✅ Functions Gateway 통과용 JWT (eyJ...)
  const anonJwt =
    (process.env as any).NEXT_PUBLIC_SUPABASE_ANON_JWT ||
    (process.env as any).VITE_SUPABASE_ANON_JWT ||
    "";

  return { url, anonKey, anonJwt };
}

async function callEdgeFunction<T = any>(fnName: string, body: any): Promise<T> {
  const { url, anonKey, anonJwt } = getSupabaseEnv();
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in env");
  }

  const endpoint = `${url}/functions/v1/${fnName}`;

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers: Record<string, string> = {
    apikey: anonKey,
    "Content-Type": "application/json",
  };

  // ✅ “게이트웨이 통과용 Authorization이 필요한” 함수만 allowlist
  const allowAnonBearer = new Set([
    "kakao-matrix",
    "apply-result",
    "optimize-route",
    "save-optimize-result",
  ]);

  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  } else if (allowAnonBearer.has(fnName)) {
    if (!anonJwt) {
      throw new Error(`Missing NEXT_PUBLIC_SUPABASE_ANON_JWT (JWT needed for ${fnName} without session)`);
    }
    headers.Authorization = `Bearer ${anonJwt}`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Edge ${fnName} failed: status=${res.status} body=${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text as any;
  }
}

// solver 응답에서 방문 순서를 최대한 추출
function extractClientOrder(solved: any, client_ids: string[]) {
  // ✅ (중요) solver.visit_order / solver.order 가 "string[]" 인 케이스를 먼저 잡는다
  const directKeys = [
    "visit_order", // <- string[]
    "order", // <- string[] (ORI1 포함/왕복 포함일 수 있음)
    "client_order",
    "clients",
    "order_client_ids",
    "route_client_ids",
    "best_route_client_ids",
  ];

  for (const k of directKeys) {
    const v = solved?.[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  }

  const indexKeys = ["route", "best_route", "sequence"]; // <- number[] 인덱스 케이스만 남김
  for (const k of indexKeys) {
    const v = solved?.[k];
    if (Array.isArray(v) && v.every((x) => Number.isInteger(x))) {
      return (v as number[]).map((i) => client_ids[i]).filter(Boolean);
    }
  }

  const nested = solved?.solution ?? solved?.data ?? solved?.result;
  if (nested) return extractClientOrder(nested, client_ids);

  return client_ids;
}

export default function DailyPage() {
  const today = useMemo(() => new Date(), []);
  const [weekStart, setWeekStart] = useState<string>(() => getWeekStartMonday(today));
  const [dow, setDow] = useState<number>(() => getIsoDow(today));
  const [dayStartTime, setDayStartTime] = useState("09:00");

  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // ORI1 좌표 (로컬 저장)
  const [homeLat, setHomeLat] = useState<number>(() => {
    const v = typeof window !== "undefined" ? localStorage.getItem("HOME_LAT") : null;
    return v ? Number(v) : 37.5665;
  });
  const [homeLng, setHomeLng] = useState<number>(() => {
    const v = typeof window !== "undefined" ? localStorage.getItem("HOME_LNG") : null;
    return v ? Number(v) : 126.978;
  });

  useEffect(() => {
    try {
      localStorage.setItem("HOME_LAT", String(homeLat));
      localStorage.setItem("HOME_LNG", String(homeLng));
    } catch {}
  }, [homeLat, homeLng]);

  // PREVIEW 상태
  const [optMode, setOptMode] = useState<"LIVE" | "PREVIEW">("LIVE");
  const [resultId, setResultId] = useState<string>("");
  const [previewClientOrder, setPreviewClientOrder] = useState<string[]>([]);

  // ✅ optimize-route에서 받은 matrix/client_ids를 PREVIEW 표시용으로 저장
  const [previewMatrix, setPreviewMatrix] = useState<number[][] | null>(null);
  const [previewAllClientIds, setPreviewAllClientIds] = useState<string[] | null>(null);

  const effectiveServiceMinutes = (r: DailyRow) =>
    Number.isFinite(r.service_minutes_override as number)
      ? Number(r.service_minutes_override)
      : Number(r.service_minutes ?? 0);

  const fetchDaily = async () => {
    setLoading(true);
    setErr(null);

    const { data, error } = await supabase
      .from("daily_plan_items")
      .select(
        `
        id,
        week_start,
        day_of_week,
        plan_date,
        client_id,
        seq,
        is_manual,
        locked,
        service_minutes,
        service_minutes_override,
        travel_minutes,
        source,
        clients:clients(id,name,lat,lon)
      `
      )
      .eq("week_start", weekStart)
      .eq("day_of_week", dow)
      .order("seq", { ascending: true });

    if (error) {
      setErr(error.message);
      setRows([]);
    } else {
      setRows(normalizeDailyRows(data));
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchDaily();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, dow]);

  const planDate = useMemo(() => planDateFromWeekStart(weekStart, dow), [weekStart, dow]);
  const liveList = useMemo(() => [...rows].sort((a, b) => a.seq - b.seq), [rows]);

  // PREVIEW일 때는 previewClientOrder 기준으로 재정렬 (표시용)
  const listForDisplay = useMemo(() => {
    if (optMode !== "PREVIEW" || previewClientOrder.length === 0) return liveList;

    const byClient = new Map<string, DailyRow[]>();
    for (const r of liveList) {
      const arr = byClient.get(r.client_id) ?? [];
      arr.push(r);
      byClient.set(r.client_id, arr);
    }

    const ordered: DailyRow[] = [];
    for (const cid of previewClientOrder) {
      const arr = byClient.get(cid);
      if (arr && arr.length > 0) ordered.push(arr.shift()!);
    }
    for (const rest of byClient.values()) for (const r of rest) ordered.push(r);

    return ordered.map((r, i) => ({ ...r, seq: i + 1 }));
  }, [liveList, optMode, previewClientOrder]);

  // ✅ PREVIEW travel 계산: ORI1 -> 첫 방문지 -> ... (matrix 기반)
  const previewTravelByClient = useMemo(() => {
    if (optMode !== "PREVIEW") return new Map<string, number>();
    if (!previewMatrix || !previewAllClientIds) return new Map<string, number>();

    const idxById = new Map<string, number>();
    previewAllClientIds.forEach((id, i) => idxById.set(id, i));

    const route = [ORIGIN_ID, ...previewClientOrder];
    const m = new Map<string, number>();

    for (let k = 0; k < route.length; k++) {
      const cur = route[k];
      if (cur === ORIGIN_ID) continue;

      const prev = route[k - 1];
      const iPrev = idxById.get(prev);
      const iCur = idxById.get(cur);

      const t =
        iPrev != null && iCur != null && previewMatrix?.[iPrev]?.[iCur] != null
          ? Number(previewMatrix[iPrev][iCur])
          : 0;

      m.set(cur, Number.isFinite(t) ? t : 0);
    }
    return m;
  }, [optMode, previewMatrix, previewAllClientIds, previewClientOrder]);

  // arrive/depart 계산(프론트 표시용)
  const computed = useMemo(() => {
    let cur = timeToMinutes(dayStartTime);

    return listForDisplay.map((r, idx) => {
      // ✅ LIVE: DB travel_minutes 사용
      // ✅ PREVIEW: matrix 기반 travel 사용
      const travel =
        optMode === "PREVIEW"
          ? Number(previewTravelByClient.get(r.client_id) ?? 0)
          : Number(r.travel_minutes ?? 0);

      const arrive = cur + (idx === 0 ? 0 : travel);
      const depart = arrive + effectiveServiceMinutes(r);
      cur = depart;

      return {
        ...r,
        _travel: travel,
        _arriveHHMM: minutesToHHMM(arrive),
        _departHHMM: minutesToHHMM(depart),
        _effective_service_minutes: effectiveServiceMinutes(r),
      };
    });
  }, [listForDisplay, dayStartTime, optMode, previewTravelByClient]);

  // Copy from Weekly
  const copyFromWeekly = async () => {
    setErr(null);
    setLoading(true);

    const { error } = await supabase.rpc("copy_weekly_to_daily", {
      p_week_start: weekStart,
      p_day_of_week: dow,
      p_departure_time: `${dayStartTime}:00`,
    });

    if (error) {
      setErr(error.message);
      setLoading(false);
      return;
    }

    setOptMode("LIVE");
    setResultId("");
    setPreviewClientOrder([]);
    setPreviewMatrix(null);
    setPreviewAllClientIds(null);

    await fetchDaily();
  };

  // -------- LIVE 편집 기능 --------
  const toggleLocked = async (r: DailyRow, next: boolean) => {
    if (optMode === "PREVIEW") {
      setErr("PREVIEW 상태에선 수정 금지. Back to LIVE 후 수정하세요.");
      return;
    }

    setErr(null);
    setLoading(true);

    try {
      const { error } = await supabase
        .from("daily_plan_items")
        .update({ locked: next, is_manual: true, source: "MANUAL" })
        .eq("id", r.id)
        .eq("week_start", r.week_start)
        .eq("day_of_week", r.day_of_week);

      if (error) throw new Error(error.message);
      await fetchDaily();
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const updateServiceMinutes = async (r: DailyRow, next: number) => {
    if (optMode === "PREVIEW") {
      setErr("PREVIEW 상태에선 수정 금지. Back to LIVE 후 수정하세요.");
      return;
    }

    setErr(null);
    setLoading(true);

    try {
      const safe = Number.isFinite(next)
        ? Math.max(0, Math.min(999, Math.floor(next)))
        : effectiveServiceMinutes(r);

      const { error } = await supabase
        .from("daily_plan_items")
        .update({ service_minutes_override: safe, is_manual: true, source: "MANUAL" })
        .eq("id", r.id)
        .eq("week_start", r.week_start)
        .eq("day_of_week", r.day_of_week);

      if (error) throw new Error(error.message);
      await fetchDaily();
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const swapSeq_Rpc = async (a: DailyRow, b: DailyRow) => {
    if (a.week_start !== b.week_start || a.day_of_week !== b.day_of_week) {
      throw new Error("Swap 대상이 같은 week/day가 아닙니다.");
    }
    if (a.locked) throw new Error("locked 항목은 이동할 수 없습니다.");

    const { error } = await supabase.rpc("swap_daily_seq", {
      p_id_a: a.id,
      p_id_b: b.id,
      p_week_start: a.week_start,
      p_day_of_week: a.day_of_week,
    });

    if (error) throw new Error(error.message);
  };

  const moveRow = async (r: DailyRow, dir: "up" | "down") => {
    if (optMode === "PREVIEW") {
      setErr("PREVIEW 상태에선 수동 이동 금지. Back to LIVE 후 이동하세요.");
      return;
    }

    setErr(null);
    setLoading(true);

    try {
      const sorted = [...liveList].sort((x, y) => x.seq - y.seq);
      const idx = sorted.findIndex((x) => x.id === r.id);
      if (idx < 0) return;

      const swapWith = dir === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= sorted.length) return;

      await swapSeq_Rpc(sorted[idx], sorted[swapWith]);
      await fetchDaily();
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // ✅ Kakao Map: 좌표 우선(정확), 없으면 q 검색으로 fallback
  const openKakaoMap = (name: string, lat?: number | null, lon?: number | null) => {
    if (typeof lat === "number" && Number.isFinite(lat) && typeof lon === "number" && Number.isFinite(lon)) {
      const url = `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lon}`;
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const url = `https://map.kakao.com/?q=${encodeURIComponent(name)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // Optimize: optimize-route → save-optimize-result → PREVIEW
  const optimize = async () => {
    setErr(null);
    setLoading(true);

    try {
      if (liveList.length < 2) throw new Error("최소 2개 이상 필요");

      // 1) stops 만들기: ORI1 + clients
      const stops: Stop[] = [];

      stops.push({
        id: ORIGIN_ID,
        lat: homeLat,
        lng: homeLng,
        service_minutes: 0,
        priority: false,
        locked: true,
        seq: 0,
      });

      for (const r of liveList) {
        const lat = r.clients?.lat;
        const lon = r.clients?.lon;

        if (typeof lat !== "number" || !Number.isFinite(lat)) {
          throw new Error(`Missing clients.lat for client_id=${r.client_id} (clients 테이블에 lat 필요)`);
        }
        if (typeof lon !== "number" || !Number.isFinite(lon)) {
          throw new Error(`Missing clients.lon for client_id=${r.client_id} (clients 테이블에 lon 필요)`);
        }

        const effService =
          Number.isFinite(r.service_minutes_override as number)
            ? Number(r.service_minutes_override)
            : Number(r.service_minutes ?? 0);

        stops.push({
          id: r.client_id,
          lat,
          lng: lon,
          service_minutes: effService,
          priority: false,
          locked: Boolean(r.locked),
          seq: r.locked ? r.seq : null,
        });
      }

      // 2) optimize-route 호출
      const departAt = `${planDate}T${dayStartTime}:00`;
      const opt: any = await callEdgeFunction("optimize-route", {
        plan_date: planDate,
        stops,
        departAt,
        time_limit_seconds: 3,
      });

      // ✅ 너가 원한 디버그 로그 “여기”가 정답 위치
      console.log("opt.ok", opt?.ok);
      console.log("client_ids", opt?.client_ids);
      console.log("matrix row0", opt?.matrix_minutes?.[0]);
      console.log("solver", opt?.solver);

      if (!opt?.ok) throw new Error(opt?.error ? JSON.stringify(opt.error) : "optimize-route failed");

      const client_ids: string[] = opt.client_ids; // ORI1 포함
      const solved = opt.solver;

      if (!Array.isArray(client_ids) || client_ids.length !== stops.length) {
        throw new Error("optimize-route: invalid client_ids returned");
      }

      // ✅ PREVIEW 표시용으로 matrix/client_ids 저장
      if (Array.isArray(opt.matrix_minutes)) setPreviewMatrix(opt.matrix_minutes);
      setPreviewAllClientIds(client_ids);

      // 3) solver 결과에서 순서 추출
      let order = extractClientOrder(solved, client_ids);

      // ✅ ORI1 제거
      order = order.filter((x) => x !== ORIGIN_ID);
      if (order.length < 2) order = client_ids.filter((x) => x !== ORIGIN_ID);

      // 4) optimize_results에 저장 → result_id 받기
      const saved = await callEdgeFunction<SaveOptimizeResp>("save-optimize-result", {
        plan_date: planDate,
        clients: order,
        input_payload: { stops, departAt },
        meta: { source: "optimize-route", solver_meta: solved?.meta ?? null },
      });

      if (!saved?.ok) throw new Error(saved?.error ? JSON.stringify(saved.error) : "save-optimize-result failed");

      const rid = String(saved.result_id ?? "");
      if (!rid) throw new Error("save-optimize-result: missing result_id");

      setResultId(rid);
      setPreviewClientOrder(order);
      setOptMode("PREVIEW");
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // Apply: apply-result로 daily_plan_items 반영
  const apply = async () => {
    setErr(null);
    setLoading(true);

    try {
      if (!resultId) throw new Error("missing result_id. Click Optimize first.");

      const departAt = `${planDate}T${dayStartTime}:00`;
      const applied = await callEdgeFunction<ApplyEdgeResp>("apply-result", {
        plan_date: planDate,
        result_id: resultId,
        departAt,
        origin_id: ORIGIN_ID,
      });

      if (!applied?.ok) throw new Error(applied?.error ? JSON.stringify(applied.error) : "apply-result failed");

      // ✅ LIVE로 돌아갈 땐 preview matrix도 비움
      setOptMode("LIVE");
      setResultId("");
      setPreviewClientOrder([]);
      setPreviewMatrix(null);
      setPreviewAllClientIds(null);

      await fetchDaily();
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const backToLive = async () => {
    setErr(null);
    setLoading(true);
    try {
      setOptMode("LIVE");
      setResultId("");
      setPreviewClientOrder([]);
      setPreviewMatrix(null);
      setPreviewAllClientIds(null);
      await fetchDaily();
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: 32, fontWeight: 800 }}>데일리 플랜</h1>

      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontWeight: 700 }}>주 시작일</label>
        <input
          type="date"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          style={{ padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
        />

        <label style={{ fontWeight: 700 }}>요일</label>
        <select
          value={dow}
          onChange={(e) => setDow(Number(e.target.value))}
          style={{ padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <option key={d} value={d}>
              {DOW_LABEL[d]}
            </option>
          ))}
        </select>

        <label style={{ fontWeight: 700 }}>시작시간</label>
        <input
          type="time"
          value={dayStartTime}
          onChange={(e) => setDayStartTime(e.target.value)}
          style={{ padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
        />

        <button
          onClick={copyFromWeekly}
          disabled={loading}
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
        >
          주 계획에서 가져오기
        </button>

        <button
          onClick={optimize}
          disabled={loading || liveList.length < 2}
          title={liveList.length < 2 ? "최소 2개 이상 필요" : "optimize-route → preview 생성"}
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
        >
          최적화
        </button>

        {optMode === "PREVIEW" && (
          <>
            <button
              onClick={apply}
              disabled={loading || !resultId}
              title="DB에 확정 반영"
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Apply
            </button>

            <button
              onClick={backToLive}
              disabled={loading}
              title="미리보기 취소"
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Back to LIVE
            </button>

            <span
              style={{
                padding: "4px 10px",
                border: "1px solid #f0c36d",
                borderRadius: 999,
                fontSize: 12,
                background: "#fff3cd",
              }}
              title="Optimize는 생성만 했고 아직 DB에 반영 안 됨"
            >
              PREVIEW (not applied)
            </span>

            <span style={{ fontSize: 12, opacity: 0.7 }}>result_id: {resultId}</span>
          </>
        )}

        <a href="/weekly" style={{ marginLeft: "auto", textDecoration: "underline" }}>
          ← Weekly로
        </a>
      </div>

      {loading && <p style={{ marginTop: 16 }}>Loading…</p>}
      {err && <p style={{ marginTop: 16, color: "crimson", whiteSpace: "pre-wrap" }}>Error: {err}</p>}

      {!loading && !err && (
        <section style={{ marginTop: 20, border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800 }}>
            {DOW_LABEL[dow]} ({computed.length}) {optMode === "PREVIEW" ? "— PREVIEW" : ""}
          </h2>

          {computed.length === 0 ? (
            <p style={{ marginTop: 8, opacity: 0.6 }}>비어있음 (Copy from Weekly 눌러봐)</p>
          ) : (
            <table style={{ width: "100%", marginTop: 10, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
                  <th style={{ padding: "8px 0", width: 90 }}>이동</th>
                  <th style={{ padding: "8px 0", width: 60 }}>순서</th>
                  <th style={{ padding: "8px 0" }}>고객</th>
                  <th style={{ padding: "8px 0", width: 90 }}>고정</th>
                  <th style={{ padding: "8px 0", width: 140 }}>청소시간(분)</th>
                  <th style={{ padding: "8px 0", width: 120 }}>이동시간(분)</th>
                  <th style={{ padding: "8px 0", width: 90 }}>도착시간</th>
                  <th style={{ padding: "8px 0", width: 90 }}>출발시간</th>
                  <th style={{ padding: "8px 0", width: 130 }}>네비 연결</th>
                </tr>
              </thead>

              <tbody>
                {computed.map((r: any, i) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #f3f3f3" }}>
                    <td style={{ padding: "10px 0" }}>
                      <button
                        onClick={() => moveRow(r, "up")}
                        disabled={optMode === "PREVIEW" || i === 0 || r.locked}
                        style={{
                          marginRight: 6,
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          cursor: optMode === "PREVIEW" || i === 0 || r.locked ? "not-allowed" : "pointer",
                          opacity: optMode === "PREVIEW" || i === 0 || r.locked ? 0.4 : 1,
                        }}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveRow(r, "down")}
                        disabled={optMode === "PREVIEW" || i === computed.length - 1 || r.locked}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          cursor:
                            optMode === "PREVIEW" || i === computed.length - 1 || r.locked
                              ? "not-allowed"
                              : "pointer",
                          opacity: optMode === "PREVIEW" || i === computed.length - 1 || r.locked ? 0.4 : 1,
                        }}
                      >
                        ↓
                      </button>
                    </td>

                    <td style={{ padding: "10px 0" }}>{r.seq}</td>

                    <td style={{ padding: "10px 0", fontWeight: 700 }}>{r.clients?.name ?? ""}</td>

                    <td style={{ padding: "10px 0" }}>
                      <input
                        type="checkbox"
                        checked={r.locked}
                        disabled={optMode === "PREVIEW"}
                        onChange={(e) => toggleLocked(r, e.target.checked)}
                      />
                    </td>

                    <td style={{ padding: "10px 0" }}>
                      <input
                        type="number"
                        min={0}
                        max={999}
                        step={1}
                        value={r._effective_service_minutes}
                        disabled={optMode === "PREVIEW"}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setRows((prev) =>
                            prev.map((x) =>
                              x.id === r.id
                                ? { ...x, service_minutes_override: Number.isFinite(v) ? v : x.service_minutes_override }
                                : x
                            )
                          );
                        }}
                        onBlur={(e) => updateServiceMinutes(r, Number(e.target.value))}
                        style={{ width: 110, padding: "6px 8px", border: "1px solid #ddd", borderRadius: 8 }}
                      />
                      {r.service_minutes_override !== null && r.service_minutes_override !== undefined && (
                        <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }} title="override 적용 중">
                          (ovr)
                        </span>
                      )}
                    </td>

                    <td style={{ padding: "10px 0" }}>{r._travel ?? 0}m</td>
                    <td style={{ padding: "10px 0" }}>{r._arriveHHMM}</td>
                    <td style={{ padding: "10px 0" }}>{r._departHHMM}</td>

                    <td style={{ padding: "10px 0" }}>
                      <button
                        onClick={() => openKakaoMap(r.clients?.name ?? r.client_id, r.clients?.lat, r.clients?.lon)}
                        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
                      >
                        Kakao Map
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ marginTop: 12, opacity: 0.75, fontSize: 13 }}>
            * LIVE: travel은 DB(daily_plan_items.travel_minutes) 값
            <br />
            * PREVIEW: travel은 optimize-route의 matrix_minutes 기반(ORI1→첫 방문지→…)
            <br />
            * arrive/depart는 프론트 계산(서비스/이동시간 기반)
            <br />
            * PREVIEW 모드에서는 수정/이동 금지 / Apply로 확정
          </div>
        </section>
      )}
    </main>
  );
}
