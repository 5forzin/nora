import { listTasks, type TaskListItemDto, type TaskStatus } from '@/lib/api/client';
import { loadAllPages } from '@/lib/projects/paged';
import { strings } from '@/lib/strings';

/** Export the complete filtered listing, or fail without downloading a partial file. */
export async function loadTasksForExport(status?: TaskStatus): Promise<TaskListItemDto[]> {
  const result = await loadAllPages((page) => listTasks({ ...page, status }), Infinity);
  const unique = new Map(result.items.map((task) => [task.id, task]));
  if (result.truncated || unique.size !== result.totalItems) {
    throw new Error(strings.tasks.exportChanged);
  }
  return [...unique.values()];
}
