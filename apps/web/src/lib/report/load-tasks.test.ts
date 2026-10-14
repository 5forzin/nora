import { beforeEach, expect, it, vi } from 'vitest';
import type { TaskListItemDto } from '@/lib/api/client';
import { loadTasksForExport } from './load-tasks';
import { strings } from '@/lib/strings';

const listTasks = vi.fn();
vi.mock('@/lib/api/client', () => ({ listTasks: (...args: unknown[]) => listTasks(...args) }));

beforeEach(() => { listTasks.mockReset(); });

it('exports all filtered pages beyond both the old 100-item screen and the grouping helper limit', async () => {
  listTasks.mockImplementation(async ({ page, size, status }) => ({
    items: Array.from({ length: page === 5 ? 1 : size }, (_, i) => ({ id: String(page * size + i), status }) as TaskListItemDto),
    totalItems: 501,
    totalPages: 6,
  }));
  const items = await loadTasksForExport('OPEN');
  expect(items).toHaveLength(501);
  expect(items[500].id).toBe('500');
  expect(listTasks).toHaveBeenLastCalledWith({ page: 5, size: 100, status: 'OPEN' });
});

it('rejects a page failure instead of returning an apparently complete partial export', async () => {
  listTasks.mockResolvedValueOnce({ items: [{ id: 'one' }], totalItems: 2, totalPages: 2 });
  listTasks.mockRejectedValueOnce(new Error('page unavailable'));
  await expect(loadTasksForExport()).rejects.toThrow('page unavailable');
});

it('rejects duplicates caused by changes between page requests', async () => {
  listTasks.mockResolvedValue({ items: [{ id: 'one' }], totalItems: 2, totalPages: 2 });
  await expect(loadTasksForExport()).rejects.toThrow(strings.tasks.exportChanged);
});
