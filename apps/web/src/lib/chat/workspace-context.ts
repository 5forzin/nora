import type { TaskListItemDto, TaskListResponse } from '@/lib/api/client';
import type { MeetingDetail } from '@/lib/api/types';
import { redactPii } from '@/lib/pii/redact';

interface ContextApi {
  apiBaseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

interface MeetingCandidate {
  id: string;
}

export interface MeetingSource {
  reference: string;
  id: string;
  title: string;
}

export interface MeetingContext {
  text: string;
  sources: MeetingSource[];
}

export interface PendingTaskContext {
  text: string;
  items: TaskListItemDto[];
  partial: boolean;
}

const MAX_MEETINGS = 12;
const TASKS_PER_STATUS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escape fence delimiters and keep one tenant-controlled value on one line. */
export function clampContextValue(value: string, max: number): string {
  const safe = value.replace(/\s+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
  return safe.length <= max ? safe : `${safe.slice(0, max - 1).trimEnd()}…`;
}

async function readContext<T>(api: ContextApi, path: string): Promise<T | null> {
  try {
    const response = await fetch(`${api.apiBaseUrl}${path}`, {
      headers: api.headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(api.timeoutMs),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

function section(label: string, items: string[], budget: number): string[] {
  if (items.length === 0) return [];
  const lines = [label];
  let used = 0;
  for (const item of items) {
    if (used + item.length + 1 > budget) break;
    lines.push(item);
    used += item.length + 1;
  }
  if (lines.length - 1 < items.length) lines.push('- More items exist; open the meeting.');
  return lines;
}

function evidence(quote?: string): string {
  return quote?.trim() ? ` Evidence: ${clampContextValue(quote, 180)}` : '';
}

function meetingLines(
  meeting: MeetingDetail,
  source: MeetingSource,
  includeActionItems: boolean,
): string[] {
  const date = clampContextValue(meeting.startedAt ?? meeting.createdAt ?? '', 30);
  const lines = [
    `MEETING ${source.reference}: ${clampContextValue(meeting.title, 180)}${date ? ` (${date})` : ''}`,
  ];
  const analysis = meeting.analysis;
  if (!analysis || meeting.processingStatus !== 'COMPLETED')
    return [...lines, 'Analysis unavailable; do not infer decisions or risks.'];

  // Each section has its own budget so a long summary cannot displace risks or decisions.
  lines.push(`Summary: ${clampContextValue(analysis.summary, 2_400)}`);
  lines.push(
    ...section(
      'Decisions:',
      (analysis.decisions ?? []).map((d) => `- ${clampContextValue(d.text, 350)}`),
      800,
    ),
  );
  lines.push(
    ...section(
      'Risks:',
      (analysis.risks ?? []).map(
        (r) =>
          `- [${clampContextValue(r.severity, 20)}] ${clampContextValue(r.text, 350)}${evidence(r.sourceQuote)}`,
      ),
      1_000,
    ),
  );
  lines.push(
    ...section(
      'Opportunities:',
      (analysis.opportunities ?? []).map(
        (o) => `- ${clampContextValue(o.text, 350)}${evidence(o.sourceQuote)}`,
      ),
      800,
    ),
  );
  if (includeActionItems) {
    lines.push(
      ...section(
        'Meeting action items (respect the reported status):',
        (analysis.actionItems ?? []).map((t) => {
          const owner = t.assignee ? ` Assignee: ${clampContextValue(t.assignee, 100)}.` : '';
          const due = t.dueDate ? ` Due: ${clampContextValue(t.dueDate, 30)}.` : '';
          return `- [${clampContextValue(t.status ?? 'STATUS NOT REPORTED', 30)}] ${clampContextValue(t.title, 250)}.${owner}${due}${evidence(t.sourceQuote)}`;
        }),
        1_000,
      ),
    );
  } else {
    const quotes = [
      ...new Set(
        (analysis.actionItems ?? [])
          .map((item) => clampContextValue(item.sourceQuote?.normalize('NFC') ?? '', 500))
          .filter(Boolean),
      ),
    ];
    lines.push(...section('Protected transcript evidence:', quotes.map((quote) => `- ${quote}`), 2_000));
  }
  return lines;
}

export async function fetchMeetingContext(
  api: ContextApi,
  query: string,
  options: { includeActionItems?: boolean } = {},
): Promise<MeetingContext> {
  const [search, recent] = await Promise.all([
    query.trim()
      ? readContext<{ items: MeetingCandidate[] }>(
          api,
          `/meetings/search?q=${encodeURIComponent(query)}&k=${MAX_MEETINGS}`,
        )
      : Promise.resolve(null),
    readContext<{ items: MeetingCandidate[] }>(api, `/meetings?size=${MAX_MEETINGS}`),
  ]);
  // Similarity search can return only one or two matches for a broad executive question.
  // Fill the remaining budget with recent authorized meetings so other areas are represented.
  const candidates = [...(search?.items ?? []), ...(recent?.items ?? [])];
  const mode = search?.items?.length
    ? 'semantic search and recent meetings'
    : 'recent meetings; semantic search returned no results or was unavailable';

  const ids = [...new Set(candidates.map((m) => m.id).filter((id) => UUID.test(id)))].slice(
    0,
    MAX_MEETINGS,
  );
  // Detail requests run concurrently and recheck meeting:read using the caller's own cookies.
  // A denied/deleted detail contributes neither its old snippet nor a citation.
  const details = await Promise.all(
    ids.map((id) => readContext<MeetingDetail>(api, `/meetings/${id}`)),
  );
  const sources: MeetingSource[] = [];
  const blocks: string[] = [];
  const authorized = details.filter(
    (meeting, index): meeting is MeetingDetail => !!meeting && meeting.id === ids[index],
  );
  const meetingTime = (meeting: MeetingDetail): number => {
    const parsed = Date.parse(meeting.startedAt ?? meeting.createdAt ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  authorized.sort((a, b) => meetingTime(a) - meetingTime(b));
  authorized.forEach((meeting) => {
    const source = { reference: `M${sources.length + 1}`, id: meeting.id, title: meeting.title };
    sources.push(source);
    blocks.push(meetingLines(meeting, source, options.includeActionItems !== false).join('\n'));
  });
  if (blocks.length === 0) return { text: '', sources: [] };
  const partial = sources.length < ids.length ? ' Some meetings could not be retrieved.' : '';
  return {
    text: `MEETINGS CONSULTED (${mode}; chronological order, oldest meeting first and newest last; up to ${MAX_MEETINGS}, content limited per section). This selection does not represent all workspace meetings. These are dated historical records: for the same fact, a later explicit update supersedes an earlier report. Distinguish resolved conditions from remaining blockers.${partial}\n\n${blocks.join('\n\n')}`,
    sources,
  };
}

export async function fetchPendingTaskContext(api: ContextApi): Promise<PendingTaskContext> {
  const statuses = ['OPEN', 'IN_PROGRESS'] as const;
  const pages = await Promise.all(
    statuses.map((status) =>
      readContext<TaskListResponse>(api, `/tasks?status=${status}&size=${TASKS_PER_STATUS}`),
    ),
  );
  if (pages.every((page) => page === null)) return { text: '', items: [], partial: true };

  const tasks: TaskListItemDto[] = pages.flatMap((page, index) =>
    (page?.items ?? [])
      .filter((task) => task.status === statuses[index])
      .slice(0, TASKS_PER_STATUS),
  );
  const partial = pages.some((page) => page === null || page.totalItems > TASKS_PER_STATUS);
  const lines = ['PENDING ACTION ITEMS (OPEN and IN_PROGRESS; completed tasks excluded):'];
  if (partial)
    lines.push(
      `Partial list: up to ${TASKS_PER_STATUS} tasks per status; open Action items for the full list.`,
    );
  if (tasks.length === 0)
    lines.push(
      partial
        ? 'No pending tasks retrieved in this partial query.'
        : 'No pending tasks found in authorized meetings.',
    );
  for (const task of tasks) {
    const owner = task.assignee ? ` Assignee: ${clampContextValue(task.assignee, 100)}.` : '';
    const due = task.dueDate ? ` Due: ${clampContextValue(task.dueDate, 30)}.` : '';
    lines.push(
      `- [${task.status}/${clampContextValue(task.priority, 20)}] ${clampContextValue(task.title, 250)}.${owner}${due} Meeting: ${clampContextValue(task.meetingTitle, 180)}.`,
    );
  }
  return { text: lines.join('\n'), items: tasks, partial };
}

/** Redact labels before adding trusted paths: redacting numeric UUIDs can corrupt valid links. */
export function formatMeetingSources(sources: MeetingSource[]): string {
  if (sources.length === 0) return '';
  return [
    'SOURCES (use these links when citing each meeting):',
    ...sources.map((source) => {
      const title = clampContextValue(redactPii(source.title), 180).replace(/[\\`[\]]/g, '\\$&');
      return `- ${source.reference}: [${title}](/meetings/${source.id})`;
    }),
  ].join('\n');
}
