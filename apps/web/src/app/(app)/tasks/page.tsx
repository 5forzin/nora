"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  listTasks,
  updateTask,
  type TaskListItemDto,
  type TaskStatus,
  ApiRequestError,
} from "@/lib/api/client";
// The two label maps live with the exporter, not here: a status has to read the same in the
// exported file as on this screen, and two copies of one map is how that stops being true.
import { PRIORITY_LABEL, STATUS_LABEL } from "@/lib/report/tasks-export";
import TasksExportMenu from "./export-menu";
import { useWorkspaceAccess } from "@/components/enterprise/workspace-provider";

const FILTERS: { value: TaskStatus | "ALL"; label: string }[] = [
  { value: "ALL", label: "Todas" },
  { value: "OPEN", label: "Abertas" },
  { value: "IN_PROGRESS", label: "Em andamento" },
  { value: "DONE", label: "Concluídas" },
];
const PRIORITY_COLOR: Record<string, string> = { HIGH: "var(--danger)", MEDIUM: "var(--warn)", LOW: "var(--muted)" };

// Dates in pt-BR (Intl, no date-fns). Keeps the prototype's tone: vence hoje /
// vence amanhã / venceu DD/mês / vence DD/mês.
function dueDate(iso: string): Date {
  // A calendar deadline has no UTC offset; UTC parsing shifts it to yesterday in Brazil.
  return new Date(`${iso}T00:00:00`);
}

function fmtShortDate(iso: string): string {
  return dueDate(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function relativeDue(iso: string): string {
  const d = dueDate(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "vence hoje";
  if (diff === 1) return "vence amanhã";
  if (diff < 0) return `venceu ${fmtShortDate(iso)}`;
  return `vence ${fmtShortDate(iso)}`;
}

function isLate(t: TaskListItemDto): boolean {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Boolean(t.dueDate) && dueDate(t.dueDate as string) < today && t.status !== "DONE";
}

export default function TasksPage() {
  const { access, loading } = useWorkspaceAccess();
  const canWrite = access?.permissions?.writeTasks === true;
  const canCreateMeetings = access?.permissions?.createMeetings === true;
  if (loading) return <div className="page" role="status">Carregando acesso…</div>;
  if (!access?.permissions?.readTasks) return <div className="page"><h1 className="h1">Action items</h1><p className="lede">Você não tem permissão para consultar tarefas neste workspace.</p></div>;
  return <TasksContent canWrite={canWrite} canCreateMeetings={canCreateMeetings} />;
}

function TasksContent({ canWrite, canCreateMeetings }: { canWrite: boolean; canCreateMeetings: boolean }) {
  const [items, setItems] = useState<TaskListItemDto[]>([]);
  const [filter, setFilter] = useState<TaskStatus | "ALL">("ALL");
  const [page, setPage] = useState(0);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listTasks({ status: filter === "ALL" ? undefined : filter, page, size: 100 })
      .then((r) => {
        if (!active) return;
        const lastPage = Math.max(0, r.totalPages - 1);
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setItems(r.items);
        setTotalItems(r.totalItems);
        setTotalPages(r.totalPages);
      })
      .catch((e) => {
        if (!active) return;
        setItems([]);
        setTotalItems(0);
        setTotalPages(0);
        setError(e instanceof ApiRequestError ? e.message : "Falha ao carregar action items.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filter, page, revision]);

  // §3.11 — consistent filter: on a status change with an active filter, the
  // item leaves the list if it stops matching the selected filter.
  function applyLocalUpdate(curr: TaskListItemDto[], updated: TaskListItemDto): TaskListItemDto[] {
    const mapped = curr.map((x) => (x.id === updated.id ? updated : x));
    if (filter === "ALL") return mapped;
    return mapped.filter((x) => x.status === filter);
  }

  async function changeStatus(t: TaskListItemDto, next: TaskStatus) {
    if (t.status === next) return;
    setSaving(true);
    const previous = items;
    const optimistic: TaskListItemDto = { ...t, status: next };
    setItems((curr) => applyLocalUpdate(curr, optimistic));
    try {
      const updated = await updateTask(t.id, { status: next });
      setItems((curr) => applyLocalUpdate(curr, updated));
      setRevision((value) => value + 1);
    } catch (e) {
      setItems(previous);
      setError(e instanceof ApiRequestError ? e.message : "Falha ao atualizar status.");
    } finally {
      setSaving(false);
    }
  }

  // The extraction guesses the due date and it drives the Flows follow-up scheduler, so the user
  // has to be able to both correct and remove it. An emptied input sends "" — the API's documented
  // way to clear the column. Sending undefined would mean "leave it alone" instead.
  async function changeDueDate(t: TaskListItemDto, value: string) {
    if ((t.dueDate ?? "") === value) return;
    setSaving(true);
    const previous = items;
    const optimistic: TaskListItemDto = { ...t, dueDate: value === "" ? undefined : value };
    setItems((curr) => curr.map((x) => (x.id === t.id ? optimistic : x)));
    try {
      const updated = await updateTask(t.id, { dueDate: value });
      setItems((curr) => curr.map((x) => (x.id === t.id ? updated : x)));
      setRevision((value) => value + 1);
    } catch (e) {
      setItems(previous);
      setError(e instanceof ApiRequestError ? e.message : "Falha ao atualizar a data.");
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(t: TaskListItemDto) {
    setEditingId(t.id);
    setEditTitle(t.title);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditTitle("");
  }
  async function saveEdit(t: TaskListItemDto) {
    const trimmed = editTitle.trim();
    if (!trimmed || trimmed === t.title) {
      cancelEdit();
      return;
    }
    const previous = items;
    setSaving(true);
    setItems((curr) => curr.map((x) => (x.id === t.id ? { ...x, title: trimmed } : x)));
    cancelEdit();
    try {
      const updated = await updateTask(t.id, { title: trimmed });
      setItems((curr) => curr.map((x) => (x.id === t.id ? updated : x)));
      setRevision((value) => value + 1);
    } catch (e) {
      setItems(previous);
      setError(e instanceof ApiRequestError ? e.message : "Falha ao atualizar título.");
    } finally {
      setSaving(false);
    }
  }

  const activeFilterLabel = FILTERS.find((f) => f.value === filter)?.label ?? "Todas";

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <header
        style={{
          marginBottom: 22,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1 className="h1">Action items</h1>
          <p className="lede" style={{ marginTop: 8 }}>
            {canWrite ? "Tarefas extraídas das suas reuniões. Atualize o status conforme avança." : "Tarefas extraídas das reuniões do workspace."}
          </p>
        </div>
        <TasksExportMenu
          status={filter === "ALL" ? undefined : filter}
          totalItems={totalItems}
          filterLabel={activeFilterLabel}
          disabled={loading || saving}
          onError={setError}
        />
      </header>

      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        {FILTERS.map((f) => {
          const active = filter === f.value;
          const count = active && !loading ? totalItems : undefined;
          return (
            <button
              key={f.value}
              type="button"
              className={`filter-pill${active ? " is-active" : ""}`}
              aria-pressed={active}
              disabled={saving}
              onClick={() => { setFilter(f.value); setPage(0); cancelEdit(); }}
            >
              {f.label}
              {typeof count === "number" && <span style={{ opacity: 0.65, marginLeft: 5 }}> {count}</span>}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="notice notice--danger" role="alert" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading || saving} onClick={() => setRevision((value) => value + 1)}>Tentar de novo</button>
        </div>
      )}

      {loading ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--canvas)" }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "14px 16px",
                borderTop: i === 0 ? "none" : "1px solid var(--border)",
              }}
            >
              <div className="skel" style={{ width: 16, height: 16, borderRadius: 5, marginTop: 3, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="skel" style={{ width: "70%", height: 14 }} />
                <div className="skel" style={{ width: "40%", height: 11, marginTop: 8 }} />
              </div>
            </div>
          ))}
        </div>
      ) : error && items.length === 0 ? null : items.length === 0 ? (
        <div style={{ border: "1px dashed var(--border-strong)", borderRadius: 14, padding: "48px 24px", textAlign: "center" }}>
          {filter === "ALL" ? (
            <>
              <p style={{ fontSize: 14, color: "var(--ink)", margin: "0 0 4px" }}>Nenhum action item por aqui.</p>
              {canCreateMeetings && <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>
                Envie uma reunião pra Nora extrair os próximos passos automaticamente.
              </p>}
              {canCreateMeetings && <div style={{ marginTop: 16 }}>
                <Link className="btn btn-primary btn-sm" href={"/meetings/upload" as Route}>
                  Enviar reunião
                </Link>
              </div>}
            </>
          ) : (
            <>
              <p style={{ fontSize: 14, color: "var(--ink)", margin: "0 0 4px" }}>Nada com esse status.</p>
              <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>
                Troque o filtro ou volte pra “Todas”.
              </p>
            </>
          )}
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--canvas)" }}>
          {items.map((t, idx) => {
            const done = t.status === "DONE";
            const late = isLate(t);
            return (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "14px 16px",
                  borderTop: idx === 0 ? "none" : "1px solid var(--border)",
                }}
              >
                {canWrite && <input
                  type="checkbox"
                  checked={done}
                  disabled={saving}
                  onChange={(e) => changeStatus(t, e.target.checked ? "DONE" : "OPEN")}
                  style={{ marginTop: 3, accentColor: "var(--ink)", width: 16, height: 16, flexShrink: 0, cursor: "pointer" }}
                  aria-label={`Marcar "${t.title}" como ${done ? "aberta" : "concluída"}`}
                />}

                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingId === t.id ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <input
                        autoFocus
                        className="input"
                        value={editTitle}
                        disabled={saving}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit(t);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        style={{ flex: 1, minWidth: 200, fontSize: 14, padding: "5px 9px" }}
                      />
                      <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void saveEdit(t)}>
                        Salvar
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={cancelEdit}>
                        Cancelar
                      </button>
                    </div>
                  ) : (
                    <>
                      <p
                        style={{
                          fontSize: 14,
                          margin: 0,
                          lineHeight: 1.4,
                          color: done ? "var(--muted)" : "var(--ink)",
                          textDecoration: done ? "line-through" : "none",
                        }}
                      >
                        {t.title}
                      </p>
                      <div
                        style={{
                          marginTop: 5,
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: 10,
                          fontSize: 11.5,
                          color: "var(--muted)",
                        }}
                      >
                        <Link
                          href={`/meetings/${t.meetingId}` as Route}
                          style={{ color: "var(--muted)", textDecoration: "underline", textUnderlineOffset: 2 }}
                        >
                          {t.meetingTitle}
                        </Link>
                        <span style={{ color: PRIORITY_COLOR[t.priority] ?? "var(--muted)" }}>
                          {PRIORITY_LABEL[t.priority] ?? t.priority}
                        </span>
                        {t.assignee && <span>{t.assignee}</span>}
                        {t.dueDate && (
                          <span style={{ color: late ? "var(--danger)" : "var(--muted)" }}>{relativeDue(t.dueDate)}</span>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {canWrite ? <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <input
                    type="date"
                    className="input"
                    value={t.dueDate ?? ""}
                    disabled={saving}
                    onChange={(e) => void changeDueDate(t, e.target.value)}
                    style={{ fontSize: 12.5, padding: "4px 8px", borderRadius: 7 }}
                    aria-label={`Alterar data de vencimento de "${t.title}"`}
                    title="Data de vencimento (vazio remove)"
                  />
                  <select
                    className="select"
                    value={t.status}
                    disabled={saving}
                    onChange={(e) => changeStatus(t, e.target.value as TaskStatus)}
                    style={{ fontSize: 12.5, padding: "5px 9px", borderRadius: 7 }}
                    aria-label="Alterar status"
                  >
                    <option value="OPEN">{STATUS_LABEL.OPEN}</option>
                    <option value="IN_PROGRESS">{STATUS_LABEL.IN_PROGRESS}</option>
                    <option value="DONE">{STATUS_LABEL.DONE}</option>
                  </select>
                  {editingId !== t.id && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => beginEdit(t)}
                      title="Editar título"
                      style={{
                        fontFamily: "var(--sans)",
                        fontSize: 12.5,
                        color: "var(--muted)",
                        background: "transparent",
                        border: "1px solid var(--border)",
                        borderRadius: 7,
                        padding: "5px 9px",
                        cursor: "pointer",
                      }}
                    >
                      Editar
                    </button>
                  )}
                </div> : <span className="chip">{STATUS_LABEL[t.status] ?? t.status}</span>}
              </div>
            );
          })}
        </div>
      )}
      {totalItems > 0 && (
        <nav aria-label="Paginação de tarefas" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 20 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Página {page + 1} de {Math.max(1, totalPages)} · {totalItems} tarefas
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={loading || saving || page === 0} onClick={() => { setPage((value) => value - 1); cancelEdit(); }}>Anterior</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={loading || saving || page + 1 >= totalPages} onClick={() => { setPage((value) => value + 1); cancelEdit(); }}>Próxima</button>
          </div>
        </nav>
      )}
    </div>
  );
}
