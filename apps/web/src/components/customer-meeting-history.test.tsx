/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const history = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ getCustomerMeetingHistory: history }));
import { CustomerMeetingHistory } from './customer-meeting-history';
afterEach(() => { cleanup(); history.mockReset(); });

it('links only other accessible meetings and preserves missing dates', async () => {
  history.mockResolvedValue({ clientCode: 'C-18', truncated: true, items: [
    { id: 'current', title: 'Current', startedAt: null },
    { id: 'previous', title: 'Earlier discussion', startedAt: null, summarySnippet: 'Previously discussed the proposal.' },
  ] });
  render(await CustomerMeetingHistory({ clientCode: 'C-18', currentMeetingId: 'current' }));
  expect(history).toHaveBeenCalledWith('C-18');
  expect(screen.queryByText('Current')).toBeNull();
  expect(screen.getByRole('link', { name: 'Earlier discussion' }).getAttribute('href')).toBe('/meetings/previous');
  expect(screen.getByText('Data não informada')).toBeTruthy();
  expect(screen.getByText('O histórico atingiu o limite de exibição.')).toBeTruthy();
});

it('keeps a history failure from breaking the meeting detail', async () => {
  history.mockRejectedValue(new Error('API unavailable'));
  render(await CustomerMeetingHistory({ clientCode: 'C-18', currentMeetingId: 'current' }));
  expect(screen.getByText('Histórico indisponível no momento.')).toBeTruthy();
});
