import { getMeeting, listMeetings, listTasks, type TaskListItemDto } from '@/lib/api/client';
import type { Decision, MeetingDetail, Risk } from '@/lib/api/types';
import { loadAllPages } from '@/lib/projects/paged';

interface OverviewApi {
  listMeetings: typeof listMeetings;
  getMeeting: typeof getMeeting;
  listTasks: typeof listTasks;
}

export interface OverviewSource {
  id: string;
  title: string;
  date: string;
}

export interface ExecutiveOverview {
  sources: OverviewSource[];
  totalMeetings: number;
  analyzedMeetings: number;
  unavailableMeetings: number;
  meetingsTruncated: boolean;
  pendingPartial: boolean;
  decisions: Array<Decision & { source: OverviewSource }>;
  risks: Array<Risk & { source: OverviewSource }>;
  tasks: Array<TaskListItemDto & { source: OverviewSource }>;
}

const PRIORITY = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const DETAIL_CONCURRENCY = 8;

/** Every source is reauthorized by the detail endpoint; task status comes from the current task list. */
export async function loadExecutiveOverview(
  api: OverviewApi = { getMeeting, listMeetings, listTasks },
): Promise<ExecutiveOverview> {
  const [listing, ...taskPages] = await Promise.all([
    loadAllPages(api.listMeetings),
    ...(['OPEN', 'IN_PROGRESS'] as const).map(async (status) => {
      try {
        return await loadAllPages((page) => api.listTasks({ ...page, status }));
      } catch {
        return null;
      }
    }),
  ]);
  const candidates = [...new Map(listing.items.map((meeting) => [meeting.id, meeting])).values()];
  const meetings: MeetingDetail[] = [];
  let unavailableMeetings = 0;
  for (let offset = 0; offset < candidates.length; offset += DETAIL_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((meeting) => api.getMeeting(meeting.id)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.id === batch[index].id) {
        meetings.push(result.value);
      } else {
        unavailableMeetings++;
      }
    });
  }
  meetings.sort(
    (a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt),
  );
  const sources = meetings.map((meeting) => ({
    id: meeting.id,
    title: meeting.title,
    date: meeting.startedAt ?? meeting.createdAt,
  }));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const analyzed = meetings.filter(
    (meeting) => meeting.processingStatus === 'COMPLETED' && meeting.analysis,
  );
  const decisions = analyzed.flatMap((meeting) =>
    (meeting.analysis?.decisions ?? []).map((decision) => ({
      ...decision,
      source: sourcesById.get(meeting.id)!,
    })),
  );
  const risks = analyzed
    .flatMap((meeting) =>
      (meeting.analysis?.risks ?? []).map((risk) => ({
        ...risk,
        source: sourcesById.get(meeting.id)!,
      })),
    )
    .sort((a, b) => PRIORITY[a.severity] - PRIORITY[b.severity]);
  const pendingTasks = taskPages.flatMap((page) => page?.items ?? []);
  const tasks = [...new Map(pendingTasks.map((task) => [task.id, task])).values()]
    .filter(
      (task) =>
        (task.status === 'OPEN' || task.status === 'IN_PROGRESS') &&
        sourcesById.has(task.meetingId),
    )
    .map((task) => ({ ...task, source: sourcesById.get(task.meetingId)! }))
    .sort(
      (a, b) =>
        (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
        PRIORITY[a.priority] - PRIORITY[b.priority],
    );
  return {
    sources,
    totalMeetings: listing.totalItems,
    analyzedMeetings: analyzed.length,
    unavailableMeetings,
    meetingsTruncated: listing.truncated || candidates.length !== listing.totalItems,
    pendingPartial: taskPages.some((page) => page === null || page.truncated),
    decisions,
    risks,
    tasks,
  };
}
