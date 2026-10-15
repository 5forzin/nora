import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireEnterpriseAccess } from '@/lib/enterprise/access';
import { workspaceHome } from '@/lib/enterprise/navigation';
import type { Route } from 'next';
import { loadExecutiveOverview, type OverviewSource } from '@/lib/overview/load';
import { formatDateTime } from '@/lib/utils';
import { PRIORITY_LABEL, STATUS_LABEL } from '@/lib/report/tasks-export';

export const dynamic = 'force-dynamic';

const QUESTION =
  'Quais decisões, riscos e pendências das reuniões exigem atenção do diretor? Consolide os temas e cite as fontes. Diferencie fatos de inferências e exclua tarefas concluídas das pendências.';
const SEVERITY_LABEL = { HIGH: 'Alta', MEDIUM: 'Média', LOW: 'Baixa' };
const SEVERITY_COLOR = { HIGH: 'var(--danger)', MEDIUM: 'var(--warn)', LOW: 'var(--muted)' };

function Source({ source }: { source: OverviewSource }) {
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
      <Link href={`/meetings/${source.id}` as Route} style={{ color: 'var(--accent-ink)' }}>
        {source.title}
      </Link>
      {' · '}
      {formatDateTime(source.date)}
    </div>
  );
}

function Evidence({ quote }: { quote?: string }) {
  return quote ? (
    <blockquote
      style={{
        margin: '8px 0 0',
        paddingLeft: 12,
        borderLeft: '2px solid var(--line)',
        fontSize: 13,
        color: 'var(--muted)',
      }}
    >
      {quote}
    </blockquote>
  ) : null;
}

export default async function OverviewPage() {
  const access = await requireEnterpriseAccess();
  if (!access.capabilities.viewExecutiveOverview) redirect(workspaceHome(access));
  let overview;
  try {
    overview = await loadExecutiveOverview();
  } catch {
    return (
      <div>
        <h1 className="h1">Visão executiva</h1>
        <p role="alert">Não foi possível carregar as reuniões.</p>
        <form action="/enterprise">
          <button className="btn btn-primary">Tentar novamente</button>
        </form>
      </div>
    );
  }
  const incomplete = overview.meetingsTruncated || overview.unavailableMeetings > 0;
  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 20,
        }}
      >
        <div>
          <h1 className="h1">Visão executiva</h1>
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: '8px 0 0' }}>
            {overview.sources.length} de {overview.totalMeetings} reuniões acessíveis ·{' '}
            {overview.analyzedMeetings} analisadas
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <form action="/enterprise">
            <button className="btn btn-ghost">Atualizar</button>
          </form>
          <Link
            className="btn btn-primary"
            href={`/chat?q=${encodeURIComponent(QUESTION)}` as Route}
          >
            Perguntar à Nora
          </Link>
        </div>
      </div>
      {(incomplete || overview.pendingPartial) && (
        <p role="status" style={{ color: 'var(--warn)', fontSize: 13 }}>
          Visão parcial.
          {overview.meetingsTruncated
            ? ' O limite de 500 reuniões foi atingido ou a lista mudou durante a consulta.'
            : ''}
          {overview.unavailableMeetings > 0
            ? ` ${overview.unavailableMeetings} reuniões não puderam ser consultadas.`
            : ''}
          {overview.pendingPartial
            ? ' A lista de pendências não pôde ser carregada por completo.'
            : ''}
        </p>
      )}
      <nav
        aria-label="Resumo executivo"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}
      >
        {[
          ['Riscos', overview.risks.length, '#risks'],
          ['Pendências', overview.tasks.length, '#tasks'],
          ['Decisões', overview.decisions.length, '#decisions'],
        ].map(([label, count, href]) => (
          <a
            key={label}
            href={String(href)}
            className="card"
            style={{ flex: '1 1 160px', padding: 18, color: 'var(--ink)', textDecoration: 'none' }}
          >
            <div className="sec-label">{label}</div>
            <div style={{ fontSize: 28, marginTop: 6 }}>
              {count}
              {incomplete || (label === 'Pendências' && overview.pendingPartial) ? '+' : ''}
            </div>
          </a>
        ))}
      </nav>
      <section
        id="risks"
        aria-labelledby="risks-heading"
        style={{ marginBottom: 28, scrollMarginTop: 20 }}
      >
        <h2 id="risks-heading" className="h2">
          Riscos
        </h2>
        <div style={{ display: 'grid', gap: 10 }}>
          {overview.risks.map((risk, index) => (
            <article className="card card--pad" key={`${risk.source.id}/${risk.id ?? index}`}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ fontWeight: 500 }}>{risk.text}</div>
                <span
                  style={{
                    color: SEVERITY_COLOR[risk.severity],
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {SEVERITY_LABEL[risk.severity]}
                </span>
              </div>
              <Evidence quote={risk.sourceQuote} />
              <Source source={risk.source} />
            </article>
          ))}
        </div>
        {overview.risks.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            Nenhum risco registrado.
          </p>
        )}
      </section>
      <section
        id="tasks"
        aria-labelledby="tasks-heading"
        style={{ marginBottom: 28, scrollMarginTop: 20 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <h2 id="tasks-heading" className="h2">
            Pendências
          </h2>
          <Link href="/tasks">Gerenciar tarefas</Link>
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {overview.tasks.map((task) => (
            <article className="card card--pad" key={task.id}>
              <div style={{ fontWeight: 500 }}>{task.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                {STATUS_LABEL[task.status]} · Prioridade{' '}
                {PRIORITY_LABEL[task.priority].toLowerCase()} · {task.assignee ?? 'Sem responsável'}{' '}
                ·{' '}
                {task.dueDate
                  ? `Prazo ${task.dueDate.split('-').reverse().join('/')}`
                  : 'Sem prazo'}
              </div>
              <Source source={task.source} />
              {access.permissions.readTasks && <Link href={`/tasks?meetingId=${task.source.id}#task-${task.id}` as Route} style={{ display: 'inline-block', color: 'var(--accent-ink)', fontSize: 12, marginTop: 10 }}>Acompanhar tarefa</Link>}
            </article>
          ))}
        </div>
        {overview.tasks.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            {overview.pendingPartial || incomplete
              ? 'Nenhuma pendência recuperada nesta consulta parcial.'
              : 'Nenhuma pendência nas reuniões consultadas.'}
          </p>
        )}
      </section>
      <section
        id="decisions"
        aria-labelledby="decisions-heading"
        style={{ marginBottom: 28, scrollMarginTop: 20 }}
      >
        <h2 id="decisions-heading" className="h2">
          Decisões
        </h2>
        <div style={{ display: 'grid', gap: 10 }}>
          {overview.decisions.map((decision, index) => (
            <article
              className="card card--pad"
              key={`${decision.source.id}/${decision.id ?? index}`}
            >
              <div style={{ fontWeight: 500 }}>{decision.text}</div>
              <Source source={decision.source} />
            </article>
          ))}
        </div>
        {overview.decisions.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            Nenhuma decisão registrada.
          </p>
        )}
      </section>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>
          Reuniões consultadas ({overview.sources.length})
        </summary>
        <ul>
          {overview.sources.map((source) => (
            <li key={source.id}>
              <Source source={source} />
            </li>
          ))}
        </ul>
      </details>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 24 }}>
        Riscos refletem a análise original. A resolução precisa ser confirmada.
      </p>
    </div>
  );
}
