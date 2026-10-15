/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { AnalysisQuality } from '@/lib/api/types';
import AnalysisQualityPanel from './analysis-quality';

const quality: AnalysisQuality = {
  version: '1', origin: 'WORKER',
  transcript: {
    characterCount: 1200, nonEmptyLineCount: 8, speakerLabelCount: 2, labeledTurnCount: 8,
    emptyLabeledTurnCount: 0, replacementCharacterCount: 1, controlCharacterCount: 0, duplicateLineCount: 2,
  },
  extraction: {
    actionItems: { total: 3, withSourceQuote: 2, matchedSourceQuote: 1 },
    actionItemsWithAssignee: 1, actionItemsWithDueDate: 0,
    risks: { total: 1, withSourceQuote: 1, matchedSourceQuote: 1 },
    opportunities: { total: 0, withSourceQuote: 0, matchedSourceQuote: 0 },
    commercial: {
      products: { total: 2, withSourceQuote: 2, matchedSourceQuote: 2 },
      personas: { total: 0, withSourceQuote: 0, matchedSourceQuote: 0 },
      budgets: { total: 0, withSourceQuote: 0, matchedSourceQuote: 0 },
      sentimentByTopic: { total: 0, withSourceQuote: 0, matchedSourceQuote: 0 },
    },
  },
};
afterEach(cleanup);

it('separates source presence from matching and keeps details collapsed', () => {
  const { container } = render(<AnalysisQualityPanel quality={quality} showCommercial />);
  expect(screen.getByText('5/6 itens com fonte')).toBeTruthy();
  expect(screen.getByLabelText('Tarefas: 2 de 3 com fonte').textContent).toBe('2/3');
  expect(screen.getByLabelText('Tarefas: 1 fontes encontradas no texto protegido').textContent).toBe('1');
  expect(container.querySelector('details')?.open).toBe(false);
  expect(screen.getByText(/não medem a precisão/)).toBeTruthy();
});

it('never exposes commercial counts without Enterprise access', () => {
  render(<AnalysisQualityPanel quality={quality} expanded />);
  expect(screen.queryByText('Produtos')).toBeNull();
  expect(screen.queryByText('Valores')).toBeNull();
  expect(screen.getByLabelText('Tarefas: 2 de 3 com fonte')).toBeTruthy();
});

it('does not present missing legacy measurements as zero or verified', () => {
  const legacy: AnalysisQuality = {
    ...quality, origin: 'LEGACY_DERIVED', transcript: null,
    extraction: {
      ...quality.extraction, commercial: null,
      actionItems: { total: 3, withSourceQuote: 2, matchedSourceQuote: null },
      risks: { total: 1, withSourceQuote: 1, matchedSourceQuote: null },
      opportunities: { total: 0, withSourceQuote: 0, matchedSourceQuote: null },
    },
  };
  render(<AnalysisQualityPanel quality={legacy} expanded />);
  expect(screen.getByText('Texto não disponível para contagem.')).toBeTruthy();
  expect(screen.getByLabelText('Tarefas: correspondência não disponível').textContent).toBe('—');
  expect(screen.getByText('Correspondência indisponível nesta análise anterior.')).toBeTruthy();
  expect(screen.queryByText('Rótulos de locutor')).toBeNull();
});
