"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/src/lib/supabaseClient";

type ClientRow = { id: string; name: string };

type PlanRow = {
  id: string;
  week_start: string;
  day_of_week: number;
  client_id: string;
  seq: number;
  is_manual: boolean;
  locked: boolean;
  source: string;
  clients?: { id: string; name: string } | null;
};

const DOW_LABEL: Record<number, string> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

function normalizePlanRows(data: unknown): PlanRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((r: any) => ({
    id: String(r.id),
    week_start: String(r.week_start),
    day_of_week: Number(r.day_of_week),
    client_id: String(r.client_id),
    seq: Number(r.seq),
    is_manual: Boolean(r.is_manual),
    locked: Boolean(r.locked),
    source: String(r.source ?? ""),
    clients: r.clients ? { id: String(r.clients.id), name: String(r.clients.name) } : null,
  }));
}

function normalizeClients(data: unknown): ClientRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((r: any) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
  }));
}

export default function WeeklyPage() {
  const [weekStart, setWeekStart] = useState("2026-01-12");

  const [rows, setRows] = useState<PlanRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 추가 폼 state
  const [addDow, setAddDow] = useState<number>(1);
  const [addClientId, setAddClientId] = useState<string>("");

  const fetchAll = async (ws: string) => {
    setLoading(true);
    setErr(null);

    const [planRes, clientRes] = await Promise.all([
      supabase
        .from("weekly_plan_items")
        .select(
          `
          id,
          week_start,
          day_of_week,
          client_id,
          seq,
          is_manual,
          locked,
          source,
          clients:clients(id,name)
        `
        )
        .eq("week_start", ws)
        .order("day_of_week", { ascending: true })
        .order("seq", { ascending: true }),

      supabase.from("clients").select("id,name").eq("status", "active").order("id", { ascending: true }),
    ]);

    if (planRes.error) {
      setErr(planRes.error.message);
      setRows([]);
    } else {
      setRows(normalizePlanRows(planRes.data));
    }

    if (clientRes.error) {
      setErr((prev) => prev ?? clientRes.error!.message);
      setClients([]);
    } else {
      const c = normalizeClients(clientRes.data);
      setClients(c);
      if (!addClientId && c.length) setAddClientId(c[0].id);
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchAll(weekStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  const grouped = useMemo(() => {
    const map = new Map<number, PlanRow[]>();
    for (const r of rows) {
      if (!map.has(r.day_of_week)) map.set(r.day_of_week, []);
      map.get(r.day_of_week)!.push(r);
    }
    return map;
  }, [rows]);

  /**
   * ✅ normalizeSeqForDay
   * - upsert 금지 (INSERT로 새 row 만들면 week_start NOT NULL 터짐)
   * - UPDATE만 사용
   * - 같은 요일에서 seq를 1..N으로 정리
   */
  const normalizeSeqForDay = async (dow: number) => {
    const list = [...(grouped.get(dow) ?? [])].sort((a, b) => a.seq - b.seq);
    if (list.length === 0) return;

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const nextSeq = i + 1;
      if (r.seq === nextSeq) continue;

      const { error } = await supabase
        .from("weekly_plan_items")
        .update({ seq: nextSeq }) // ✅ 정규화는 seq만!
        .eq("id", r.id)
        .eq("week_start", r.week_start)
        .eq("day_of_week", r.day_of_week);

      if (error) throw new Error(error.message);
    }
  };

  // ✅ 추가: 선택한 요일에 client 하나 넣기 (유니크 인덱스 기반 업서트)
  const addOne = async () => {
    if (!addClientId) return;
    setErr(null);
    setLoading(true);

    try {
      const list = grouped.get(addDow) ?? [];
      const lastSeq = list.length ? list[list.length - 1].seq : 0;
      const nextSeq = lastSeq + 1;

      const { error } = await supabase
        .from("weekly_plan_items")
        .upsert(
          {
            week_start: weekStart,
            day_of_week: addDow,
            client_id: addClientId,
            seq: nextSeq,
            is_manual: true,
            locked: false,
            source: "MANUAL",
          },
          { onConflict: "week_start,day_of_week,client_id" }
        );

      if (error) throw new Error(error.message);

      await fetchAll(weekStart);
      await normalizeSeqForDay(addDow);
      await fetchAll(weekStart);
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // ✅ 삭제
  const deleteRow = async (r: PlanRow) => {
    setErr(null);
    setLoading(true);

    try {
      const { error } = await supabase.from("weekly_plan_items").delete().eq("id", r.id);
      if (error) throw new Error(error.message);

      await fetchAll(weekStart);
      await normalizeSeqForDay(r.day_of_week);
      await fetchAll(weekStart);
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // ✅ 위/아래 이동(같은 요일 안에서) - UNIQUE(seq) 충돌 방지용 안전 swap (UPDATE만)
  // ⚠️ source/is_manual을 "둘 다" MANUAL로 바꾸지 않게: "움직인 a만" MANUAL 처리
  const moveRow = async (r: PlanRow, dir: "up" | "down") => {
    setErr(null);
    setLoading(true);

    try {
      const list = [...(grouped.get(r.day_of_week) ?? [])].sort((a, b) => a.seq - b.seq);
      const idx = list.findIndex((x) => x.id === r.id);
      if (idx < 0) return;

      const swapWith = dir === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= list.length) return;

      const a = list[idx]; // 내가 누른 대상
      const b = list[swapWith];

      if (a.week_start !== b.week_start || a.day_of_week !== b.day_of_week) {
        throw new Error("Swap 대상이 같은 week/day가 아닙니다.");
      }

      // 임시 seq (해당 요일에서 절대 사용 안 하는 값)
      const minSeq = Math.min(...list.map((x) => x.seq));
      const tmpSeq = minSeq - 1000000;

      // 1) a -> tmp (a만 MANUAL 표시)
      const r1 = await supabase
        .from("weekly_plan_items")
        .update({ seq: tmpSeq, is_manual: true, source: "MANUAL" })
        .eq("id", a.id)
        .eq("week_start", a.week_start)
        .eq("day_of_week", a.day_of_week);

      if (r1.error) throw new Error(`[STEP1] a->tmp 실패: ${r1.error.message}`);

      // 2) b -> a.seq (b는 source/is_manual 건드리지 않음)
      const r2 = await supabase
        .from("weekly_plan_items")
        .update({ seq: a.seq })
        .eq("id", b.id)
        .eq("week_start", b.week_start)
        .eq("day_of_week", b.day_of_week);

      if (r2.error) {
        await supabase
          .from("weekly_plan_items")
          .update({ seq: a.seq })
          .eq("id", a.id)
          .eq("week_start", a.week_start)
          .eq("day_of_week", a.day_of_week);

        throw new Error(`[STEP2] b->a.seq 실패: ${r2.error.message}`);
      }

      // 3) a(tmp) -> b.seq (a만 MANUAL 유지)
      const r3 = await supabase
        .from("weekly_plan_items")
        .update({ seq: b.seq, is_manual: true, source: "MANUAL" })
        .eq("id", a.id)
        .eq("week_start", a.week_start)
        .eq("day_of_week", a.day_of_week);

      if (r3.error) {
        // 원복
        await supabase
          .from("weekly_plan_items")
          .update({ seq: a.seq })
          .eq("id", a.id)
          .eq("week_start", a.week_start)
          .eq("day_of_week", a.day_of_week);

        await supabase
          .from("weekly_plan_items")
          .update({ seq: b.seq })
          .eq("id", b.id)
          .eq("week_start", b.week_start)
          .eq("day_of_week", b.day_of_week);

        throw new Error(`[STEP3] a(tmp)->b.seq 실패: ${r3.error.message}`);
      }

      await fetchAll(weekStart);
      await normalizeSeqForDay(r.day_of_week);
      await fetchAll(weekStart);
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  /**
   * ✅ 요일 이동 (Mon -> Sun 등)
   * - 하루 최대 15개 제한 체크
   * - UPDATE만 사용 (week_start NOT NULL 안전)
   * - "내가 옮긴 row만" MANUAL 처리
   * - 옮긴 날/원래 날 둘 다 normalize
   */
  const moveToDay = async (r: PlanRow, newDow: number) => {
    if (r.day_of_week === newDow) return;

    setErr(null);
    setLoading(true);

    try {
      // 1) 목표 요일 현재 개수 (15개 제한)
      const targetList = [...(grouped.get(newDow) ?? [])];
      if (targetList.length >= 15) {
        throw new Error(`${DOW_LABEL[newDow]} 은(는) 이미 15개 꽉 참`);
      }

      // 2) 목표 요일의 "맨 뒤 seq" 구하기 (그냥 max+1로 넣고 이후 normalize)
      const maxSeq = targetList.length ? Math.max(...targetList.map((x) => x.seq)) : 0;
      const nextSeq = maxSeq + 1;

      // 3) 같은 요일에 같은 client 이미 있으면 막기 (유니크 인덱스 있으니 선제 차단)
      if (targetList.some((x) => x.client_id === r.client_id)) {
        throw new Error(`${DOW_LABEL[newDow]} 에 이미 ${r.client_id} 가 있음`);
      }

      // 4) UPDATE로 요일+seq 변경 (r만 MANUAL 처리)
      const { error } = await supabase
        .from("weekly_plan_items")
        .update({
          day_of_week: newDow,
          seq: nextSeq,
          is_manual: true,
          source: "MANUAL",
        })
        .eq("id", r.id)
        .eq("week_start", r.week_start);

      if (error) throw new Error(error.message);

      // 5) 양쪽 요일 normalize
      const oldDow = r.day_of_week;

      await fetchAll(weekStart);
      await normalizeSeqForDay(oldDow);
      await normalizeSeqForDay(newDow);
      await fetchAll(weekStart);
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // ✅ AUTO 리빌드: DB 함수 호출
  const rebuildAuto = async () => {
    setErr(null);
    setLoading(true);

    try {
      const { error } = await supabase.rpc("rebuild_weekly_plan", {
        p_week_start: weekStart,
      });
      if (error) throw new Error(error.message);

      await fetchAll(weekStart);
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ fontSize: 32, fontWeight: 800 }}>Weekly Plan</h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>weekly_plan_items 조회/편집 테스트 (week_start 기준)</p>

      {/* 상단 컨트롤 */}
      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontWeight: 600 }}>week_start:</label>
        <input
          type="date"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          style={{ padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
        />

        <button
          onClick={rebuildAuto}
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
        >
          AUTO Rebuild
        </button>

        <a href="/" style={{ marginLeft: "auto", textDecoration: "underline" }}>
          ← Clients로
        </a>
      </div>

      {/* 추가 폼 */}
      <div
        style={{
          marginTop: 14,
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
          padding: 12,
          border: "1px solid #eee",
          borderRadius: 12,
        }}
      >
        <strong>추가:</strong>

        <select
          value={addDow}
          onChange={(e) => setAddDow(Number(e.target.value))}
          style={{ padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <option key={d} value={d}>
              {DOW_LABEL[d]}
            </option>
          ))}
        </select>

        <select
          value={addClientId}
          onChange={(e) => setAddClientId(e.target.value)}
          style={{ padding: 8, border: "1px solid #ddd", borderRadius: 8, minWidth: 240 }}
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} - {c.name}
            </option>
          ))}
        </select>

        <button
          onClick={addOne}
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
        >
          추가
        </button>

        <span style={{ opacity: 0.7 }}>* 같은 요일에 같은 거래처는 1번만 들어감(유니크 인덱스)</span>
      </div>

      {loading && <p style={{ marginTop: 16 }}>Loading…</p>}
      {err && <p style={{ marginTop: 16, color: "crimson" }}>Error: {err}</p>}

      {!loading && !err && (
        <div style={{ marginTop: 20, display: "grid", gap: 16 }}>
          {[1, 2, 3, 4, 5, 6, 7].map((dow) => {
            const list = [...(grouped.get(dow) ?? [])].sort((a, b) => a.seq - b.seq);

            return (
              <section key={dow} style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
                <h2 style={{ fontSize: 20, fontWeight: 800 }}>
                  {DOW_LABEL[dow]} ({list.length})
                </h2>

                {list.length === 0 ? (
                  <p style={{ marginTop: 8, opacity: 0.6 }}>비어있음</p>
                ) : (
                  <table style={{ width: "100%", marginTop: 10, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
                        <th style={{ padding: "8px 0" }}>seq</th>
                        <th style={{ padding: "8px 0" }}>client</th>
                        <th style={{ padding: "8px 0" }}>manual</th>
                        <th style={{ padding: "8px 0" }}>locked</th>
                        <th style={{ padding: "8px 0" }}>source</th>
                        <th style={{ padding: "8px 0" }}>move day</th>
                        <th style={{ padding: "8px 0" }}>actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r, i) => (
                        <tr key={r.id} style={{ borderBottom: "1px solid #f3f3f3" }}>
                          <td style={{ padding: "10px 0" }}>{r.seq}</td>
                          <td style={{ padding: "10px 0", fontWeight: 700 }}>
                            {r.client_id}
                            <span style={{ marginLeft: 8, fontWeight: 400, opacity: 0.7 }}>{r.clients?.name ?? ""}</span>
                          </td>
                          <td style={{ padding: "10px 0" }}>{String(r.is_manual)}</td>
                          <td style={{ padding: "10px 0" }}>{String(r.locked)}</td>
                          <td style={{ padding: "10px 0" }}>{r.source}</td>

                          {/* ✅ 요일 이동 드롭다운 */}
                          <td style={{ padding: "10px 0" }}>
                            <select
                              value={r.day_of_week}
                              onChange={(e) => moveToDay(r, Number(e.target.value))}
                              style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #ddd" }}
                            >
                              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                                <option key={d} value={d}>
                                  {DOW_LABEL[d]}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td style={{ padding: "10px 0" }}>
                            <button
                              onClick={() => moveRow(r, "up")}
                              disabled={i === 0}
                              style={{
                                marginRight: 6,
                                padding: "6px 10px",
                                borderRadius: 8,
                                border: "1px solid #ddd",
                                cursor: i === 0 ? "not-allowed" : "pointer",
                                opacity: i === 0 ? 0.4 : 1,
                              }}
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => moveRow(r, "down")}
                              disabled={i === list.length - 1}
                              style={{
                                marginRight: 6,
                                padding: "6px 10px",
                                borderRadius: 8,
                                border: "1px solid #ddd",
                                cursor: i === list.length - 1 ? "not-allowed" : "pointer",
                                opacity: i === list.length - 1 ? 0.4 : 1,
                              }}
                            >
                              ↓
                            </button>
                            <button
                              onClick={() => deleteRow(r)}
                              style={{
                                padding: "6px 10px",
                                borderRadius: 8,
                                border: "1px solid #ddd",
                                cursor: "pointer",
                              }}
                            >
                              삭제
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
