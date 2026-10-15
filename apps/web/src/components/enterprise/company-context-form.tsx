'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  getTenantContext,
  getTenantContextVersion,
  listTenantContextVersions,
  upsertTenantContext,
  type TenantContextDto,
  type TenantContextVersionDto,
} from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';

interface ProductForm {
  name: string;
  description: string;
  keyDifferentiators: string; // newline-separated string
}

interface FormState {
  companyName: string;
  industry: string;
  valueProposition: string;
  idealCustomerProfile: string;
  competitors: string;
  objectionHandling: string;
  products: ProductForm[];
}

const EMPTY_PRODUCT: ProductForm = { name: '', description: '', keyDifferentiators: '' };

const EMPTY_FORM: FormState = {
  companyName: '',
  industry: '',
  valueProposition: '',
  idealCustomerProfile: '',
  competitors: '',
  objectionHandling: '',
  products: [],
};

function fromDto(dto: TenantContextDto): FormState {
  return {
    companyName: dto.companyName ?? '',
    industry: dto.industry ?? '',
    valueProposition: dto.valueProposition ?? '',
    idealCustomerProfile: dto.idealCustomerProfile ?? '',
    competitors: (dto.competitors ?? []).join('\n'),
    objectionHandling: (dto.objectionHandling ?? []).join('\n'),
    products: (dto.products ?? []).map((p) => ({
      name: p.name,
      description: p.description ?? '',
      keyDifferentiators: (p.keyDifferentiators ?? []).join('\n'),
    })),
  };
}

function splitLines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

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

export default function CompanyContextForm({ canEdit = true }: { canEdit?: boolean }) {
  const [document, setDocument] = useState<TenantContextDto | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── history (US31) ──
  const [versions, setVersions] = useState<TenantContextVersionDto[]>([]);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [openDocument, setOpenDocument] = useState<TenantContextDto | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const versionRequestRef = useRef(0);

  // Reloaded after every successful save, because a save is exactly what adds an entry.
  async function reloadHistory() {
    try {
      const listing = await listTenantContextVersions();
      setVersions(listing.items);
      setCurrentVersion(listing.currentVersion);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(
        err instanceof ApiRequestError ? err.message : 'Falha ao carregar o histórico.',
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getTenantContext()
      .then((dto) => {
        if (!cancelled) {
          setForm(fromDto(dto));
          setDocument(dto);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          // not configured yet; carry on with an empty form
        } else {
          setLoadError(err instanceof Error ? err.message : 'Falha ao carregar contexto.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    void reloadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onOpenVersion(version: number) {
    const requestId = ++versionRequestRef.current;
    if (openVersion === version) {
      setOpenVersion(null);
      setOpenDocument(null);
      return;
    }
    setOpenVersion(version);
    setOpenDocument(null);
    setOpenLoading(true);
    try {
      const detail = await getTenantContextVersion(version);
      if (requestId !== versionRequestRef.current) return;
      setOpenDocument(detail.document);
      setHistoryError(null);
    } catch (err) {
      if (requestId !== versionRequestRef.current) return;
      setOpenVersion(null);
      setHistoryError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a versão.');
    } finally {
      if (requestId === versionRequestRef.current) setOpenLoading(false);
    }
  }

  // Restoring is deliberately not a server call: it fills the form and the user saves, which
  // appends a NEW version with them as the author. History is never rewritten.
  function onRestore(dto: TenantContextDto) {
    versionRequestRef.current += 1;
    setForm(fromDto(dto));
    setOpenVersion(null);
    setOpenDocument(null);
    setMessage(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((s) => ({ ...s, [key]: value }));
  }

  function updateProduct(idx: number, patch: Partial<ProductForm>) {
    setForm((s) => ({
      ...s,
      products: s.products.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    }));
  }

  function addProduct() {
    setForm((s) => ({ ...s, products: [...s.products, { ...EMPTY_PRODUCT }] }));
  }

  function removeProduct(idx: number) {
    setForm((s) => ({ ...s, products: s.products.filter((_, i) => i !== idx) }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      const saved = await upsertTenantContext({
        companyName: form.companyName.trim(),
        industry: form.industry.trim() || undefined,
        valueProposition: form.valueProposition.trim() || undefined,
        idealCustomerProfile: form.idealCustomerProfile.trim() || undefined,
        competitors: splitLines(form.competitors),
        objectionHandling: splitLines(form.objectionHandling),
        products: form.products
          .filter((p) => p.name.trim())
          .map((p) => ({
            name: p.name.trim(),
            description: p.description.trim() || undefined,
            keyDifferentiators: splitLines(p.keyDifferentiators),
          })),
      });
      setForm(fromDto(saved));
      setDocument(saved);
      setMessage('Contexto salvo com sucesso.');
      await reloadHistory();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar contexto.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Contexto da empresa</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="skel" style={{ height: 38, maxWidth: 320 }} />
          <div className="skel" style={{ height: 38 }} />
          <div className="skel" style={{ height: 72 }} />
        </div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="section">
        <p role="alert" className="notice notice--danger">
          Não foi possível carregar o contexto da empresa.
        </p>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          Tentar novamente
        </button>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="sec-label">Contexto da empresa</h2>
      </div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.6,
          margin: '0 0 18px',
        }}
      >
        A Nora usa este contexto ao analisar as reuniões do workspace.
      </p>

      {!canEdit && error && (
        <p role="alert" className="notice notice--danger">
          {error}
        </p>
      )}
      {!canEdit &&
        (document ? (
          <VersionPreview dto={document} />
        ) : (
          <p className="lede">Nenhum contexto cadastrado.</p>
        ))}
      {canEdit && (
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="field">
            <label className="field-label" htmlFor="ctx-company">
              Nome da empresa <span className="req">*</span>
            </label>
            <input
              className="input"
              id="ctx-company"
              required
              value={form.companyName}
              onChange={(e) => update('companyName', e.target.value)}
              style={{ maxWidth: 320 }}
            />
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="field">
              <label className="field-label" htmlFor="ctx-industry">
                Indústria
              </label>
              <input
                className="input"
                id="ctx-industry"
                value={form.industry}
                onChange={(e) => update('industry', e.target.value)}
                placeholder="ex.: Software B2B"
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="ctx-icp">
                ICP
              </label>
              <input
                className="input"
                id="ctx-icp"
                value={form.idealCustomerProfile}
                onChange={(e) => update('idealCustomerProfile', e.target.value)}
                placeholder="ex.: mid-market varejo"
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="ctx-value">
              Proposta de valor
            </label>
            <textarea
              className="textarea"
              id="ctx-value"
              rows={3}
              value={form.valueProposition}
              onChange={(e) => update('valueProposition', e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="ctx-comp">
              Concorrentes{' '}
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(um por linha)</span>
            </label>
            <textarea
              className="textarea"
              id="ctx-comp"
              rows={3}
              value={form.competitors}
              onChange={(e) => update('competitors', e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="ctx-obj">
              Objection handling{' '}
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(um por linha)</span>
            </label>
            <textarea
              className="textarea"
              id="ctx-obj"
              rows={3}
              value={form.objectionHandling}
              onChange={(e) => update('objectionHandling', e.target.value)}
            />
          </div>

          <div className="field">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="field-label">Produtos</span>
              <button className="btn btn-ghost btn-sm" type="button" onClick={addProduct}>
                + Adicionar produto
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {form.products.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
                  Nenhum produto cadastrado.
                </p>
              ) : (
                form.products.map((p, i) => (
                  <div
                    key={i}
                    className="card"
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    <div style={{ display: 'flex', gap: 8 }}>
                      <label className="field" style={{ flex: 1 }}>
                        <span className="field-label">Nome do produto</span>
                        <input
                          className="input"
                          value={p.name}
                          onChange={(e) => updateProduct(i, { name: e.target.value })}
                          style={{ flex: 1 }}
                        />
                      </label>
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={() => removeProduct(i)}
                        style={{ color: 'var(--danger)' }}
                      >
                        Remover
                      </button>
                    </div>
                    <label className="field">
                      <span className="field-label">Descrição</span>
                      <textarea
                        className="textarea"
                        rows={2}
                        value={p.description}
                        onChange={(e) => updateProduct(i, { description: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Diferenciais (um por linha)</span>
                      <textarea
                        className="textarea"
                        rows={2}
                        value={p.keyDifferentiators}
                        onChange={(e) => updateProduct(i, { keyDifferentiators: e.target.value })}
                      />
                    </label>
                  </div>
                ))
              )}
            </div>
          </div>

          {error && <div className="notice notice--danger">{error}</div>}
          {message && (
            <span
              className="saved-note is-show"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--success)',
              }}
            >
              <CheckIcon />
              {message}
            </span>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar contexto'}
            </button>
          </div>
        </form>
      )}

      {/* ── Version history (US31) ──
          The backend keeps every edit in tenant_context_versions. This block is the read path:
          a history nobody can consult is a backup, not an audit trail — which is exactly the
          state iam_policy_versions has been in since V006. */}
      <div style={{ marginTop: 30, paddingTop: 22, borderTop: '1px solid var(--border)' }}>
        <div className="section-head">
          <h2 className="sec-label">Histórico de versões</h2>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 14px' }}>
          Cada alteração do contexto vira uma versão. Salvar sem mudar nada não cria versão nova.
        </p>

        {historyError && <div className="notice notice--danger">{historyError}</div>}

        {versions.length === 0 && !historyError ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            Nenhuma versão ainda — a primeira aparece assim que você salvar o contexto.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {versions.map((v) => (
              <div key={v.version} className="card" style={{ padding: '10px 14px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 500 }}>Versão {v.version}</span>
                  {v.version === currentVersion && <span className="chip">Em uso</span>}
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>
                    {formatDateTime(v.createdAt)}
                    {' · '}
                    {v.createdByName ?? 'autor removido'}
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => void onOpenVersion(v.version)}
                    aria-expanded={openVersion === v.version}
                  >
                    {openVersion === v.version ? 'Fechar' : 'Ver'}
                  </button>
                </div>

                {openVersion === v.version && (
                  <div
                    style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}
                  >
                    {openLoading || !openDocument ? (
                      <div className="skel" style={{ height: 60 }} />
                    ) : (
                      <>
                        <VersionPreview dto={openDocument} />
                        {canEdit && (
                          <>
                            <button
                              className="btn btn-ghost btn-sm"
                              type="button"
                              style={{ marginTop: 10 }}
                              onClick={() => onRestore(openDocument)}
                            >
                              Restaurar no formulário
                            </button>
                            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                              Carrega esta versão no formulário acima. Ela só passa a valer quando
                              você salvar — e isso cria uma versão nova, sem apagar as anteriores.
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Read-only rendering of a past version's document. Empty fields are simply omitted. */
function VersionPreview({ dto }: { dto: TenantContextDto }) {
  const rows: [string, string][] = [];
  if (dto.companyName) rows.push(['Empresa', dto.companyName]);
  if (dto.industry) rows.push(['Indústria', dto.industry]);
  if (dto.idealCustomerProfile) rows.push(['ICP', dto.idealCustomerProfile]);
  if (dto.valueProposition) rows.push(['Proposta de valor', dto.valueProposition]);
  if (dto.competitors?.length) rows.push(['Concorrentes', dto.competitors.join(', ')]);
  if (dto.objectionHandling?.length)
    rows.push(['Objection handling', dto.objectionHandling.join(' · ')]);

  return (
    <div className="space-y-5">
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          gap: '6px 12px',
          margin: 0,
        }}
      >
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{label}</dt>
            <dd style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
      {dto.products?.length > 0 && (
        <div className="space-y-3">
          <h3 className="sec-label">Produtos</h3>
          {dto.products.map((product, index) => (
            <div className="card" key={`${product.name}-${index}`}>
              <h4 style={{ fontSize: 14, fontWeight: 500 }}>{product.name}</h4>
              {product.description && (
                <p className="lede" style={{ fontSize: 13, marginTop: 6 }}>
                  {product.description}
                </p>
              )}
              {product.keyDifferentiators?.length > 0 && (
                <ul
                  style={{
                    fontSize: 12.5,
                    margin: '10px 0 0',
                    paddingLeft: 16,
                    color: 'var(--muted)',
                  }}
                >
                  {product.keyDifferentiators.map((item, itemIndex) => (
                    <li key={itemIndex}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
