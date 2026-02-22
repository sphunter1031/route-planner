// route_planner/app/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/**
 * UI에서 숨길 컬럼(정책):
 * - client_uuid, created_at, updated_at : 안 보여줌
 * - id : 리스트에 표시하지만 "수정 모달"에서 수정 불가 / "추가 모달"에서만 입력 가능
 *
 * note 컬럼은 삭제했고 notes만 사용
 * parking_info(주차정보) 추가
 */

type ClientRow = {
  id: string; // PK
  name: string;
  status: string; // default 'active'
  address_text: string | null;

  lat: number; // NOT NULL
  lon: number; // NOT NULL

  frequency_per_week: number; // default 1
  service_minutes: number | null; // nullable in schema (default 0)
  priority: boolean;

  parent_id: string | null;
  dependent_mode: string; // default 'independent_only'
  day_required_mask: number; // default 0

  notes: string | null;

  req_mon: boolean | null;
  req_tue: boolean | null;
  req_wed: boolean | null;
  req_thu: boolean | null;
  req_fri: boolean | null;
  req_sat: boolean | null;
  req_sun: boolean | null;

  access_method: string | null;
  access_code: string | null;
  manager_name: string | null;
  manager_phone: string | null;

  // ✅ NEW
  parking_info: string | null;

  // 숨김(타입에는 굳이 안 넣음)
  // created_at, updated_at, client_uuid
};

type ClientInsertDraft = {
  id: string;
  name: string;
  status: string;
  address_text: string | null;

  lat: number | null;
  lon: number | null;

  frequency_per_week: number;
  service_minutes: number | null;
  priority: boolean;

  parent_id: string | null;
  dependent_mode: string;
  day_required_mask: number;

  notes: string | null;

  req_mon: boolean;
  req_tue: boolean;
  req_wed: boolean;
  req_thu: boolean;
  req_fri: boolean;
  req_sat: boolean;
  req_sun: boolean;

  access_method: string | null;
  access_code: string | null;
  manager_name: string | null;
  manager_phone: string | null;

  // ✅ NEW
  parking_info: string | null;
};

type ClientUpdateDraft = Omit<ClientRow, "id">;

function toNumberOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toNumberOrFallback(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function validateLatLon(lat: number | null, lon: number | null) {
  if (lat === null || lon === null) return { ok: false, msg: "lat/lon은 필수입니다." };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, msg: "lat/lon이 숫자가 아닙니다." };
  if (lat < -90 || lat > 90) return { ok: false, msg: "lat 범위가 올바르지 않습니다. (-90 ~ 90)" };
  if (lon < -180 || lon > 180) return { ok: false, msg: "lon 범위가 올바르지 않습니다. (-180 ~ 180)" };
  return { ok: true, msg: "" };
}

function overlayStyle(): React.CSSProperties {
  return {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    padding: 16,
  };
}

function modalStyle(): React.CSSProperties {
  return {
    width: "min(980px, 100%)",
    maxHeight: "85vh",
    overflow: "auto",
    background: "#fff",
    borderRadius: 12,
    padding: 16,
    position: "relative",
    boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
  };
}

function headerCellStyle(width?: number): React.CSSProperties {
  return {
    minWidth: width ?? 140,
    padding: 8,
    borderBottom: "1px solid #ddd",
    fontWeight: 700,
    position: "sticky",
    top: 0,
    background: "#fff",
    zIndex: 1,
    textAlign: "left",
    whiteSpace: "nowrap",
  };
}

function cellStyle(width?: number): React.CSSProperties {
  return {
    minWidth: width ?? 140,
    padding: 8,
    borderBottom: "1px solid #f0f0f0",
    verticalAlign: "top",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: width ?? 200,
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    border: "1px solid #ddd",
    borderRadius: 8,
    outline: "none",
  };
}

function labelStyle(): React.CSSProperties {
  return {
    fontSize: 12,
    color: "#666",
    marginBottom: 6,
    fontWeight: 600,
  };
}

function sectionTitleStyle(): React.CSSProperties {
  return { fontSize: 14, fontWeight: 800, margin: "14px 0 10px" };
}

function buttonStyle(variant: "primary" | "ghost" | "danger" = "ghost"): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 10,
    cursor: "pointer",
    border: "1px solid #ddd",
    background: "#fff",
    fontWeight: 700,
  };
  if (variant === "primary") return { ...base, background: "#111", color: "#fff", border: "1px solid #111" };
  if (variant === "danger") return { ...base, background: "#fff", color: "crimson", border: "1px solid #f3b3b3" };
  return base;
}

export default function Page() {
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Edit modal state
  const [editOpen, setEditOpen] = useState(false);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ClientUpdateDraft | null>(null);

  // Add modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<ClientInsertDraft>(() => ({
    id: "",
    name: "",
    status: "active",
    address_text: null,
    lat: null,
    lon: null,
    frequency_per_week: 1,
    service_minutes: 0,
    priority: false,
    parent_id: null,
    dependent_mode: "independent_only",
    day_required_mask: 0,
    notes: null,
    req_mon: false,
    req_tue: false,
    req_wed: false,
    req_thu: false,
    req_fri: false,
    req_sat: false,
    req_sun: false,
    access_method: null,
    access_code: null,
    manager_name: null,
    manager_phone: null,
    // ✅ NEW
    parking_info: null,
  }));

  const [saving, setSaving] = useState(false);

  const visibleColumns = useMemo(
    () =>
      [
        "id",
        "name",
        "status",
        "address_text",
        "lat",
        "lon",
        "frequency_per_week",
        "service_minutes",
        "priority",
        "parent_id",
        "dependent_mode",
        "day_required_mask",
        "req_mon",
        "req_tue",
        "req_wed",
        "req_thu",
        "req_fri",
        "req_sat",
        "req_sun",
        "access_method",
        "access_code",
        "manager_name",
        "manager_phone",
        // ✅ NEW
        "parking_info",
        "notes",
      ] as const,
    []
  );

  async function load() {
    setLoading(true);
    setErr(null);

    const { data, error } = await supabase
      .from("clients")
      .select(
        [
          "id",
          "name",
          "status",
          "address_text",
          "lat",
          "lon",
          "frequency_per_week",
          "service_minutes",
          "priority",
          "parent_id",
          "dependent_mode",
          "day_required_mask",
          "notes",
          "req_mon",
          "req_tue",
          "req_wed",
          "req_thu",
          "req_fri",
          "req_sat",
          "req_sun",
          "access_method",
          "access_code",
          "manager_name",
          "manager_phone",
          // ✅ NEW
          "parking_info",
          // 숨김: client_uuid, created_at, updated_at
        ].join(",")
      )
      .order("id", { ascending: true })
      .returns<ClientRow[]>();

    if (error) {
      setErr(error.message);
      setRows([]);
    } else {
      setRows(data ?? []);
    }

    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openEdit(row: ClientRow) {
    setEditTargetId(row.id);
    // id 제외하고 draft 구성
    const draft: ClientUpdateDraft = {
      name: row.name,
      status: row.status,
      address_text: row.address_text,
      lat: row.lat,
      lon: row.lon,
      frequency_per_week: row.frequency_per_week,
      service_minutes: row.service_minutes,
      priority: row.priority,
      parent_id: row.parent_id,
      dependent_mode: row.dependent_mode,
      day_required_mask: row.day_required_mask,
      notes: row.notes,
      req_mon: row.req_mon ?? false,
      req_tue: row.req_tue ?? false,
      req_wed: row.req_wed ?? false,
      req_thu: row.req_thu ?? false,
      req_fri: row.req_fri ?? false,
      req_sat: row.req_sat ?? false,
      req_sun: row.req_sun ?? false,
      access_method: row.access_method,
      access_code: row.access_code,
      manager_name: row.manager_name,
      manager_phone: row.manager_phone,
      // ✅ NEW
      parking_info: row.parking_info,
    };
    setEditDraft(draft);
    setEditOpen(true);
  }

  function closeEdit() {
    if (saving) return;
    setEditOpen(false);
    setEditTargetId(null);
    setEditDraft(null);
  }

  function openAdd() {
    setAddDraft({
      id: "",
      name: "",
      status: "active",
      address_text: null,
      lat: null,
      lon: null,
      frequency_per_week: 1,
      service_minutes: 0,
      priority: false,
      parent_id: null,
      dependent_mode: "independent_only",
      day_required_mask: 0,
      notes: null,
      req_mon: false,
      req_tue: false,
      req_wed: false,
      req_thu: false,
      req_fri: false,
      req_sat: false,
      req_sun: false,
      access_method: null,
      access_code: null,
      manager_name: null,
      manager_phone: null,
      // ✅ NEW
      parking_info: null,
    });
    setAddOpen(true);
  }

  function closeAdd() {
    if (saving) return;
    setAddOpen(false);
  }

  async function saveEdit() {
    if (!editDraft || !editTargetId) return;

    // 최소 검증
    const latlon = validateLatLon(editDraft.lat, editDraft.lon);
    if (!latlon.ok) {
      alert(latlon.msg);
      return;
    }

    if (!Number.isFinite(editDraft.frequency_per_week)) {
      alert("frequency_per_week 값이 올바르지 않습니다.");
      return;
    }
    if (!Number.isFinite(editDraft.day_required_mask)) {
      alert("day_required_mask 값이 올바르지 않습니다.");
      return;
    }
    if (editDraft.service_minutes !== null && !Number.isFinite(editDraft.service_minutes)) {
      alert("service_minutes 값이 올바르지 않습니다.");
      return;
    }

    setSaving(true);
    const { error } = await supabase.from("clients").update(editDraft).eq("id", editTargetId);
    setSaving(false);

    if (error) {
      alert("수정 실패: " + error.message);
      return;
    }

    closeEdit();
    await load();
  }

  async function saveAdd() {
    if (!addDraft.id.trim()) {
      alert("id는 필수입니다.");
      return;
    }
    if (!addDraft.name.trim()) {
      alert("name은 필수입니다.");
      return;
    }
    const latlon = validateLatLon(addDraft.lat, addDraft.lon);
    if (!latlon.ok) {
      alert(latlon.msg);
      return;
    }

    setSaving(true);

    const payload = {
      id: addDraft.id.trim(),
      name: addDraft.name.trim(),
      status: addDraft.status.trim() || "active",
      address_text: addDraft.address_text && addDraft.address_text.trim() ? addDraft.address_text.trim() : null,

      lat: addDraft.lat!,
      lon: addDraft.lon!,

      frequency_per_week: addDraft.frequency_per_week,
      service_minutes: addDraft.service_minutes,
      priority: addDraft.priority,

      parent_id: addDraft.parent_id && addDraft.parent_id.trim() ? addDraft.parent_id.trim() : null,
      dependent_mode: addDraft.dependent_mode.trim() || "independent_only",
      day_required_mask: addDraft.day_required_mask,

      // ✅ NEW
      parking_info: addDraft.parking_info && addDraft.parking_info.trim() ? addDraft.parking_info : null,

      notes: addDraft.notes && addDraft.notes.trim() ? addDraft.notes : null,

      req_mon: addDraft.req_mon,
      req_tue: addDraft.req_tue,
      req_wed: addDraft.req_wed,
      req_thu: addDraft.req_thu,
      req_fri: addDraft.req_fri,
      req_sat: addDraft.req_sat,
      req_sun: addDraft.req_sun,

      access_method: addDraft.access_method && addDraft.access_method.trim() ? addDraft.access_method : null,
      access_code: addDraft.access_code && addDraft.access_code.trim() ? addDraft.access_code : null,
      manager_name: addDraft.manager_name && addDraft.manager_name.trim() ? addDraft.manager_name : null,
      manager_phone: addDraft.manager_phone && addDraft.manager_phone.trim() ? addDraft.manager_phone : null,

      // 숨김/자동: client_uuid, created_at, updated_at
    };

    const { error } = await supabase.from("clients").insert(payload);
    setSaving(false);

    if (error) {
      alert("추가 실패: " + error.message);
      return;
    }

    closeAdd();
    await load();
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Clients Admin</h1>
          <p style={{ marginTop: 6, color: "#555" }}>
            전체 컬럼 노출 / 모달에서만 수정 / <code>client_uuid, created_at, updated_at</code> 숨김
          </p>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button style={buttonStyle("ghost")} onClick={load} disabled={loading || saving}>
            새로고침
          </button>
          <button style={buttonStyle("primary")} onClick={openAdd} disabled={saving}>
            + 거래처 추가
          </button>
        </div>
      </div>

      {loading && <p style={{ marginTop: 16 }}>로딩중…</p>}
      {err && (
        <p style={{ marginTop: 16, color: "crimson" }}>
          에러: {err}
        </p>
      )}

      {!loading && !err && (
        <div style={{ marginTop: 14, border: "1px solid #eee", borderRadius: 12, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {visibleColumns.map((c) => (
                  <th key={c} style={headerCellStyle(c === "id" ? 140 : c === "name" ? 220 : 160)}>
                    {c}
                  </th>
                ))}
                <th style={headerCellStyle(120)}>actions</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={cellStyle(140)} title={r.id}>
                    {r.id}
                  </td>
                  <td style={cellStyle(220)} title={r.name}>
                    {r.name}
                  </td>
                  <td style={cellStyle(140)} title={r.status}>
                    {r.status}
                  </td>
                  <td style={cellStyle(220)} title={r.address_text ?? ""}>
                    {r.address_text ?? ""}
                  </td>
                  <td style={cellStyle(120)}>{r.lat}</td>
                  <td style={cellStyle(120)}>{r.lon}</td>
                  <td style={cellStyle(120)}>{r.frequency_per_week}</td>
                  <td style={cellStyle(140)}>{r.service_minutes ?? ""}</td>
                  <td style={cellStyle(120)}>{String(r.priority)}</td>
                  <td style={cellStyle(140)} title={r.parent_id ?? ""}>
                    {r.parent_id ?? ""}
                  </td>
                  <td style={cellStyle(180)} title={r.dependent_mode}>
                    {r.dependent_mode}
                  </td>
                  <td style={cellStyle(160)}>{r.day_required_mask}</td>

                  <td style={cellStyle(110)}>{String(r.req_mon ?? false)}</td>
                  <td style={cellStyle(110)}>{String(r.req_tue ?? false)}</td>
                  <td style={cellStyle(110)}>{String(r.req_wed ?? false)}</td>
                  <td style={cellStyle(110)}>{String(r.req_thu ?? false)}</td>
                  <td style={cellStyle(110)}>{String(r.req_fri ?? false)}</td>
                  <td style={cellStyle(110)}>{String(r.req_sat ?? false)}</td>
                  <td style={cellStyle(110)}>{String(r.req_sun ?? false)}</td>

                  <td style={cellStyle(160)} title={r.access_method ?? ""}>
                    {r.access_method ?? ""}
                  </td>
                  <td style={cellStyle(200)} title={r.access_code ?? ""}>
                    {r.access_code ?? ""}
                  </td>
                  <td style={cellStyle(160)} title={r.manager_name ?? ""}>
                    {r.manager_name ?? ""}
                  </td>
                  <td style={cellStyle(160)} title={r.manager_phone ?? ""}>
                    {r.manager_phone ?? ""}
                  </td>

                  {/* ✅ NEW */}
                  <td style={cellStyle(260)} title={r.parking_info ?? ""}>
                    {r.parking_info ?? ""}
                  </td>

                  <td style={cellStyle(260)} title={r.notes ?? ""}>
                    {r.notes ?? ""}
                  </td>

                  <td style={cellStyle(120)}>
                    <button style={buttonStyle("ghost")} onClick={() => openEdit(r)} disabled={saving}>
                      수정하기
                    </button>
                  </td>
                </tr>
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length + 1} style={{ padding: 16, color: "#666" }}>
                    데이터가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* EDIT MODAL */}
      {editOpen && editDraft && editTargetId && (
        <div style={overlayStyle()} onClick={closeEdit}>
          <div style={modalStyle()} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={closeEdit}
              aria-label="close"
              style={{
                position: "absolute",
                right: 10,
                top: 10,
                border: "none",
                background: "transparent",
                fontSize: 18,
                cursor: saving ? "not-allowed" : "pointer",
              }}
              disabled={saving}
            >
              ✕
            </button>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>거래처 수정</h2>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={buttonStyle("ghost")} onClick={closeEdit} disabled={saving}>
                  닫기
                </button>
                <button style={buttonStyle("primary")} onClick={saveEdit} disabled={saving}>
                  {saving ? "저장중..." : "수정완료"}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "#fafafa", border: "1px solid #eee" }}>
              <div style={{ fontSize: 12, color: "#666", fontWeight: 700, marginBottom: 6 }}>id (수정 불가)</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <code style={{ background: "#fff", border: "1px solid #eee", padding: "6px 8px", borderRadius: 8 }}>
                  {editTargetId}
                </code>
                <button style={buttonStyle("ghost")} onClick={() => navigator.clipboard.writeText(editTargetId)} disabled={saving}>
                  복사
                </button>
              </div>
            </div>

            <div style={sectionTitleStyle()}>기본</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={labelStyle()}>name</div>
                <input style={inputStyle()} value={editDraft.name} onChange={(e) => setEditDraft((p) => (p ? { ...p, name: e.target.value } : p))} />
              </div>
              <div>
                <div style={labelStyle()}>status</div>
                <input style={inputStyle()} value={editDraft.status} onChange={(e) => setEditDraft((p) => (p ? { ...p, status: e.target.value } : p))} />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <div style={labelStyle()}>address_text</div>
                <textarea
                  style={{ ...inputStyle(), minHeight: 60 }}
                  value={editDraft.address_text ?? ""}
                  onChange={(e) => setEditDraft((p) => (p ? { ...p, address_text: e.target.value || null } : p))}
                />
              </div>
            </div>

            <div style={sectionTitleStyle()}>좌표 / 빈도 / 시간</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
              <div>
                <div style={labelStyle()}>lat</div>
                <input
                  style={inputStyle()}
                  inputMode="decimal"
                  value={String(editDraft.lat)}
                  onChange={(e) => setEditDraft((p) => (p ? { ...p, lat: toNumberOrFallback(e.target.value, p.lat) } : p))}
                />
              </div>
              <div>
                <div style={labelStyle()}>lon</div>
                <input
                  style={inputStyle()}
                  inputMode="decimal"
                  value={String(editDraft.lon)}
                  onChange={(e) => setEditDraft((p) => (p ? { ...p, lon: toNumberOrFallback(e.target.value, p.lon) } : p))}
                />
              </div>
              <div>
                <div style={labelStyle()}>frequency_per_week</div>
                <input
                  style={inputStyle()}
                  inputMode="numeric"
                  value={String(editDraft.frequency_per_week)}
                  onChange={(e) => setEditDraft((p) => (p ? { ...p, frequency_per_week: toNumberOrFallback(e.target.value, p.frequency_per_week) } : p))}
                />
              </div>
              <div>
                <div style={labelStyle()}>service_minutes</div>
                <input
                  style={inputStyle()}
                  inputMode="numeric"
                  value={editDraft.service_minutes === null ? "" : String(editDraft.service_minutes)}
                  onChange={(e) => setEditDraft((p) => (p ? { ...p, service_minutes: toNumberOrNull(e.target.value) } : p))}
                />
              </div>
            </div>

            <div style={sectionTitleStyle()}>제약 / 종속</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <div>
                <div style={labelStyle()}>priority</div>
                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input type="checkbox" checked={!!editDraft.priority} onChange={(e) => setEditDraft((p) => (p ? { ...p, priority: e.target.checked } : p))} />
                  <span style={{ fontWeight: 700 }}>{editDraft.priority ? "true" : "false"}</span>
                </label>
              </div>
              <div>
                <div style={labelStyle()}>parent_id</div>
                <input style={inputStyle()} value={editDraft.parent_id ?? ""} onChange={(e) => setEditDraft((p) => (p ? { ...p, parent_id: e.target.value || null } : p))} />
              </div>
              <div>
                <div style={labelStyle()}>dependent_mode</div>
                <input style={inputStyle()} value={editDraft.dependent_mode} onChange={(e) => setEditDraft((p) => (p ? { ...p, dependent_mode: e.target.value } : p))} />
              </div>
              <div>
                <div style={labelStyle()}>day_required_mask</div>
                <input
                  style={inputStyle()}
                  inputMode="numeric"
                  value={String(editDraft.day_required_mask)}
                  onChange={(e) => setEditDraft((p) => (p ? { ...p, day_required_mask: toNumberOrFallback(e.target.value, p.day_required_mask) } : p))}
                />
              </div>
            </div>

            <div style={sectionTitleStyle()}>요일 요구</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
              {([
                ["req_mon", "Mon"],
                ["req_tue", "Tue"],
                ["req_wed", "Wed"],
                ["req_thu", "Thu"],
                ["req_fri", "Fri"],
                ["req_sat", "Sat"],
                ["req_sun", "Sun"],
              ] as const).map(([key, label]) => (
                <label key={key} style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, border: "1px solid #eee", borderRadius: 10 }}>
                  <input
                    type="checkbox"
                    checked={!!(editDraft as any)[key]}
                    onChange={(e) => setEditDraft((p) => (p ? ({ ...p, [key]: e.target.checked } as ClientUpdateDraft) : p))}
                  />
                  <span style={{ fontWeight: 800 }}>{label}</span>
                </label>
              ))}
            </div>

            <div style={sectionTitleStyle()}>출입 / 책임자</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={labelStyle()}>access_method</div>
                <input style={inputStyle()} value={editDraft.access_method ?? ""} onChange={(e) => setEditDraft((p) => (p ? { ...p, access_method: e.target.value || null } : p))} />
              </div>
              <div>
                <div style={labelStyle()}>manager_name</div>
                <input style={inputStyle()} value={editDraft.manager_name ?? ""} onChange={(e) => setEditDraft((p) => (p ? { ...p, manager_name: e.target.value || null } : p))} />
              </div>
              <div>
                <div style={labelStyle()}>manager_phone</div>
                <input style={inputStyle()} value={editDraft.manager_phone ?? ""} onChange={(e) => setEditDraft((p) => (p ? { ...p, manager_phone: e.target.value || null } : p))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={labelStyle()}>access_code</div>
                <textarea style={{ ...inputStyle(), minHeight: 70 }} value={editDraft.access_code ?? ""} onChange={(e) => setEditDraft((p) => (p ? { ...p, access_code: e.target.value || null } : p))} />
              </div>
            </div>

            {/* ✅ NEW: parking_info */}
            <div style={sectionTitleStyle()}>주차 정보</div>
            <div>
              <div style={labelStyle()}>parking_info</div>
              <textarea
                style={{ ...inputStyle(), minHeight: 90 }}
                value={editDraft.parking_info ?? ""}
                onChange={(e) => setEditDraft((p) => (p ? { ...p, parking_info: e.target.value || null } : p))}
              />
            </div>

            <div style={sectionTitleStyle()}>notes</div>
            <div>
              <div style={labelStyle()}>notes (메모)</div>
              <textarea style={{ ...inputStyle(), minHeight: 110 }} value={editDraft.notes ?? ""} onChange={(e) => setEditDraft((p) => (p ? { ...p, notes: e.target.value || null } : p))} />
            </div>
          </div>
        </div>
      )}

      {/* ADD MODAL */}
      {addOpen && (
        <div style={overlayStyle()} onClick={closeAdd}>
          <div style={modalStyle()} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={closeAdd}
              aria-label="close"
              style={{
                position: "absolute",
                right: 10,
                top: 10,
                border: "none",
                background: "transparent",
                fontSize: 18,
                cursor: saving ? "not-allowed" : "pointer",
              }}
              disabled={saving}
            >
              ✕
            </button>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>거래처 추가</h2>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={buttonStyle("ghost")} onClick={closeAdd} disabled={saving}>
                  닫기
                </button>
                <button style={buttonStyle("primary")} onClick={saveAdd} disabled={saving}>
                  {saving ? "저장중..." : "추가완료"}
                </button>
              </div>
            </div>

            <div style={sectionTitleStyle()}>필수</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={labelStyle()}>id (필수, 생성 후 수정 불가)</div>
                <input style={inputStyle()} value={addDraft.id} onChange={(e) => setAddDraft((p) => ({ ...p, id: e.target.value }))} />
              </div>
              <div>
                <div style={labelStyle()}>name (필수)</div>
                <input style={inputStyle()} value={addDraft.name} onChange={(e) => setAddDraft((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <div style={labelStyle()}>status</div>
                <input style={inputStyle()} value={addDraft.status} onChange={(e) => setAddDraft((p) => ({ ...p, status: e.target.value }))} />
              </div>
              <div>
                <div style={labelStyle()}>priority</div>
                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input type="checkbox" checked={addDraft.priority} onChange={(e) => setAddDraft((p) => ({ ...p, priority: e.target.checked }))} />
                  <span style={{ fontWeight: 800 }}>{addDraft.priority ? "true" : "false"}</span>
                </label>
              </div>

              <div>
                <div style={labelStyle()}>lat (필수)</div>
                <input style={inputStyle()} inputMode="decimal" value={addDraft.lat === null ? "" : String(addDraft.lat)} onChange={(e) => setAddDraft((p) => ({ ...p, lat: toNumberOrNull(e.target.value) }))} />
              </div>
              <div>
                <div style={labelStyle()}>lon (필수)</div>
                <input style={inputStyle()} inputMode="decimal" value={addDraft.lon === null ? "" : String(addDraft.lon)} onChange={(e) => setAddDraft((p) => ({ ...p, lon: toNumberOrNull(e.target.value) }))} />
              </div>
            </div>

            <div style={sectionTitleStyle()}>기타</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
              <div>
                <div style={labelStyle()}>frequency_per_week</div>
                <input
                  style={inputStyle()}
                  inputMode="numeric"
                  value={String(addDraft.frequency_per_week)}
                  onChange={(e) => setAddDraft((p) => ({ ...p, frequency_per_week: toNumberOrFallback(e.target.value, p.frequency_per_week) }))}
                />
              </div>
              <div>
                <div style={labelStyle()}>service_minutes</div>
                <input style={inputStyle()} inputMode="numeric" value={addDraft.service_minutes === null ? "" : String(addDraft.service_minutes)} onChange={(e) => setAddDraft((p) => ({ ...p, service_minutes: toNumberOrNull(e.target.value) }))} />
              </div>
              <div>
                <div style={labelStyle()}>dependent_mode</div>
                <input style={inputStyle()} value={addDraft.dependent_mode} onChange={(e) => setAddDraft((p) => ({ ...p, dependent_mode: e.target.value }))} />
              </div>
              <div>
                <div style={labelStyle()}>day_required_mask</div>
                <input style={inputStyle()} inputMode="numeric" value={String(addDraft.day_required_mask)} onChange={(e) => setAddDraft((p) => ({ ...p, day_required_mask: toNumberOrFallback(e.target.value, p.day_required_mask) }))} />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <div style={labelStyle()}>address_text</div>
                <textarea style={{ ...inputStyle(), minHeight: 60 }} value={addDraft.address_text ?? ""} onChange={(e) => setAddDraft((p) => ({ ...p, address_text: e.target.value || null }))} />
              </div>

              <div>
                <div style={labelStyle()}>parent_id</div>
                <input style={inputStyle()} value={addDraft.parent_id ?? ""} onChange={(e) => setAddDraft((p) => ({ ...p, parent_id: e.target.value || null }))} />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <div style={labelStyle()}>access_method</div>
                <input style={inputStyle()} value={addDraft.access_method ?? ""} onChange={(e) => setAddDraft((p) => ({ ...p, access_method: e.target.value || null }))} />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <div style={labelStyle()}>access_code</div>
                <textarea style={{ ...inputStyle(), minHeight: 70 }} value={addDraft.access_code ?? ""} onChange={(e) => setAddDraft((p) => ({ ...p, access_code: e.target.value || null }))} />
              </div>

              <div>
                <div style={labelStyle()}>manager_name</div>
                <input style={inputStyle()} value={addDraft.manager_name ?? ""} onChange={(e) => setAddDraft((p) => ({ ...p, manager_name: e.target.value || null }))} />
              </div>
              <div>
                <div style={labelStyle()}>manager_phone</div>
                <input style={inputStyle()} value={addDraft.manager_phone ?? ""} onChange={(e) => setAddDraft((p) => ({ ...p, manager_phone: e.target.value || null }))} />
              </div>

              {/* ✅ NEW: parking_info */}
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={labelStyle()}>parking_info (주차정보)</div>
                <textarea
                  style={{ ...inputStyle(), minHeight: 90 }}
                  value={addDraft.parking_info ?? ""}
                  onChange={(e) => setAddDraft((p) => ({ ...p, parking_info: e.target.value || null }))}
                />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <div style={labelStyle()}>notes</div>
                <textarea style={{ ...inputStyle(), minHeight: 110 }} value={addDraft.notes ?? ""} onChange={(e) => setAddDraft((p) => ({ ...p, notes: e.target.value || null }))} />
              </div>
            </div>

            <div style={sectionTitleStyle()}>요일 요구</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
              {([
                ["req_mon", "Mon"],
                ["req_tue", "Tue"],
                ["req_wed", "Wed"],
                ["req_thu", "Thu"],
                ["req_fri", "Fri"],
                ["req_sat", "Sat"],
                ["req_sun", "Sun"],
              ] as const).map(([key, label]) => (
                <label key={key} style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, border: "1px solid #eee", borderRadius: 10 }}>
                  <input type="checkbox" checked={(addDraft as any)[key]} onChange={(e) => setAddDraft((p) => ({ ...p, [key]: e.target.checked } as any))} />
                  <span style={{ fontWeight: 800 }}>{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}