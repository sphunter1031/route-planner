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

  // ✅ CHANGED (NEW): Daily 현장 모달용 필드 추가
  clients?: {
    id: string;
    name: string;
    lat: number | null;
    lon: number | null;
    priority?: boolean | null;

    address_text?: string | null;
    notes?: string | null;
    access_method?: string | null;
    access_code?: string | null;
    manager_name?: string | null;
    manager_phone?: string | null;
    parking_info?: string | null;
  } | null;
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
          priority: r.clients.priority == null ? null : Boolean(r.clients.priority),

          address_text: r.clients.address_text ?? null,
          notes: r.clients.notes ?? null,
          access_method: r.clients.access_method ?? null,
          access_code: r.clients.access_code ?? null,
          manager_name: r.clients.manager_name ?? null,
          manager_phone: r.clients.manager_phone ?? null,
          parking_info: r.clients.parking_info ?? null,
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

  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    (process.env as any).VITE_SUPABASE_ANON_KEY ||
    "";

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
      throw new Error(
        `Missing NEXT_PUBLIC_SUPABASE_ANON_JWT (JWT needed for ${fnName} without session)`
      );
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
  const directKeys = [
    "visit_order",
    "order",
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

  const indexKeys = ["route", "best_route", "sequence"];
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

// ---------- UI helpers ----------
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function pillStyle(bg: string, border: string) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    border: `1px solid ${border}`,
    background: bg,
    lineHeight: "18px",
    whiteSpace: "nowrap" as const,
    color: "#111",
    fontWeight: 700,
  };
}

// ✅ 전화번호 tel 링크
function toTelHref(phone: string) {
  const raw = (phone ?? "").toString().trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\d+]/g, "");
  return cleaned ? `tel:${cleaned}` : "";
}

type ComputedRow = DailyRow & {
  _travel: number;
  _arriveHHMM: string;
  _departHHMM: string;
  _effective_service_minutes: number;
};

type SharedHandlers = {
  optMode: "LIVE" | "PREVIEW";
  moveRow: (r: DailyRow, dir: "up" | "down") => Promise<void>;
  toggleLocked: (r: DailyRow, next: boolean) => Promise<void>;
  updateServiceMinutes: (r: DailyRow, next: number) => Promise<void>;
  openKakaoMap: (name: string, lat?: number | null, lon?: number | null) => void;
  setRows: React.Dispatch<React.SetStateAction<DailyRow[]>>;
  openClientModal: (r: DailyRow) => void;
};

function PcTable({
  rows,
  optMode,
  moveRow,
  toggleLocked,
  updateServiceMinutes,
  openKakaoMap,
  setRows,
  openClientModal,
}: { rows: ComputedRow[] } & SharedHandlers) {
  return (
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
        {rows.map((r, i) => (
          <tr key={r.id} style={{ borderBottom: "1px solid #f3f3f3" }}>
            <td style={{ padding: "10px 0" }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  moveRow(r, "up");
                }}
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
                onClick={(e) => {
                  e.stopPropagation();
                  moveRow(r, "down");
                }}
                disabled={optMode === "PREVIEW" || i === rows.length - 1 || r.locked}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid #ddd",
                  cursor:
                    optMode === "PREVIEW" || i === rows.length - 1 || r.locked
                      ? "not-allowed"
                      : "pointer",
                  opacity: optMode === "PREVIEW" || i === rows.length - 1 || r.locked ? 0.4 : 1,
                }}
              >
                ↓
              </button>
            </td>

            <td style={{ padding: "10px 0" }}>{r.seq}</td>

            <td style={{ padding: "10px 0", fontWeight: 700 }}>
              <span
                onClick={() => openClientModal(r)}
                style={{ cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}
                title="현장 정보 보기"
              >
                {r.clients?.name ?? ""}
              </span>
            </td>

            <td style={{ padding: "10px 0" }}>
              <input
                type="checkbox"
                checked={r.locked}
                disabled={optMode === "PREVIEW"}
                onClick={(e) => e.stopPropagation()}
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
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setRows((prev) =>
                    prev.map((x) =>
                      x.id === r.id
                        ? {
                            ...x,
                            service_minutes_override: Number.isFinite(v)
                              ? v
                              : x.service_minutes_override,
                          }
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
                onClick={(e) => {
                  e.stopPropagation();
                  openKakaoMap(r.clients?.name ?? r.client_id, r.clients?.lat, r.clients?.lon);
                }}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
              >
                Kakao Map
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MobileCards({
  rows,
  optMode,
  moveRow,
  toggleLocked,
  updateServiceMinutes,
  openKakaoMap,
  setRows,
  openClientModal,
}: { rows: ComputedRow[] } & SharedHandlers) {
  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      {rows.map((r, i) => {
        const name = r.clients?.name ?? r.client_id;
        const locked = r.locked;

        return (
          <div
            key={r.id}
            onClick={() => openClientModal(r)}
            style={{
              border: "1px solid #eee",
              borderRadius: 14,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              cursor: "pointer",
            }}
          >
            {/* header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 900, fontSize: 16 }}>
                    {i + 1}. {name}
                  </span>
                  {locked ? <span style={pillStyle("#f2f2f2", "#ddd")}>고정</span> : null}
                  {optMode === "PREVIEW" ? <span style={pillStyle("#fff3cd", "#f0c36d")}>PREVIEW</span> : null}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 13, opacity: 0.9 }}>
                  <span style={pillStyle("#f7f7ff", "#dfe3ff")}>도착 {r._arriveHHMM}</span>
                  <span style={pillStyle("#f7fff7", "#d9f2d9")}>출발 {r._departHHMM}</span>
                  <span style={pillStyle("#f7f7f7", "#e6e6e6")}>이동 {r._travel ?? 0}m</span>
                </div>
              </div>

              {/* nav */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openKakaoMap(name, r.clients?.lat, r.clients?.lon);
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                  fontSize: 14,
                  lineHeight: "14px",
                  minWidth: 64,
                  textAlign: "center",
                }}
              >
                카카오
              </button>
            </div>

            {/* controls */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  moveRow(r, "up");
                }}
                disabled={optMode === "PREVIEW" || i === 0 || locked}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: optMode === "PREVIEW" || i === 0 || locked ? "not-allowed" : "pointer",
                  opacity: optMode === "PREVIEW" || i === 0 || locked ? 0.4 : 1,
                  fontWeight: 800,
                }}
              >
                ↑ 위
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  moveRow(r, "down");
                }}
                disabled={optMode === "PREVIEW" || i === rows.length - 1 || locked}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: optMode === "PREVIEW" || i === rows.length - 1 || locked ? "not-allowed" : "pointer",
                  opacity: optMode === "PREVIEW" || i === rows.length - 1 || locked ? 0.4 : 1,
                  fontWeight: 800,
                }}
              >
                ↓ 아래
              </button>

              <label
                style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}
                onClick={(e) => e.stopPropagation()}
              >
                <span style={{ fontWeight: 800 }}>고정</span>
                <input
                  type="checkbox"
                  checked={locked}
                  disabled={optMode === "PREVIEW"}
                  onChange={(e) => toggleLocked(r, e.target.checked)}
                  style={{ width: 18, height: 18 }}
                />
              </label>
            </div>

            {/* service minutes */}
            <div
              style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
              onClick={(e) => e.stopPropagation()}
            >
              <span style={{ fontWeight: 800 }}>청소시간(분)</span>
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
                        ? {
                            ...x,
                            service_minutes_override: Number.isFinite(v)
                              ? v
                              : x.service_minutes_override,
                          }
                        : x
                    )
                  );
                }}
                onBlur={(e) => updateServiceMinutes(r, Number(e.target.value))}
                style={{
                  width: 120,
                  padding: "10px 10px",
                  border: "1px solid #ddd",
                  borderRadius: 12,
                  fontSize: 16,
                }}
              />
              {r.service_minutes_override !== null && r.service_minutes_override !== undefined ? (
                <span style={{ fontSize: 12, opacity: 0.7 }}>(ovr)</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function DailyPage() {
  const today = useMemo(() => new Date(), []);

  // ✅ 상태 유지(LocalStorage) 키
  const LS_WEEK_START = "DAILY_WEEK_START";
  const LS_DOW = "DAILY_DOW";
  const LS_START_TIME = "DAILY_START_TIME";
  const LS_APPLIED_PREFIX = "DAILY_APPLIED_OPTIMIZED:"; // + `${weekStart}:${dow}`

  const [weekStart, setWeekStart] = useState<string>(() => {
    if (typeof window === "undefined") return getWeekStartMonday(today);
    const v = localStorage.getItem(LS_WEEK_START);
    return v && v.trim() ? v : getWeekStartMonday(today);
  });
  const [dow, setDow] = useState<number>(() => {
    if (typeof window === "undefined") return getIsoDow(today);
    const v = localStorage.getItem(LS_DOW);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : getIsoDow(today);
  });
  const [dayStartTime, setDayStartTime] = useState(() => {
    if (typeof window === "undefined") return "09:00";
    const v = localStorage.getItem(LS_START_TIME);
    if (v && /^\d{2}:\d{2}$/.test(v)) return v;
    return "09:00";
  });

  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // ✅ 모바일/PC 분기
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 768);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // ✅ 현장 모달 상태/메모 편집 상태
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [clientModalRow, setClientModalRow] = useState<DailyRow | null>(null);

  const [noteEditMode, setNoteEditMode] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [noteSaving, setNoteSaving] = useState(false);

  function openClientModal(r: DailyRow) {
    setClientModalRow(r);
    setClientModalOpen(true);
    setNoteEditMode(false);
    setNoteDraft(r.clients?.notes ?? "");
  }

  function closeClientModal() {
    if (noteSaving) return;
    setClientModalOpen(false);
    setClientModalRow(null);
    setNoteEditMode(false);
    setNoteDraft("");
  }

  // ✅ FIX: 모달 열리면 body 스크롤/터치 잠금 (iOS 뒤 UI 비침/스크롤 방지)
  useEffect(() => {
    if (!clientModalOpen) return;

    const prevOverflow = document.body.style.overflow;
    const prevTouchAction = (document.body.style as any).touchAction;

    document.body.style.overflow = "hidden";
    (document.body.style as any).touchAction = "none";

    return () => {
      document.body.style.overflow = prevOverflow;
      (document.body.style as any).touchAction = prevTouchAction;
    };
  }, [clientModalOpen]);

  async function saveClientNotes() {
    const clientId = clientModalRow?.clients?.id;
    if (!clientId) return;

    setNoteSaving(true);
    setErr(null);

    try {
      const payload = { notes: noteDraft && noteDraft.trim() ? noteDraft : null };

      const { error } = await supabase.from("clients").update(payload).eq("id", clientId);
      if (error) throw new Error(error.message);

      // 로컬 state 즉시 반영 (모달 + 리스트)
      setRows((prev) =>
        prev.map((x) =>
          x.client_id === clientId
            ? {
                ...x,
                clients: x.clients ? { ...x.clients, notes: payload.notes as any } : x.clients,
              }
            : x
        )
      );

      setClientModalRow((prev) =>
        prev
          ? {
              ...prev,
              clients: prev.clients ? { ...prev.clients, notes: payload.notes as any } : prev.clients,
            }
          : prev
      );

      setNoteEditMode(false);
    } catch (e: any) {
      alert("메모 저장 실패: " + (e?.message ?? "Unknown error"));
    } finally {
      setNoteSaving(false);
    }
  }

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

  // optimize-route에서 받은 matrix/client_ids를 PREVIEW 표시용으로 저장
  const [previewMatrix, setPreviewMatrix] = useState<number[][] | null>(null);
  const [previewAllClientIds, setPreviewAllClientIds] = useState<string[] | null>(null);

  // ✅ APPLY 완료 표시/버튼 제어
  const [appliedOptimized, setAppliedOptimized] = useState<boolean>(false);

  // week/dow/time 변경 시 LocalStorage 저장 + applied flag 로딩
  useEffect(() => {
    try {
      localStorage.setItem(LS_WEEK_START, weekStart);
      localStorage.setItem(LS_DOW, String(dow));
      localStorage.setItem(LS_START_TIME, dayStartTime);

      const key = `${LS_APPLIED_PREFIX}${weekStart}:${dow}`;
      const v = localStorage.getItem(key);
      setAppliedOptimized(v === "1");
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, dow, dayStartTime]);

  const markAppliedOptimized = (next: boolean) => {
    setAppliedOptimized(next);
    try {
      const key = `${LS_APPLIED_PREFIX}${weekStart}:${dow}`;
      localStorage.setItem(key, next ? "1" : "0");
    } catch {}
  };

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
        clients:clients(
          id,
          name,
          lat,
          lon,
          priority,
          address_text,
          notes,
          access_method,
          access_code,
          manager_name,
          manager_phone,
          parking_info
        )
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

  // PREVIEW travel 계산: ORI1 -> 첫 방문지 -> ...
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
      } as ComputedRow;
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

    markAppliedOptimized(false);

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

      markAppliedOptimized(false);
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

      markAppliedOptimized(false);
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

      markAppliedOptimized(false);
      await fetchDaily();
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // ✅ Kakao Map - 모바일에서는 앱 스킴 우선 시도 후 fallback
  const openKakaoMap = (name: string, lat?: number | null, lon?: number | null) => {
    const isMobileUA =
      typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (isFiniteNumber(lat) && isFiniteNumber(lon)) {
      if (isMobileUA) {
        const scheme = `kakaomap://look?p=${lat},${lon}`;
        const web = `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lon}`;

        window.location.href = scheme;

        window.setTimeout(() => {
          window.open(web, "_blank", "noopener,noreferrer");
        }, 700);
        return;
      }

      const url = `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lon}`;
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    const web = `https://map.kakao.com/?q=${encodeURIComponent(name)}`;
    window.open(web, "_blank", "noopener,noreferrer");
  };

  // Optimize: optimize-route → save-optimize-result → PREVIEW
  const optimize = async () => {
    setErr(null);
    setLoading(true);

    try {
      if (liveList.length < 2) throw new Error("최소 2개 이상 필요");

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

        if (!isFiniteNumber(lat)) {
          throw new Error(`Missing clients.lat for client_id=${r.client_id} (clients 테이블에 lat 필요)`);
        }
        if (!isFiniteNumber(lon)) {
          throw new Error(`Missing clients.lon for client_id=${r.client_id} (clients 테이블에 lon 필요)`);
        }

        const effService =
          Number.isFinite(r.service_minutes_override as number)
            ? Number(r.service_minutes_override)
            : Number(r.service_minutes ?? 0);

        const prio = Boolean(r.clients?.priority);

        stops.push({
          id: r.client_id,
          lat,
          lng: lon,
          service_minutes: effService,
          priority: prio,
          locked: Boolean(r.locked),
          seq: r.locked ? r.seq : null,
        });
      }

      const departAt = `${planDate}T${dayStartTime}:00`;
      const opt: any = await callEdgeFunction("optimize-route", {
        plan_date: planDate,
        stops,
        departAt,
        time_limit_seconds: 3,
      });

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

      if (Array.isArray(opt.matrix_minutes)) setPreviewMatrix(opt.matrix_minutes);
      setPreviewAllClientIds(client_ids);

      let order = extractClientOrder(solved, client_ids);

      order = order.filter((x) => x !== ORIGIN_ID);
      if (order.length < 2) order = client_ids.filter((x) => x !== ORIGIN_ID);

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

  // Apply
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

      setOptMode("LIVE");
      setResultId("");
      setPreviewClientOrder([]);
      setPreviewMatrix(null);
      setPreviewAllClientIds(null);

      markAppliedOptimized(true);

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

  // 모달 렌더링용 값
  const modalClient = clientModalRow?.clients ?? null;
  const modalName = modalClient?.name ?? "";
  const modalAddress = modalClient?.address_text ?? "";
  const vOrDash = (v: any) => {
    const s = (v ?? "").toString();
    return s.trim() ? s : "-";
  };

  // ✅ B 로직: Optimize 버튼 표시 조건
  const showOptimizeButton = optMode === "LIVE" && !appliedOptimized;

  return (
    <main style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: isMobile ? 26 : 32, fontWeight: 800 }}>데일리 플랜</h1>

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

        {showOptimizeButton && (
          <button
            onClick={optimize}
            disabled={loading || liveList.length < 2}
            title={liveList.length < 2 ? "최소 2개 이상 필요" : "optimize-route → preview 생성"}
            style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
          >
            최적화
          </button>
        )}

        {optMode === "LIVE" && appliedOptimized && (
          <span style={pillStyle("#f7fff7", "#d9f2d9")} title="Apply 완료. 수동 수정하면 다시 최적화 가능">
            최적화 적용됨
          </span>
        )}

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

            <span style={pillStyle("#fff3cd", "#f0c36d")} title="Optimize는 생성만 했고 아직 DB에 반영 안 됨">
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
          ) : isMobile ? (
            <MobileCards
              rows={computed}
              optMode={optMode}
              moveRow={moveRow}
              toggleLocked={toggleLocked}
              updateServiceMinutes={updateServiceMinutes}
              openKakaoMap={openKakaoMap}
              setRows={setRows}
              openClientModal={openClientModal}
            />
          ) : (
            <PcTable
              rows={computed}
              optMode={optMode}
              moveRow={moveRow}
              toggleLocked={toggleLocked}
              updateServiceMinutes={updateServiceMinutes}
              openKakaoMap={openKakaoMap}
              setRows={setRows}
              openClientModal={openClientModal}
            />
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

      {/* ✅ FIXED: 현장 정보 모달 (배경만 어둡게 + iOS/모바일 비침/흐림 방지) */}
      {clientModalOpen && modalClient && (
        <div
          onClick={closeClientModal}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.55)",
            zIndex: 2147483647,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            overscrollBehavior: "contain",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{
              width: "min(680px, 100%)",
              maxHeight: "85vh",
              overflow: "auto",
              backgroundColor: "#fff",
              borderRadius: 16,
              padding: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
              position: "relative",
              opacity: 1,
              isolation: "isolate",
              wordBreak: "keep-all",
            }}
          >
            <button
              onClick={closeClientModal}
              aria-label="close"
              style={{
                position: "absolute",
                right: 10,
                top: 10,
                border: "none",
                background: "transparent",
                fontSize: 22,
                cursor: noteSaving ? "not-allowed" : "pointer",
                padding: 6,
                lineHeight: "22px",
                color: "#111",
              }}
              disabled={noteSaving}
            >
              ✕
            </button>

            {/* Header */}
            <div style={{ paddingRight: 32 }}>
              <div style={{ fontSize: 22, fontWeight: 900, lineHeight: "28px", color: "#111" }}>
                {modalName}
              </div>

              {modalAddress ? (
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 14,
                    lineHeight: "20px",
                    color: "#444",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {modalAddress}
                </div>
              ) : null}
            </div>

            {/* Info blocks */}
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {([
                ["출입방법", modalClient.access_method],
                ["비번/열쇠위치", modalClient.access_code],
                ["책임자", modalClient.manager_name],
                ["전화번호", modalClient.manager_phone],
                ["주차정보", modalClient.parking_info],
              ] as const).map(([label, value]) => {
                const isPhone = label === "전화번호";
                const phone = (value ?? "").toString().trim();
                const telHref = isPhone ? toTelHref(phone) : "";

                return (
                  <div
                    key={label}
                    style={{
                      border: "1px solid #eee",
                      borderRadius: 14,
                      padding: 12,
                      backgroundColor: "#fff",
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 6, color: "#111" }}>
                      {label}
                    </div>

                    {isPhone ? (
                      <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                        <div style={{ fontSize: 16, lineHeight: "22px", whiteSpace: "pre-wrap", color: "#111", flex: "1 1 auto" }}>
                          {vOrDash(value)}
                        </div>

                        {telHref ? (
                          <a
                            href={telHref}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              flex: "0 0 auto",
                              padding: "10px 14px",
                              borderRadius: 12,
                              border: "1px solid #111",
                              backgroundColor: "#111",
                              color: "#fff",
                              fontWeight: 900,
                              textDecoration: "none",
                              whiteSpace: "nowrap",
                              fontSize: 15,
                              lineHeight: "15px",
                            }}
                          >
                            전화걸기
                          </a>
                        ) : null}
                      </div>
                    ) : (
                      <div style={{ fontSize: 16, lineHeight: "22px", whiteSpace: "pre-wrap", color: "#111" }}>
                        {vOrDash(value)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Notes */}
            <div style={{ marginTop: 14, borderTop: "1px solid #eee", paddingTop: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 8, color: "#111" }}>메모</div>

              {!noteEditMode ? (
                <div
                  style={{
                    border: "1px solid #eee",
                    borderRadius: 14,
                    padding: 12,
                    fontSize: 16,
                    lineHeight: "22px",
                    whiteSpace: "pre-wrap",
                    backgroundColor: "#fafafa",
                    color: "#111",
                  }}
                >
                  {vOrDash(modalClient.notes)}
                </div>
              ) : (
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="메모를 입력하세요"
                  style={{
                    width: "100%",
                    minHeight: 140,
                    padding: 12,
                    border: "1px solid #ddd",
                    borderRadius: 14,
                    fontSize: 16,
                    lineHeight: "22px",
                    outline: "none",
                    resize: "vertical",
                    color: "#111",
                    backgroundColor: "#fff",
                  }}
                />
              )}

              <div style={{ marginTop: 12, display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                {!noteEditMode ? (
                  <button
                    onClick={() => setNoteEditMode(true)}
                    style={{
                      padding: "12px 14px",
                      borderRadius: 14,
                      border: "1px solid #111",
                      backgroundColor: "#111",
                      color: "#fff",
                      fontWeight: 900,
                      cursor: "pointer",
                      fontSize: 16,
                    }}
                  >
                    메모 수정
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setNoteEditMode(false);
                        setNoteDraft(modalClient.notes ?? "");
                      }}
                      disabled={noteSaving}
                      style={{
                        padding: "12px 14px",
                        borderRadius: 14,
                        border: "1px solid #ddd",
                        backgroundColor: "#fff",
                        fontWeight: 900,
                        cursor: noteSaving ? "not-allowed" : "pointer",
                        fontSize: 16,
                        opacity: noteSaving ? 0.6 : 1,
                        color: "#111",
                      }}
                    >
                      취소
                    </button>

                    <button
                      onClick={saveClientNotes}
                      disabled={noteSaving}
                      style={{
                        padding: "12px 14px",
                        borderRadius: 14,
                        border: "1px solid #111",
                        backgroundColor: "#111",
                        color: "#fff",
                        fontWeight: 900,
                        cursor: noteSaving ? "not-allowed" : "pointer",
                        fontSize: 16,
                        opacity: noteSaving ? 0.6 : 1,
                      }}
                    >
                      {noteSaving ? "저장중..." : "저장"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}