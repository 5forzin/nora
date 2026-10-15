import { redirect } from 'next/navigation';
import type { Route } from 'next';

export default async function UsageRedirect({ searchParams }: {
  searchParams: Promise<{ granularity?: string; from?: string; to?: string }>;
}) {
  const filters = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['granularity', 'from', 'to'] as const) {
    if (filters[key]) query.set(key, filters[key]);
  }
  redirect(`/settings/usage${query.size ? `?${query}` : ''}` as Route);
}
