"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/src/lib/supabaseClient";

type OptimizeResultRow = {
  id: string;
  plan_date: string;
  created_at: string;
  output_solution: any; // jsonb
  meta?: any;
};

type DailyPlanItemRow = {
  id: string;
  plan_date: string;
  client_id: string;
  seq: number;
  locked: boolean;
  is_manual: boolean;
  week_start: string;
};

function extractClients(solution: any): string[] {
  const arr = solution?.clients ?? solution?.route ?? [];
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => typeof x === "string");
}

function fmtKST(iso: string) {
  try {
    return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  } catch {
    return iso;
  }
}

export default function ResultsPanel(props: {
  defaultPlanDate: string; // e.g. "2026-02-01"
}) {
  const [planDate, setPlanDate] = useState(props.defaultPlanDate);

  const [loadingResults, setLoadingResults] = useState(false);
  const [results, setResults] = useState<OptimizeResultRow[]>([]);
  const [selected, setSelected] = useState<OptimizeResultRow | null>(null);

  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planRows, setPlanRows] = useState<DailyPlanItemRow[]>([]);

  const [busy, setBusy] = useState<string | null>(null); // button busy id
  const [msg, setMsg] = useState<string>("");

  const selectedClients = useMemo(() => extractClients(selected?.output_solution), [selected]);

  async function refreshResults() {
    setLoadingResults(true);
    setMsg("");
    try {
      const { data, error } = await supabase
        .from("optimize_results")
        .select("id, plan_date, created_at, output_solution, meta")
        .eq("plan_date", planDate)
        .order("created_at", { ascending: false })
        .limit(30);

      if (error) throw error;
      setResults((data ?? []) as OptimizeResultRow[]);
    } catch (e: any) {
      setMsg(`results load error: ${e?.message ?? String(e)}`);
    } finally {
      setLoadingResults(false);
    }
  }

  async function refreshPlan() {
    setLoadingPlan(true);
    setMsg("");
    try {
      const { data, error } = await supabase
        .from("daily_plan_items")
        .select("id, plan_date, client_id, seq, locked, is_manual, week_start")
        .eq("plan_date", planDate)
        .order("seq", { ascending: true });

      if (error) throw error;
      setPlanRows((data ?? []) as DailyPlanItemRow[]);
    } catch (e: any) {
      setMsg(`plan load error: ${e?.message ?? String(e)}`);
    } finally {
      setLoadingPlan(false);
    }
  }

  async function callFn(fnName: string, body: any) {
    // supabase-js edge function invoke (브라우저에서 동작)
    const { data, error } = await supabase.functions.invoke(fnName, { body });
    if (error) throw error;
    return data;
  }

  async function onResetPlan() {
    setBusy("reset-plan");
    setMsg("");
    try {
      const r = await callFn("reset-plan", { plan_date: planDate });
      setMsg(`reset-plan OK (${r?.version ?? "no version"})`);
      await refreshPlan();
    } catch (e: any) {
      setMsg(`reset-plan error: ${e?.message ?? JSON.stringify(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function onResetAll() {
    setBusy("reset-all");
    setMsg("");
    try {
      const r = await callFn("reset-all", { plan_date: planDate });
      setMsg(`reset-all OK (${r?.version ?? "no version"})`);
      await refreshPlan();
    } catch (e: any) {
      setMsg(`reset-all error: ${e?.message ?? JSON.stringify(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function onApplyResult(resultId: string) {
    setBusy(`apply:${resultId}`);
    setMsg("");
    try {
      const r = await callFn("apply-result", { plan_date: planDate, result_id: resultId });
      setMsg(`apply OK (${r?.version ?? "no version"})`);
      await refreshPlan();
    } catch (e: any) {
      setMsg(`apply error: ${e?.message ?? JSON.stringify(e)}`);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    // planDate 바뀌면 둘 다 로드
    refreshResults();
    refreshPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planDate]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          padding: 12,
          border: "1px solid #ddd",
          borderRadius: 12,
          display: "grid",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>Plan Date</div>
          <input
            type="date"
            value={planDate}
            onChange={(e) => setPlanDate(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8 }}
          />

          <button
            onClick={refreshResults}
            disabled={loadingResults}
            style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8 }}
          >
            {loadingResults ? "Loading Results..." : "Reload Results"}
          </button>

          <button
            onClick={refreshPlan}
            disabled={loadingPlan}
            style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8 }}
          >
            {loadingPlan ? "Loading Plan..." : "Reload Plan"}
          </button>

          <div style={{ flex: 1 }} />

          <button
            onClick={onResetPlan}
            disabled={busy !== null}
            style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8 }}
          >
            {busy === "reset-plan" ? "Reset Plan..." : "Reset Plan"}
          </button>

          <button
            onClick={onResetAll}
            disabled={busy !== null}
            style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8 }}
          >
            {busy === "reset-all" ? "Reset All..." : "Reset All (unlock)"}
          </button>
        </div>

        {msg ? (
          <div style={{ padding: 10, borderRadius: 10, background: "#f6f6f6", whiteSpace: "pre-wrap" }}>
            {msg}
          </div>
        ) : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* LEFT: results */}
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontWeight: 700 }}>Saved Results (optimize_results)</div>
            <div style={{ fontSize: 12, color: "#666" }}>{results.length} items</div>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {results.map((r) => {
              const clients = extractClients(r.output_solution);
              const isSel = selected?.id === r.id;
              return (
                <div
                  key={r.id}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: isSel ? "2px solid #111" : "1px solid #ddd",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontFamily: "monospace", fontSize: 12 }}>{r.id.slice(0, 8)}…</div>
                    <div style={{ fontSize: 12, color: "#666" }}>{fmtKST(r.created_at)}</div>
                    <div style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
                      clients: {clients.length}
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: "#333", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {clients.slice(0, 12).join(" → ")}
                    {clients.length > 12 ? " …" : ""}
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => setSelected(r)}
                      style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8 }}
                    >
                      {isSel ? "Selected" : "Preview"}
                    </button>

                    <button
                      onClick={() => onApplyResult(r.id)}
                      disabled={busy !== null}
                      style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 8 }}
                    >
                      {busy === `apply:${r.id}` ? "Applying..." : "Apply"}
                    </button>
                  </div>
                </div>
              );
            })}

            {results.length === 0 && !loadingResults ? (
              <div style={{ padding: 10, color: "#666" }}>
                No results for this plan_date. (save-result로 저장된 게 없으면 여기 비어있음)
              </div>
            ) : null}
          </div>
        </div>

        {/* RIGHT: preview + current plan */}
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, display: "grid", gap: 14 }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Preview (selected result)</div>
            <div style={{ padding: 10, borderRadius: 10, background: "#f6f6f6" }}>
              {selected ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontFamily: "monospace", fontSize: 12 }}>id: {selected.id}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>{fmtKST(selected.created_at)}</div>
                  <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                    {selectedClients.join(" → ")}
                  </div>
                </div>
              ) : (
                <div style={{ color: "#666" }}>Select a result to preview.</div>
              )}
            </div>
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Current Plan (daily_plan_items)</div>

            <div style={{ display: "grid", gap: 6 }}>
              {planRows.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: "6px 10px",
                    border: "1px solid #eee",
                    borderRadius: 10,
                  }}
                >
                  <div style={{ width: 34, textAlign: "right", fontFamily: "monospace" }}>{p.seq}</div>
                  <div style={{ fontFamily: "monospace" }}>{p.client_id}</div>
                  <div style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
                    {p.locked ? "locked" : ""} {p.is_manual ? "manual" : ""}
                  </div>
                </div>
              ))}

              {planRows.length === 0 && !loadingPlan ? (
                <div style={{ padding: 10, color: "#666" }}>No plan rows for this plan_date.</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
