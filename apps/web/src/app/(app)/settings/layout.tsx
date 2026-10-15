/** Personal account, security and workspace settings. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <header style={{ marginBottom: 32 }}>
        <h1 className="h1">Configurações</h1>
      </header>
      {children}
    </div>
  );
}
