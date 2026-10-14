import { describe, expect, it, vi } from 'vitest';
import type { MeetingDetail, MeetingListItem } from '@/lib/api/types';
import type { TaskListItemDto } from '@/lib/api/client';
import { loadExecutiveOverview } from './load';

function meeting(id: string, overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id,
    tenantId: 'tenant',
    title: `Meeting ${id}`,
    startedAt: null,
    createdAt: '2026-10-14T12:00:00Z',
    updatedAt: '2026-10-14T12:00:00Z',
    owner: { id: 'owner', displayName: 'Owner' },
    participants: [],
    processingStatus: 'COMPLETED',
    analysis: {
      summary: 'Discussion',
      decisions: [{ text: `Decision ${id}`, confidence: 1 }],
      risks: [
        {
          text: `Risk ${id}`,
          severity: 'HIGH',
          sourceQuote: 'Source evidence',
          category: 'TIMELINE',
        },
      ],
      opportunities: [],
      actionItems: [],
      topics: [],
      sentimentOverall: 'NEUTRAL',
    },
    ...overrides,
  };
}

function task(
  id: string,
  meetingId: string,
  overrides: Partial<TaskListItemDto> = {},
): TaskListItemDto {
  return {
    id,
    meetingId,
    meetingTitle: `Meeting ${meetingId}`,
    title: `Task ${id}`,
    status: 'OPEN',
    priority: 'HIGH',
    updatedAt: '2026-10-14T12:00:00Z',
    ...overrides,
  };
}

function api(meetings: MeetingDetail[], tasks: TaskListItemDto[] = []) {
  return {
    listMeetings: vi.fn(async ({ page = 0, size = 100 } = {}) => ({
      items: meetings.slice(page * size, (page + 1) * size) as unknown as MeetingListItem[],
      page,
      size,
      totalItems: meetings.length,
      totalPages: Math.ceil(meetings.length / size),
    })),
    getMeeting: vi.fn(async (id: string) => meetings.find((m) => m.id === id)!),
    listTasks: vi.fn(
      async (params?: { status?: string; page?: number; size?: number } | string) => {
        const {
          page = 0,
          size = 100,
          status,
        } = typeof params === 'string' ? { status: params } : (params ?? {});
        const matching = tasks.filter((t) => t.status === status);
        return {
          items: matching.slice(page * size, (page + 1) * size),
          page,
          size,
          totalItems: matching.length,
          totalPages: Math.ceil(matching.length / size),
        };
      },
    ),
  };
}

describe('executive overview', () => {
  it('consolidates meetings with sources and current pending status, title, owner and deadline', async () => {
    const first = meeting('a');
    first.analysis!.actionItems = [
      { title: 'Old task title', priority: 'HIGH', sourceQuote: '', status: 'OPEN' },
    ];
    const second = meeting('b', { startedAt: '2026-10-15T12:00:00Z' });
    second.analysis!.risks[0].severity = 'LOW';
    const result = await loadExecutiveOverview(
      api(
        [first, second],
        [
          task('delivered', 'a', { status: 'DONE' }),
          task('later', 'a', { title: 'Updated title', assignee: 'Owner', dueDate: '2026-10-20' }),
          task('soon', 'b', { status: 'IN_PROGRESS', dueDate: '2026-10-16' }),
        ],
      ),
    );
    expect(result.sources.map((s) => s.id)).toEqual(['b', 'a']);
    expect(result.sources[1].date).toBe(first.createdAt);
    expect(result.decisions.map((d) => d.source.id)).toEqual(['b', 'a']);
    expect(result.risks.map((r) => r.source.id)).toEqual(['a', 'b']);
    expect(result.risks[0].sourceQuote).toBe('Source evidence');
    expect(result.tasks.map((t) => t.id)).toEqual(['soon', 'later']);
    expect(result.tasks[1]).toMatchObject({
      title: 'Updated title',
      assignee: 'Owner',
      dueDate: '2026-10-20',
      source: { id: 'a' },
    });
    expect(result).toMatchObject({
      totalMeetings: 2,
      analyzedMeetings: 2,
      pendingPartial: false,
      meetingsTruncated: false,
    });
  });

  it('loads meetings and pending tasks beyond the first hundred', async () => {
    const meetings = Array.from({ length: 101 }, (_, i) => meeting(String(i)));
    const tasks = Array.from({ length: 101 }, (_, i) => task(String(i), String(i)));
    const client = api(meetings, tasks);
    const result = await loadExecutiveOverview(client);
    expect(result.sources).toHaveLength(101);
    expect(result.tasks).toHaveLength(101);
    expect(result.tasks.some((t) => t.source.id === '100')).toBe(true);
    expect(client.listMeetings).toHaveBeenCalledTimes(2);
    expect(client.listTasks).toHaveBeenCalledWith({ page: 1, size: 100, status: 'OPEN' });
  });

  it('does not expose denied, deleted or mismatched meeting details or their pending tasks', async () => {
    const client = api(
      [meeting('visible'), meeting('denied'), meeting('mismatch')],
      [task('private', 'denied')],
    );
    client.getMeeting.mockImplementation(async (id) => {
      if (id === 'denied') throw new Error('HTTP 403');
      return meeting(id === 'mismatch' ? 'other' : id);
    });
    const result = await loadExecutiveOverview(client);
    expect(result.sources.map((s) => s.id)).toEqual(['visible']);
    expect(result.unavailableMeetings).toBe(2);
    expect(result.tasks).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Risk denied');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('does not treat failed or running analysis as current decisions and risks', async () => {
    const result = await loadExecutiveOverview(
      api([
        meeting('running', { processingStatus: 'PROCESSING' }),
        meeting('failed', { processingStatus: 'FAILED' }),
      ]),
    );
    expect(result.analyzedMeetings).toBe(0);
    expect(result.decisions).toEqual([]);
    expect(result.risks).toEqual([]);
  });

  it('reports task retrieval failure instead of asserting there is no pending work', async () => {
    const client = api([meeting('a')]);
    client.listTasks.mockRejectedValue(new Error('HTTP 403'));
    expect(await loadExecutiveOverview(client)).toMatchObject({ pendingPartial: true, tasks: [] });
  });

  it('marks a capped workspace as partial and does not fetch unlimited details', async () => {
    const client = api(Array.from({ length: 501 }, (_, i) => meeting(String(i))));
    const result = await loadExecutiveOverview(client);
    expect(result).toMatchObject({ totalMeetings: 501, meetingsTruncated: true });
    expect(result.sources).toHaveLength(500);
    expect(client.getMeeting).toHaveBeenCalledTimes(500);
  });

  it('fails visibly when the meeting listing is unavailable', async () => {
    const client = api([]);
    client.listMeetings.mockRejectedValue(new Error('HTTP 503'));
    await expect(loadExecutiveOverview(client)).rejects.toThrow('HTTP 503');
  });
});
