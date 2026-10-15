import type { CommercialBudget, CommercialPersona, CommercialProduct, Sentiment } from './api/types';

export const PRODUCT_RELATIONSHIP_LABEL: Record<CommercialProduct['relationship'], string> = {
  CURRENT: 'Em uso',
  OPPORTUNITY: 'Oportunidade',
  COMPETITOR: 'Concorrente',
  MENTIONED: 'Mencionado',
};

export const DECISION_ROLE_LABEL: Record<CommercialPersona['decisionRole'], string> = {
  DECISION_MAKER: 'Decisor',
  INFLUENCER: 'Influenciador',
  USER: 'Usuário',
  UNKNOWN: 'Papel na decisão não identificado',
};

export const BUDGET_KIND_LABEL: Record<CommercialBudget['kind'], string> = {
  BUDGET: 'Orçamento',
  PROPOSAL: 'Proposta',
  PRICE: 'Preço',
  REVENUE: 'Receita',
  OTHER: 'Outro valor',
};

export const BUDGET_APPROVAL_LABEL: Record<CommercialBudget['approval'], string> = {
  APPROVED: 'Aprovado',
  NOT_APPROVED: 'Não aprovado',
  UNKNOWN: 'Aprovação não identificada',
};

export const TOPIC_SENTIMENT_LABEL: Record<Sentiment, string> = {
  POSITIVE: 'Positivo',
  NEUTRAL: 'Neutro',
  NEGATIVE: 'Negativo',
  MIXED: 'Misto',
};

export function formatCommercialAmount(budget: Pick<CommercialBudget, 'amount' | 'currency'>): string {
  if (budget.amount === null) return 'Valor não identificado';
  if (budget.currency && /^[A-Z]{3}$/.test(budget.currency)) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: budget.currency }).format(budget.amount);
  }
  const amount = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(budget.amount);
  return `${amount} · ${budget.currency || 'moeda não identificada'}`;
}
