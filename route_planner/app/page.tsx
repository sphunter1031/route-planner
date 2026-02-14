// app/page.tsx
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type ClientRow = {
  id: string;
  name: string;
  status: string | null;
};

export default function Page() {
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setErr(null);

      const { data, error } = await supabase
        .from("clients")
        .select("id,name,status")
        .order("id", { ascending: true });

      if (error) {
        setErr(error.message);
        setRows([]);
      } else {
        setRows((data ?? []) as ClientRow[]);
      }

      setLoading(false);
    };

    run();
  }, []);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Route Planner</h1>
      <p style={{ marginTop: 8, color: "#555" }}>
        Supabase 연결 테스트: <code>clients</code> 테이블 조회
      </p>

      {loading && <p style={{ marginTop: 16 }}>로딩중…</p>}
      {err && (
        <p style={{ marginTop: 16, color: "crimson" }}>
          에러: {err}
        </p>
      )}

      {!loading && !err && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 12, fontWeight: 600, borderBottom: "1px solid #ddd", paddingBottom: 8 }}>
            <div style={{ width: 120 }}>id</div>
            <div style={{ width: 240 }}>name</div>
            <div style={{ width: 140 }}>status</div>
          </div>

          {rows.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ width: 120 }}>{r.id}</div>
              <div style={{ width: 240 }}>{r.name}</div>
              <div style={{ width: 140 }}>{r.status ?? ""}</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
