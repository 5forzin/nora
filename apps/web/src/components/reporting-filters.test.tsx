/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readerWorkspace } from '@/fixtures/workspace-access';

const state = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams(), trends: vi.fn(), usage: vi.fn(), getMe: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }), useSearchParams: () => state.params }));
vi.mock('@/lib/api/client', () => ({ getTrends: state.trends, getUsage: state.usage, getMe: state.getMe }));

import TrendsFilters from '@/app/(app)/trends/Filters';
import UsageFilters from '@/app/(app)/settings/usage/Filters';
import TrendsPage from '@/app/(app)/trends/page';
import UsagePage from '@/app/(app)/settings/usage/page';

beforeEach(() => { vi.clearAllMocks(); state.params = new URLSearchParams(); state.getMe.mockResolvedValue(readerWorkspace); });
afterEach(cleanup);

describe.each([
  { path: '/trends', Filter: TrendsFilters, unit: 'WEEK' as const },
  { path: '/settings/usage', Filter: UsageFilters, unit: 'MONTH' as const },
])('$path calendar filters', ({ path, Filter, unit }) => {
  it('submits the inclusive day in the reporting zone, then restores it from the exclusive query', () => {
    const view = render(<Filter granularity={unit} timezone="America/Sao_Paulo" />);
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-14' } });
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2026-10-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    const url = new URL(state.push.mock.calls[0][0], 'https://nora.test');
    expect(url.pathname).toBe(path);
    expect(url.searchParams.get('from')).toBe('2026-10-14T03:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-10-15T03:00:00.000Z');
    state.params = url.searchParams;
    view.rerender(<Filter granularity={unit} timezone="America/Sao_Paulo" />);
    expect((screen.getByLabelText('Até') as HTMLInputElement).value).toBe('2026-10-14');
  });

  it('rejects inverted ranges and allows clearing the error and query', () => {
    render(<Filter granularity={unit} timezone="America/Sao_Paulo" />);
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-15' } });
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2026-10-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(screen.getByRole('alert').textContent).toContain('fim igual ou posterior');
    expect(state.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    expect(state.push).toHaveBeenCalledWith(path);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not invent a reporting zone when the API failed', () => {
    render(<Filter granularity={unit} />);
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2026-10-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(screen.getByRole('alert').textContent).toContain('fuso do relatório');
    expect(state.push).not.toHaveBeenCalled();
  });
});

it.each(['trends', 'usage'] as const)('uses the %s API response timezone with the default empty query', async (page) => {
  const common = { timezone: 'Asia/Kathmandu', from: '2026-10-01T00:00:00+05:45', to: '2026-10-14T12:00:00+05:45' };
  state.trends.mockResolvedValue({ ...common, granularity: 'WEEK', dataState: 'NO_MEETINGS', taskLoad: { buckets: [] } });
  state.usage.mockResolvedValue({ ...common, granularity: 'MONTH', dataState: 'NO_DATA', ai: { state: 'UNAVAILABLE' }, meetingBuckets: [] });
  const Page = page === 'trends' ? TrendsPage : UsagePage;
  render(await Page({ searchParams: Promise.resolve({}) }));
  fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-14' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
  const url = new URL(state.push.mock.calls[0][0], 'https://nora.test');
  expect(url.searchParams.get('from')).toBe('2026-10-13T18:15:00.000Z');
});
