/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import CommercialIntelligenceCard from './commercial-intelligence-card';
import type { CommercialIntelligence } from '@/lib/api/types';

afterEach(cleanup);

export const commercial: CommercialIntelligence = {
  products: [{ name: 'Protheus', relationship: 'CURRENT', sourceQuote: 'Usamos Protheus hoje.' }],
  personas: [{ speaker: null, role: null, decisionRole: 'UNKNOWN', sourceQuote: 'Preciso consultar a equipe.' }],
  budgets: [
    { amount: 170000, currency: 'BRL', kind: 'BUDGET', approval: 'APPROVED', period: '2026', sourceQuote: 'O teto aprovado é 170 mil reais para 2026.' },
    { amount: null, currency: null, kind: 'PROPOSAL', approval: 'UNKNOWN', period: null, sourceQuote: 'Ainda não temos o valor da proposta.' },
  ],
  sentimentByTopic: [{ topic: 'Implantação', sentiment: 'MIXED', sourceQuote: 'A solução atende, mas o prazo preocupa.' }],
};

it('keeps unknown values distinct from zero and labels classifications with their evidence', () => {
  render(<CommercialIntelligenceCard intelligence={commercial} />);
  const values = within(screen.getByRole('region', { name: 'Valores' }));
  expect(values.getByText(/170\.000,00/)).toBeTruthy();
  expect(values.getByText('Valor não identificado')).toBeTruthy();
  expect(values.queryByText(/^R\$\s*0,00$/)).toBeNull();
  expect(screen.getByText('Pessoa não identificada')).toBeTruthy();
  expect(screen.getByText('Em uso')).toBeTruthy();
  expect(screen.getByText('Misto')).toBeTruthy();
  expect(screen.getAllByRole('blockquote', { hidden: true })).toHaveLength(5);
  expect(screen.getByText(commercial.budgets[0].sourceQuote)).toBeTruthy();
  expect(screen.queryByText('APPROVED')).toBeNull();
});

it('keeps source quotes in native disclosures without hiding classifications', () => {
  const { container } = render(<CommercialIntelligenceCard intelligence={commercial} />);
  const disclosures = Array.from(container.querySelectorAll('details'));
  expect(disclosures).toHaveLength(5);
  expect(disclosures.every((details) => !details.open)).toBe(true);
  for (const disclosure of disclosures) {
    expect(disclosure.querySelector('summary')?.textContent).toBe('Fala de origem');
    expect(disclosure.querySelector('blockquote')?.textContent).toBeTruthy();
  }
  expect(screen.getByText('Orçamento · Aprovado · 2026')).toBeTruthy();
  expect(screen.getByText('Proposta · Aprovação não identificada')).toBeTruthy();
});

it('renders all evidence directly for print reports', () => {
  const { container } = render(<CommercialIntelligenceCard intelligence={commercial} expandEvidence />);
  expect(container.querySelector('details')).toBeNull();
  expect(screen.getAllByRole('blockquote')).toHaveLength(5);
  for (const item of [...commercial.products, ...commercial.personas, ...commercial.budgets, ...commercial.sentimentByTopic]) {
    expect(screen.getByText(item.sourceQuote, { exact: true })).toBeTruthy();
  }
});

it('shows a short unidentified state for each empty category', () => {
  render(<CommercialIntelligenceCard intelligence={{ products: [], personas: [], budgets: [], sentimentByTopic: [] }} />);
  expect(screen.getAllByText('Não identificado.')).toHaveLength(4);
});
