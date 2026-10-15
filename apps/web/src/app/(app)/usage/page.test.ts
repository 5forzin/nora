import { expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: (destination: string) => { throw new Error(destination); } }));
import UsageRedirect from './page';

it('preserves existing usage filters when moving to account settings', async () => {
  await expect(UsageRedirect({ searchParams: Promise.resolve({ granularity: 'WEEK', from: '2026-10-01', to: '2026-10-15' }) })).rejects.toThrow('/settings/usage?granularity=WEEK&from=2026-10-01&to=2026-10-15');
});
