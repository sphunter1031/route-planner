"use client";

import { useEffect, useMemo, useState } from "react";

type Row = {
  id: string;
  plan_date: string;
  week_start?: string;
  client_id: string;
  seq: number;
  locked: boolean;
  is_manual: boolean;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function fnUrl(name: string) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

async function postFn<T>(name: string, body: any): Promise<T> {
  const res = await fetch(fnUrl(name), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

async function fetchDailyPlan(planDate: string): Promise<Row[]> {
  // Supabase REST를 직접 때리기보단, 너는 이미 DB select를 프론트에서 하던 흐름이 있을 것.
  // 여기선 "빠른 테스트" 위해 Edge Function 없이 REST로 가져오는 버전은 생략하고,
  // 너 프로젝트에 이미 있는 supabase client select로 바꾸는 걸 추천.
  //
  // 임시로는 apply/reset 후 응답(rows)을 그대로 사용하면 됨.
  return [];
}

export default function PlannerControls() {
  // 오늘 날짜/선택 날짜는 너 UI에 맞게 연결하면 됨
  const [planDate, setPlanDate] = useState("2026-02-01");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [resultId, setResultId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ordered = useMemo(
    () => [...rows].sort((a, b) => a.seq - b.seq),
    [rows],
  );

  // NOTE: 지금은 "조회용 API"가 없어서, apply/reset 호출 결과로 rows를 채우는 방식으로 시작.
  // 네가 이미 supabase client로 daily_plan을 읽고 있다면, 여기 useEffect에서 그걸로 setRows 하면 끝.
  useEffect(() => {
    // TODO: 너가 가진 기존 select 로직으로 교체
    // fetchDailyPlan(planDate).then(setRows).catch(()=>{});
  }, [planDate]);

  async function onApply() {
    setError(null);
    setLoading(true);
    try {
      const data = await postFn<{ ok: true; rows: Row[] }>("apply-result", {
        plan_date: planDate,
        result_id: resultId.trim(),
      });
      setRows(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onReset() {
    setError(null);
    setLoading(true);
    try {
      const data = await postFn<{ ok: true; rows: Row[] }>("reset-plan", {
        plan_date: planDate,
      });
      setRows(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onResetAll() {
    setError(null);
    setLoading(true);
    try {
      const data = await postFn<{ ok: true; rows: Row[] }>("reset-all", {
        plan_date: planDate,
      });
      setRows(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ width: 90 }}>plan_date</label>
        <input
          value={planDate}
          onChange={(e) => setPlanDate(e.target.value)}
          placeholder="YYYY-MM-DD"
          style={{ padding: 8, flex: 1 }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ width: 90 }}>result_id</label>
        <input
          value={resultId}
          onChange={(e) => setResultId(e.target.value)}
          placeholder="uuid..."
          style={{ padding: 8, flex: 1 }}
        />
        <button
          onClick={onApply}
          disabled={loading || !resultId.trim()}
          style={{ padding: "8px 12px" }}
        >
          Apply
        </button>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onReset} disabled={loading} style={{ padding: "8px 12px" }}>
          Reset
        </button>
        <button onClick={onResetAll} disabled={loading} style={{ padding: "8px 12px" }}>
          Reset All
        </button>
      </div>

      {error && (
        <div style={{ padding: 10, border: "1px solid #f99" }}>
          <b>Error:</b> {error}
        </div>
      )}

      <div style={{ padding: 10, border: "1px solid #ddd" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <b>Current Plan</b>
          {loading ? <span>working...</span> : null}
        </div>

        {ordered.length === 0 ? (
          <div style={{ marginTop: 8, opacity: 0.7 }}>
            rows 비어있음 — apply/reset 한 번 누르면 리스트가 채워짐.
            <br />
            (나중에 daily_plan select 연결하면 자동 로드로 바꾸면 됨)
          </div>
        ) : (
          <ol style={{ marginTop: 8 }}>
            {ordered.map((r) => (
              <li key={r.id} style={{ display: "flex", gap: 10 }}>
                <span style={{ width: 28 }}>{r.seq}</span>
                <span style={{ width: 90 }}>{r.client_id}</span>
                <span style={{ opacity: 0.7 }}>
                  {r.locked ? "locked" : ""} {r.is_manual ? "manual" : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
