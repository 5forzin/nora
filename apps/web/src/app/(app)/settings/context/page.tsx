"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiRequestError,
  changePassword,
  deleteAccount,
  getMe,
  getTenant,
  logoutAllSessions,
  renameTenant,
  resendVerificationEmail,
  updateMe,
  type MeResponse,
  type TenantInfo,
} from "@/lib/api/client";
import {
  clearLocalSession,
  getCurrentUser,
  updateSessionUser,
  type SessionUser,
} from "@/lib/auth";
import { Avatar } from "@/components/core/avatar";
import { useWorkspaceAccess } from "@/components/enterprise/workspace-provider";

// Personal settings remain separate from the Enterprise workspace.
const SECTIONS = ["conta", "seguranca", "workspace"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABELS: Record<Section, string> = {
  conta: "Conta",
  seguranca: "Segurança",
  workspace: "Workspace",
};

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── password strength (port of the prototype §4.3) ──
const STRENGTH_LABELS = ["—", "Fraca", "Razoável", "Boa", "Forte"];
const STRENGTH_COLORS = [
  "var(--chip)",
  "var(--danger)",
  "var(--warn)",
  "var(--accent)",
  "var(--success)",
];

function strengthOf(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

export default function SettingsPage() {
  const { access } = useWorkspaceAccess();
  const canReadWorkspace = access?.permissions?.readWorkspace === true;
  // ── internal hub navigation (hash) ──
  const [section, setSection] = useState<Section>("conta");
  const activeSection = section === 'workspace' && !canReadWorkspace ? 'conta' : section;

  useEffect(() => {
    const fromHash = (location.hash || "").slice(1) as Section;
    if (SECTIONS.includes(fromHash)) setSection(fromHash);
  }, []);

  function goTo(next: Section) {
    setSection(next);
    if (typeof history !== "undefined") {
      history.replaceState(null, "", `#${next}`);
    }
  }

  return (
    <div className="set-layout">
      <style>{SET_STYLES}</style>

      <nav className="set-nav" aria-label="Seções de configurações">
        {SECTIONS.filter((s) => s !== 'workspace' || canReadWorkspace).map((s) => (
          <a
            key={s}
            href={`#${s}`}
            className={s === activeSection ? "is-active" : undefined}
            aria-current={s === activeSection ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              goTo(s);
            }}
          >
            {SECTION_LABELS[s]}
          </a>
        ))}
      </nav>

      <div className="set-pane">
        {activeSection === "conta" && <AccountSection />}
        {activeSection === "seguranca" && <SecuritySection />}
        {activeSection === "workspace" && <WorkspaceSection canRename={access?.permissions?.renameWorkspace === true} />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Account — REAL profile (GET /auth/me + PATCH /users/me). The
   nora_user cookie is the instant fallback while /auth/me loads;
   /auth/me is the source of truth (has emailVerified, the cookie
   doesn't). Saving updates the cookie so the sidebar reflects it now.
   ───────────────────────────────────────────────────────────── */
function AccountSection() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [fallback, setFallback] = useState<SessionUser | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  // Does not overwrite what the user already typed when /auth/me resolves.
  const dirtyRef = useRef(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);

  useEffect(() => {
    const u = getCurrentUser();
    setFallback(u);
    if (u?.displayName) {
      setDisplayName((prev) => (dirtyRef.current ? prev : u.displayName));
    }
    let cancelled = false;
    getMe()
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        setDisplayName((prev) => (dirtyRef.current ? prev : m.displayName));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiRequestError ? err.message : "Falha ao carregar o perfil.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Discreet success: the "Salvo" disappears on its own after a few seconds.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  const email = me?.email ?? fallback?.email ?? "";
  const loading = me === null && fallback === null && loadError === null;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const name = displayName.trim();
    if (!name) {
      setError("O nome de exibição não pode ficar vazio.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateMe({ displayName: name });
      setMe(updated);
      setDisplayName(updated.displayName);
      dirtyRef.current = false;
      // Reflects in the sidebar/orb immediately (nora_user cookie + event).
      updateSessionUser({ displayName: updated.displayName });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Falha ao salvar as alterações.");
    } finally {
      setSaving(false);
    }
  }

  async function onResend() {
    if (!email) return;
    setResending(true);
    setResendNote(null);
    try {
      await resendVerificationEmail(email);
      // Always 202 (anti-enumeration) — single message in any case.
      setResendNote(
        "Se este e-mail estiver cadastrado e ainda não verificado, enviamos um novo link. Confira sua caixa de entrada.",
      );
    } catch {
      setResendNote("Não foi possível reenviar agora. Tente de novo em instantes.");
    } finally {
      setResending(false);
    }
  }

  if (loading) {
    return (
      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Perfil</h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="skel" style={{ width: 44, height: 44, borderRadius: "50%" }} />
          <div className="skel" style={{ height: 38, maxWidth: 320 }} />
          <div className="skel" style={{ height: 38, maxWidth: 440 }} />
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="sec-label">Perfil</h2>
      </div>
      <form onSubmit={onSave} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar seed={email} size={44} />
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
            Seu avatar é gerado a partir da conta.
            <br />
          </div>
        </div>

        {loadError && <div className="notice notice--danger">{loadError}</div>}

        <div className="field">
          <label className="field-label" htmlFor="acc-name">
            Nome de exibição
          </label>
          <input
            className="input"
            id="acc-name"
            value={displayName}
            onChange={(e) => {
              dirtyRef.current = true;
              setDisplayName(e.target.value);
            }}
            style={{ maxWidth: 320 }}
          />
          <div className="field-help">
            É como a Nora se refere a você nas análises e no chat.
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="acc-email">
            E-mail
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input
              className="input"
              id="acc-email"
              value={email}
              disabled
              style={{
                flex: 1,
                minWidth: 280,
                maxWidth: 440,
                color: "var(--muted)",
                background: "var(--sidebar)",
              }}
            />
            {me === null ? (
              <span className="skel" style={{ width: 80, height: 20, borderRadius: 999 }} />
            ) : me.emailVerified ? (
              <span
                className="chip"
                style={{ background: "var(--accent-soft)", color: "var(--success)" }}
              >
                Verificado
              </span>
            ) : (
              <>
                <span className="chip">Não verificado</span>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  disabled={resending}
                  onClick={onResend}
                >
                  {resending ? "Enviando…" : "Reenviar verificação"}
                </button>
              </>
            )}
          </div>
          {resendNote && (
            <div className="notice notice--accent" style={{ marginTop: 4 }}>
              {resendNote}
            </div>
          )}
          <div className="field-help">
            O e-mail é o identificador da conta e não pode ser trocado no Core.
          </div>
        </div>

        {error && <div className="notice notice--danger">{error}</div>}

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
            {saving ? "Salvando…" : "Salvar alterações"}
          </button>
          {saved && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "var(--success)",
                fontSize: 12.5,
              }}
            >
              <CheckIcon />
              Salvo
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────
   Security — REAL password change (POST /auth/password/change: revokes
   every session and reissues cookies for the current device) + log out
   of all devices (POST /auth/logout-all). The strength meter stays
   client-side (UX); the real policy belongs to the backend.
   ───────────────────────────────────────────────────────────── */
function SecuritySection() {
  const router = useRouter();
  const [pwCur, setPwCur] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConf, setPwConf] = useState("");
  const [changing, setChanging] = useState(false);
  /** Error specific to the "Senha atual" field (401 INVALID_CREDENTIALS). */
  const [curError, setCurError] = useState<string | null>(null);
  /** General error (400 policy etc.) — message from the backend. */
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const strength = useMemo(() => strengthOf(pwNew), [pwNew]);
  const mismatch = pwConf.length > 0 && pwConf !== pwNew;
  const canSubmit = pwCur.length > 0 && pwNew.length > 0 && pwNew === pwConf && !changing;

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setChanging(true);
    setCurError(null);
    setPwError(null);
    setPwSuccess(false);
    try {
      await changePassword({ currentPassword: pwCur, newPassword: pwNew });
      // 204: backend revoked ALL sessions but reissued cookies for here —
      // this device stays logged in.
      setPwCur("");
      setPwNew("");
      setPwConf("");
      setPwSuccess(true);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setCurError("Senha atual incorreta.");
      } else if (err instanceof ApiRequestError) {
        setPwError(err.message);
      } else {
        setPwError("Falha ao atualizar a senha.");
      }
    } finally {
      setChanging(false);
    }
  }

  async function onLogoutAll() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logoutAllSessions();
      // Backend already cleared the httpOnly cookies — only local state is left.
      clearLocalSession();
      router.replace("/auth/login" as Route);
    } catch (err) {
      setLogoutError(
        err instanceof ApiRequestError ? err.message : "Falha ao encerrar as sessões.",
      );
      setLoggingOut(false);
    }
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Trocar senha</h2>
        </div>
        <form
          onSubmit={onChangePassword}
          style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 360 }}
        >
          <div className="field">
            <label className="field-label" htmlFor="pw-cur">
              Senha atual
            </label>
            <input
              className="input"
              id="pw-cur"
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              value={pwCur}
              onChange={(e) => {
                setPwCur(e.target.value);
                if (curError) setCurError(null);
              }}
            />
            {curError && <div className="field-help is-err">{curError}</div>}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="pw-new">
              Nova senha
            </label>
            <input
              className="input"
              id="pw-new"
              type="password"
              placeholder="••••••••"
              autoComplete="new-password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
            />
            <div className="pw-bars">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  style={{ background: i < strength ? STRENGTH_COLORS[strength] : "var(--chip)" }}
                />
              ))}
            </div>
            <div className="pw-meta">
              <span>{STRENGTH_LABELS[strength]}</span>
              <span>{pwNew.length} caracteres</span>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="pw-conf">
              Confirme a nova senha
            </label>
            <input
              className="input"
              id="pw-conf"
              type="password"
              placeholder="••••••••"
              autoComplete="new-password"
              value={pwConf}
              onChange={(e) => setPwConf(e.target.value)}
            />
            {mismatch && <div className="field-help is-err">As senhas não coincidem.</div>}
          </div>

          {pwError && <div className="notice notice--danger">{pwError}</div>}
          {pwSuccess && (
            <div className="notice notice--accent">
              Senha atualizada. As outras sessões foram encerradas — este dispositivo continua
              conectado.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={!canSubmit}>
              {changing ? "Atualizando…" : "Atualizar senha"}
            </button>
          </div>
        </form>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Sessões</h2>
        </div>
        <div
          className="card"
          style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}
        >
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>Sair de todos os dispositivos</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 3 }}>
              Encerra todas as sessões ativas, inclusive esta. Você precisará entrar de novo.
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={loggingOut}
            onClick={() => setLogoutConfirm(true)}
          >
            Sair de tudo
          </button>
        </div>
        {logoutConfirm && (
          <div className="notice" style={{ marginTop: 10 }}>
            Tem certeza? Todas as sessões serão encerradas agora — inclusive esta.
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button
                className="btn btn-primary btn-sm"
                type="button"
                disabled={loggingOut}
                onClick={onLogoutAll}
              >
                {loggingOut ? "Encerrando…" : "Sim, sair de tudo"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                disabled={loggingOut}
                onClick={() => {
                  setLogoutConfirm(false);
                  setLogoutError(null);
                }}
              >
                Cancelar
              </button>
            </div>
            {logoutError && (
              <div className="field-help is-err" style={{ marginTop: 8 }}>
                {logoutError}
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────
   Workspace — REAL name + slug + plan (GET /tenant + PUT
   /tenant/name) and REAL danger zone (DELETE /users/me: wipes
   account + workspace + all data, LGPD). Typed-confirm of the
   e-mail is the 1st friction step; the password is the real confirm.
   ───────────────────────────────────────────────────────────── */
function formatPlan(plan: string): string {
  const p = plan.trim();
  if (!p) return "Core";
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

function WorkspaceSection({ canRename }: { canRename: boolean }) {
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  // Does not overwrite what the user already typed when GET /tenant resolves.
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const [delInput, setDelInput] = useState("");
  const [delPw, setDelPw] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  useEffect(() => {
    setEmail(getCurrentUser()?.email ?? "");
    let cancelled = false;
    getTenant()
      .then((t) => {
        if (cancelled) return;
        setTenant(t);
        setWsName((prev) => (dirtyRef.current ? prev : t.name));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiRequestError ? err.message : "Falha ao carregar o workspace.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Discreet success: the "Salvo" disappears on its own after a few seconds.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  const tenantLoading = tenant === null && loadError === null;
  const delMatches = email.length > 0 && delInput.trim().toLowerCase() === email.toLowerCase();
  const canDelete = delMatches && delPw.length > 0 && !deleting;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canRename) return;
    const name = wsName.trim();
    if (!name) {
      setError("O nome do workspace não pode ficar vazio.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await renameTenant({ name });
      setTenant(updated);
      setWsName(updated.name);
      dirtyRef.current = false;
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Falha ao renomear o workspace.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!canDelete) return;
    setDeleting(true);
    setDelError(null);
    try {
      await deleteAccount({ password: delPw });
      // 204: account + workspace + data wiped; backend already cleared the cookies.
      clearLocalSession();
      window.location.assign("/");
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setDelError("Senha incorreta.");
      } else if (err instanceof ApiRequestError) {
        // 409 ACCOUNT_TENANT_SHARED and the like: the backend message explains.
        setDelError(err.message);
      } else {
        setDelError("Falha ao excluir a conta. Tente de novo.");
      }
      setDeleting(false);
    }
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Workspace</h2>
        </div>
        <form onSubmit={onSave} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {loadError && <div className="notice notice--danger">{loadError}</div>}

          <div className="field">
            <label className="field-label" htmlFor="ws-name">
              Nome do workspace
            </label>
            {tenantLoading ? (
              <div className="skel" style={{ height: 38, maxWidth: 320 }} />
            ) : (
              <input
                className="input"
                id="ws-name"
                readOnly={!canRename}
                value={wsName}
                onChange={(e) => {
                  dirtyRef.current = true;
                  setWsName(e.target.value);
                }}
                style={{ maxWidth: 320 }}
              />
            )}
            <div className="field-help">
              {tenant ? (
                <>
                  Endereço interno (slug): <strong>{tenant.slug}</strong> — fixo, definido no
                  cadastro.
                </>
              ) : (
                "Definido no cadastro."
              )}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Plano</span>
            {tenantLoading ? (
              <div className="skel" style={{ height: 64, maxWidth: 460, borderRadius: 12 }} />
            ) : (
              <div
                className="card"
                style={{ display: "flex", alignItems: "center", gap: 14, maxWidth: 460 }}
              >
                <span className="plan-badge" style={{ fontSize: 11, padding: "3px 9px" }}>
                  {tenant ? formatPlan(tenant.plan) : "Core"}
                </span>
                <div style={{ flex: 1, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
                  {tenant?.plan === 'ENTERPRISE' ? 'Workspace de equipe com contexto compartilhado e gestão de acesso.' : 'Workspace pessoal para reuniões, chat, projetos e tarefas.'}
                </div>
              </div>
            )}
          </div>

          {error && <div className="notice notice--danger">{error}</div>}

          {canRename && <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              className="btn btn-primary btn-sm"
              type="submit"
              disabled={saving || tenantLoading}
            >
              {saving ? "Salvando…" : "Salvar alterações"}
            </button>
            {saved && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  color: "var(--success)",
                  fontSize: 12.5,
                }}
              >
                <CheckIcon />
                Salvo
              </span>
            )}
          </div>}
        </form>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Zona de perigo</h2>
        </div>
        <div className="danger-card">
          <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--danger)" }}>
            Excluir conta e todos os dados
          </div>
          <p
            style={{
              fontSize: 12.5,
              color: "var(--muted)",
              lineHeight: 1.55,
              margin: "6px 0 12px",
            }}
          >
            Apaga sua conta, o workspace e TUDO que está nele — reuniões, transcrições, análises,
            action items, sessões de chat e fluxos — definitivamente. É o seu direito pela LGPD
            (direito ao esquecimento) e não tem volta.
          </p>
          {!delOpen ? (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              style={{ color: "var(--danger)" }}
              onClick={() => setDelOpen(true)}
            >
              Quero excluir minha conta
            </button>
          ) : (
            <div
              style={{
                marginTop: 0,
                paddingTop: 14,
                borderTop: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink)",
                  lineHeight: 1.55,
                  marginBottom: 10,
                }}
              >
                Para confirmar, digite seu e-mail (<strong>{email || "seu e-mail"}</strong>):
              </div>
              <input
                className="input"
                placeholder="Digite seu e-mail"
                value={delInput}
                onChange={(e) => setDelInput(e.target.value)}
                style={{ width: "100%", maxWidth: 320, marginBottom: 10 }}
              />
              {delMatches && (
                <div className="field" style={{ maxWidth: 320, marginBottom: 10 }}>
                  <label className="field-label" htmlFor="del-pw">
                    Confirme com a sua senha
                  </label>
                  <input
                    className="input"
                    id="del-pw"
                    type="password"
                    placeholder="••••••••"
                    autoComplete="current-password"
                    value={delPw}
                    onChange={(e) => {
                      setDelPw(e.target.value);
                      if (delError) setDelError(null);
                    }}
                  />
                  <div className="field-help is-err">
                    Última etapa: a exclusão é imediata e irreversível.
                  </div>
                </div>
              )}
              {delError && (
                <div className="notice notice--danger" style={{ marginBottom: 10 }}>
                  {delError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn btn-danger btn-sm"
                  type="button"
                  disabled={!canDelete}
                  onClick={onDelete}
                >
                  {deleting ? "Excluindo…" : "Excluir definitivamente"}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  disabled={deleting}
                  onClick={() => {
                    setDelOpen(false);
                    setDelInput("");
                    setDelPw("");
                    setDelError(null);
                  }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────
   Company context — REAL LOGIC (GET/PUT /tenant/context).
   Re-skin only: design system classes, without touching the
   data/API flow.
   ───────────────────────────────────────────────────────────── */
/* ── hub-only styles (there is no class in components.css) ── */
const SET_STYLES = `
.set-layout { display: flex; gap: 40px; align-items: flex-start; }
.set-nav {
  width: 180px; flex-shrink: 0; display: flex; flex-direction: column; gap: 1px;
  position: sticky; top: 24px;
}
.set-nav a {
  padding: 7px 10px; border-radius: 7px; font-size: 13px; color: var(--muted);
  transition: background 120ms ease, color 120ms ease; cursor: pointer;
}
.set-nav a:hover { background: var(--sidebar); color: var(--ink); }
.set-nav a.is-active { background: var(--accent-soft); color: var(--accent-ink); font-weight: 500; }
.set-pane { flex: 1; min-width: 0; max-width: 560px; }
@media (max-width: 860px) {
  .set-layout { flex-direction: column; gap: 20px; }
  .set-nav { width: 100%; flex-direction: row; flex-wrap: wrap; gap: 4px; position: static; }
  .set-nav a { border: 1px solid var(--border); border-radius: 999px; padding: 6px 13px; font-size: 12.5px; }
  .set-nav a.is-active { border-color: transparent; }
}
.pw-bars { display: flex; gap: 4px; margin-top: 8px; }
.pw-bars span { height: 3px; flex: 1; border-radius: 2px; background: var(--chip); transition: background 160ms ease; }
.pw-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 5px; }
.danger-card { border: 1px solid var(--danger); border-radius: 12px; padding: 16px 18px; background: var(--chip); }
`;
