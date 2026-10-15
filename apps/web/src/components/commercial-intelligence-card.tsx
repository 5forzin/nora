import type { ReactNode } from 'react';
import type { CommercialIntelligence } from '@/lib/api/types';
import {
  BUDGET_APPROVAL_LABEL,
  BUDGET_KIND_LABEL,
  DECISION_ROLE_LABEL,
  PRODUCT_RELATIONSHIP_LABEL,
  TOPIC_SENTIMENT_LABEL,
  formatCommercialAmount,
} from '@/lib/commercial-intelligence';

function Group({ title, children, empty }: { title: string; children: ReactNode; empty: boolean }) {
  return (
    <section className="card card--pad min-w-0" aria-label={title}>
      <h3 style={{ fontSize: 15, fontWeight: 500, margin: '0 0 14px' }}>{title}</h3>
      {empty ? <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Não identificado.</p> : (
        <ul className="m-0 list-none space-y-5 p-0">{children}</ul>
      )}
    </section>
  );
}

function Evidence({ quote, expanded }: { quote: string; expanded: boolean }) {
  const source = <blockquote className="quote" style={{ margin: '8px 0 0', overflowWrap: 'anywhere', whiteSpace: 'pre-line' }} aria-label="Fala de origem">{quote}</blockquote>;
  if (expanded) return source;
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', color: 'var(--accent-ink)', fontSize: 12 }}>Fala de origem</summary>
      {source}
    </details>
  );
}

function Metadata({ children }: { children: ReactNode }) {
  return <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>{children}</div>;
}

export default function CommercialIntelligenceCard({ intelligence, expandEvidence = false }: { intelligence: CommercialIntelligence; expandEvidence?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2" style={{ fontSize: 13.5, overflowWrap: 'anywhere' }}>
      <Group title="Produtos" empty={intelligence.products.length === 0}>
        {intelligence.products.map((product, index) => (
          <li key={index}>
            <strong style={{ fontWeight: 500 }}>{product.name}</strong>
            <Metadata>{PRODUCT_RELATIONSHIP_LABEL[product.relationship]}</Metadata>
            <Evidence quote={product.sourceQuote} expanded={expandEvidence} />
          </li>
        ))}
      </Group>
      <Group title="Pessoas e papéis" empty={intelligence.personas.length === 0}>
        {intelligence.personas.map((persona, index) => (
          <li key={index}>
            <strong style={{ fontWeight: 500 }}>{persona.speaker || 'Pessoa não identificada'}</strong>
            <Metadata>{persona.role || 'Função não identificada'} · {DECISION_ROLE_LABEL[persona.decisionRole]}</Metadata>
            <Evidence quote={persona.sourceQuote} expanded={expandEvidence} />
          </li>
        ))}
      </Group>
      <Group title="Valores" empty={intelligence.budgets.length === 0}>
        {intelligence.budgets.map((budget, index) => (
          <li key={index}>
            <strong style={{ fontWeight: 500 }}>{formatCommercialAmount(budget)}</strong>
            <Metadata>{BUDGET_KIND_LABEL[budget.kind]} · {BUDGET_APPROVAL_LABEL[budget.approval]}{budget.period ? ` · ${budget.period}` : ''}</Metadata>
            <Evidence quote={budget.sourceQuote} expanded={expandEvidence} />
          </li>
        ))}
      </Group>
      <Group title="Sentimento por tópico" empty={intelligence.sentimentByTopic.length === 0}>
        {intelligence.sentimentByTopic.map((topic, index) => (
          <li key={index}>
            <strong style={{ fontWeight: 500 }}>{topic.topic}</strong>
            <Metadata>{TOPIC_SENTIMENT_LABEL[topic.sentiment]}</Metadata>
            <Evidence quote={topic.sourceQuote} expanded={expandEvidence} />
          </li>
        ))}
      </Group>
    </div>
  );
}
