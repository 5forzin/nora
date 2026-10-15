import { expect, it } from 'vitest';
import { formatCommercialAmount } from './commercial-intelligence';

it('distinguishes an unreported amount from an explicitly reported zero', () => {
  expect(formatCommercialAmount({ amount: null, currency: null })).toBe('Valor não identificado');
  expect(formatCommercialAmount({ amount: 0, currency: 'BRL' })).toMatch(/^R\$\s0,00$/);
});

it('does not infer a currency and tolerates a source currency that is not an ISO code', () => {
  expect(formatCommercialAmount({ amount: 1200, currency: null })).toBe('1.200 · moeda não identificada');
  expect(formatCommercialAmount({ amount: 1200, currency: 'reais' })).toBe('1.200 · reais');
});
