/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MeetingDetail } from '@/lib/api/types';

const mocks = vi.hoisted(() => ({ access: vi.fn(), meeting: vi.fn(), export: vi.fn(), history: vi.fn() }));
vi.mock('@/lib/enterprise/access', () => ({ getWorkspaceAccess: mocks.access }));
vi.mock('@/lib/api/client', async (original) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await original<typeof import('@/lib/api/client')>()),
  getMeeting: mocks.meeting,
}));
vi.mock('@/components/meeting-productivity-section', () => ({ default: () => null }));
vi.mock('@/components/meeting-actions', () => ({ MeetingDangerZone: () => null, ReprocessButton: () => null }));
vi.mock('@/components/customer-meeting-history', () => ({ CustomerMeetingHistory: mocks.history }));
vi.mock('./export-menu', () => ({ default: mocks.export }));
vi.mock('./processing-poller', () => ({ default: () => null }));
vi.mock('./report/print-button', () => ({ default: () => null }));

import MeetingDetailPage from './page';
import MeetingReportPage from './report/page';

const meeting: MeetingDetail = {
  id: 'meeting-1', tenantId: 'tenant-1', title: 'Customer meeting', startedAt: null,
  owner: { id: 'owner', displayName: 'Owner' }, participants: [], processingStatus: 'COMPLETED',
  attributes: { externalId: 'external-1', clientCode: 'C-18' }, createdAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z',
  analysis: { summary: 'Meeting summary', decisions: [], actionItems: [], risks: [], opportunities: [], sentimentOverall: 'NEUTRAL', topics: [],
    commercialIntelligence: { products: [{ name: 'Enterprise product', relationship: 'CURRENT', sourceQuote: 'We use this product.' }], personas: [], budgets: [], sentimentByTopic: [] },
    quality: { version: '1', origin: 'LEGACY_DERIVED', transcript: null, extraction: {
      actionItems: { total: 0, withSourceQuote: 0, matchedSourceQuote: null }, actionItemsWithAssignee: 0, actionItemsWithDueDate: 0,
      risks: { total: 0, withSourceQuote: 0, matchedSourceQuote: null }, opportunities: { total: 0, withSourceQuote: 0, matchedSourceQuote: null },
      commercial: {
        products: { total: 1, withSourceQuote: 1, matchedSourceQuote: null }, personas: { total: 0, withSourceQuote: 0, matchedSourceQuote: null },
        budgets: { total: 0, withSourceQuote: 0, matchedSourceQuote: null }, sentimentByTopic: { total: 0, withSourceQuote: 0, matchedSourceQuote: null },
      },
    } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.meeting.mockResolvedValue(meeting);
  mocks.export.mockReturnValue(null);
  mocks.history.mockReturnValue(<div>Accessible customer history</div>);
});
afterEach(cleanup);

it('removes commercial analysis from Core rendering and from the export input', async () => {
  mocks.access.mockResolvedValue({ plan: 'FREE', permissions: {} });
  render(await MeetingDetailPage({ params: Promise.resolve({ id: meeting.id }) }));
  expect(screen.queryByText('Contexto comercial')).toBeNull();
  expect(screen.queryByText('Enterprise product')).toBeNull();
  expect(screen.getByText('ID de origem external-1')).toBeTruthy();
  expect(mocks.export.mock.calls[0][0].detail.analysis.commercialIntelligence).toBeNull();
  expect(mocks.export.mock.calls[0][0].detail.analysis.quality.extraction.commercial).toBeNull();
  expect(mocks.history).not.toHaveBeenCalled();
});

it('renders evidence and customer history for Enterprise meetings', async () => {
  mocks.access.mockResolvedValue({ plan: 'ENTERPRISE', permissions: {} });
  render(await MeetingDetailPage({ params: Promise.resolve({ id: meeting.id }) }));
  expect(screen.getByText('Enterprise product')).toBeTruthy();
  expect(screen.getByText('We use this product.')).toBeTruthy();
  expect(screen.getByText('Accessible customer history')).toBeTruthy();
  expect(mocks.history.mock.calls[0][0]).toMatchObject({ clientCode: 'C-18', currentMeetingId: meeting.id });
});

it('keeps commercial information out of Core print reports', async () => {
  mocks.access.mockResolvedValue({ plan: 'PRO', permissions: {} });
  render(await MeetingReportPage({ params: Promise.resolve({ id: meeting.id }) }));
  expect(screen.queryByText('Contexto comercial')).toBeNull();
  expect(screen.queryByText('Enterprise product')).toBeNull();
});

it('localizes priority, severity and opportunity levels in meeting details', async () => {
  mocks.access.mockResolvedValue({ plan: 'FREE', permissions: {} });
  mocks.meeting.mockResolvedValue({
    ...meeting,
    analysis: {
      ...meeting.analysis,
      actionItems: ['HIGH', 'MEDIUM', 'LOW'].map((priority) => ({ title: `Task ${priority}`, priority, sourceQuote: '' })),
      risks: [{ text: 'A delivery risk', severity: 'HIGH', category: 'delivery', sourceQuote: '' }],
      opportunities: [{ text: 'A new opportunity', estimatedValue: 'MEDIUM', category: 'growth', sourceQuote: '' }],
    },
  });
  render(await MeetingDetailPage({ params: Promise.resolve({ id: meeting.id }) }));
  for (const label of ['Alta', 'Média', 'Baixa', 'Alta · delivery', 'Média · growth']) {
    expect(screen.getByText(label, { exact: true })).toBeTruthy();
  }
  expect(screen.queryByText(/^(HIGH|MEDIUM|LOW)( ·|$)/)).toBeNull();
});
