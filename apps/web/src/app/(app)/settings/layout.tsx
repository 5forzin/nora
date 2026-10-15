/** Personal account, security, workspace and usage settings. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="page settings-root" style={{ maxWidth: 1080 }}>
      <style>{SETTINGS_STYLES}</style>
      <header style={{ marginBottom: 32 }}>
        <h1 className="h1">Configurações</h1>
      </header>
      {children}
    </div>
  );
}

const SETTINGS_STYLES = `
.settings-root .set-layout { display: flex; gap: 40px; align-items: flex-start; }
.settings-root .set-nav { width: 160px; flex-shrink: 0; display: flex; flex-direction: column; gap: 1px; position: sticky; top: 24px; }
.settings-root .set-nav a { padding: 7px 10px; border-radius: 7px; font-size: 13px; color: var(--muted); transition: background 120ms ease, color 120ms ease; }
.settings-root .set-nav a:hover { background: var(--sidebar); color: var(--ink); }
.settings-root .set-nav a.is-active { background: var(--accent-soft); color: var(--accent-ink); font-weight: 500; }
.settings-root .set-pane { flex: 1; min-width: 0; width: 100%; max-width: 560px; }
.settings-root .set-pane--wide { max-width: none; }
@media (max-width: 860px) {
  .settings-root .set-layout { flex-direction: column; gap: 20px; }
  .settings-root .set-nav { width: 100%; flex-direction: row; flex-wrap: wrap; gap: 4px; position: static; }
  .settings-root .set-nav a { border: 1px solid var(--border); border-radius: 999px; padding: 6px 13px; font-size: 12.5px; }
  .settings-root .set-nav a.is-active { border-color: transparent; }
}
`;
