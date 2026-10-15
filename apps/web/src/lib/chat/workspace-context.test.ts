import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionItem, MeetingDetail } from '@/lib/api/types';
import {
  fetchMeetingContext,
  fetchPendingTaskContext,
  formatMeetingSources,
} from './workspace-context';

const ID = '12345678-9012-4012-8012-123456789012';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const API = {
  apiBaseUrl: 'https://api.test.invalid',
  headers: { Cookie: 'nora_access=test-session', Accept: 'application/json' },
  timeoutMs: 500,
};

function meeting(id = ID): MeetingDetail {
  return {
    id,
    tenantId: 'test-tenant',
    title: 'Renewal review',
    startedAt: '2026-10-14T13:00:00Z',
    createdAt: '2026-10-14T13:00:00Z',
    updatedAt: '2026-10-14T13:00:00Z',
    owner: { id: 'owner', displayName: 'Owner' },
    participants: [],
    processingStatus: 'COMPLETED',
    analysis: {
      summary: `${'Routine discussion. '.repeat(20)}The client may leave unless delivery recovers.`,
      decisions: [{ text: 'Escalate the supplier delay', confidence: 0.9 }],
      risks: [
        {
          text: 'Renewal is at risk',
          category: 'delivery',
          severity: 'HIGH',
          sourceQuote: 'Delivery is six weeks late.',
        },
      ],
      opportunities: [
        {
          text: 'Expand after recovery',
          estimatedValue: 'HIGH',
          category: 'growth',
          sourceQuote: 'We can add a second region.',
        },
      ],
      actionItems: [
        {
          title: 'Confirm delivery date',
          assignee: 'Sales owner',
          dueDate: '2026-10-16',
          priority: 'HIGH',
          sourceQuote: 'Send the revised plan.',
          status: 'OPEN',
        },
      ],
      topics: ['renewal'],
      sentimentOverall: 'MIXED',
    },
  };
}

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('meeting context', () => {
  it('orders updates by meeting time rather than semantic rank and keeps source references aligned', async () => {
    const older = meeting(ID);
    older.title = 'Supplier awaiting confirmation';
    older.analysis!.summary = 'Written confirmation has not been received.';
    const newer = meeting(OTHER_ID);
    newer.title = 'Supplier confirmation received';
    newer.startedAt = null;
    newer.createdAt = '2026-10-14T15:00:00Z';
    newer.analysis!.summary =
      'Written confirmation has been received; physical delivery is pending.';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search?') || url.includes('/meetings?'))
        return json({ items: [{ id: ID }, { id: OTHER_ID }] });
      return json(url.endsWith(OTHER_ID) ? newer : older);
    });
    const result = await fetchMeetingContext(API, 'Current supplier status');
    expect(result.sources).toEqual([
      { reference: 'M1', id: ID, title: older.title },
      { reference: 'M2', id: OTHER_ID, title: newer.title },
    ]);
    expect(result.text).toContain(newer.analysis!.summary);
    expect(result.text).toContain(older.analysis!.summary);
    expect(result.text.indexOf('Written confirmation has not been received')).toBeLessThan(
      result.text.indexOf('Written confirmation has been received'),
    );
    expect(result.text).toContain('a later explicit update supersedes an earlier report');
  });

  it('does not treat stale analysis from a failed or running meeting as current evidence', async () => {
    const detail = meeting();
    detail.processingStatus = 'FAILED';
    fetchMock.mockImplementation(async (input) =>
      json(String(input).includes('/search?') ? { items: [{ id: ID }] } : detail),
    );
    const result = await fetchMeetingContext(API, 'Risks');
    expect(result.text).toContain('Analysis unavailable');
    expect(result.text).not.toContain('Renewal is at risk');
  });

  it('includes other recent areas when a broad question has only one semantic match', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search?')) return json({ items: [{ id: ID }] });
      if (url.includes('/meetings?')) return json({ items: [{ id: ID }, { id: OTHER_ID }] });
      return json(meeting(url.endsWith(OTHER_ID) ? OTHER_ID : ID));
    });
    const result = await fetchMeetingContext(API, 'Executive priorities');
    expect(result.sources.map((source) => source.id)).toEqual([ID, OTHER_ID]);
    expect(result.text).toContain('semantic search and recent meetings');
  });
  it('retrieves authorized details beyond the search snippet and gives each meeting a source', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search?'))
        return json({
          items: [{ id: ID, summarySnippet: 'Short introduction' }, { id: OTHER_ID }],
        });
      return json(meeting(url.endsWith(OTHER_ID) ? OTHER_ID : ID));
    });

    const result = await fetchMeetingContext(API, 'What could block renewal?');
    expect(result.text).toContain('The client may leave unless delivery recovers.');
    expect(result.text).toContain('Escalate the supplier delay');
    expect(result.text).toContain('Renewal is at risk');
    expect(result.text).toContain('Delivery is six weeks late.');
    expect(result.text).toContain('Expand after recovery');
    expect(result.text).toContain('Sales owner');
    expect(result.text).toContain('2026-10-16');
    expect(result.text).not.toContain('Short introduction');
    expect(result.sources.map((source) => source.id)).toEqual([ID, OTHER_ID]);
    expect(formatMeetingSources(result.sources)).toContain(`[Renewal review](/meetings/${ID})`);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ headers: API.headers, cache: 'no-store' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('does not reuse search snippets or cite details denied by the backend', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/search?'))
        return json({
          items: [
            { id: ID },
            { id: OTHER_ID, title: 'Restricted acquisition', summarySnippet: 'Restricted number' },
          ],
        });
      return String(input).endsWith(OTHER_ID) ? json({ error: 'forbidden' }, 403) : json(meeting());
    });

    const result = await fetchMeetingContext(API, 'Acquisitions');
    expect(result.text).not.toContain('Restricted');
    expect(result.text).toContain('could not be retrieved');
    expect(formatMeetingSources(result.sources)).not.toContain(OTHER_ID);
  });

  it('keeps source evidence without generated task fields when the application supplies tasks', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search?') || url.includes('/meetings?'))
        return json({ items: [{ id: ID }] });
      return json(meeting());
    });

    const result = await fetchMeetingContext(API, 'Executive blockers', { includeActionItems: false });
    expect(result.text).not.toContain('Meeting action items');
    expect(result.text).not.toContain('Confirm delivery date');
    expect(result.text).not.toContain('Sales owner');
    expect(result.text).toContain('Protected transcript evidence:\n- Send the revised plan.');
    expect(result.text).not.toContain('[OPEN]');
    expect(result.text).toContain('The client may leave unless delivery recovers.');
    expect(result.text).toContain('Escalate the supplier delay');
    expect(result.text).toContain('Renewal is at risk');
    expect(result.text).toContain('Delivery is six weeks late.');
    expect(result.text).toContain('Expand after recovery');
    expect(result.sources).toEqual([{ reference: 'M1', id: ID, title: 'Renewal review' }]);
    expect(formatMeetingSources(result.sources)).toContain(`(/meetings/${ID})`);
  });

  it('deduplicates and bounds transcript evidence independently of generated task data', async () => {
    const detail = meeting();
    detail.analysis!.actionItems = [
      ...Array.from({ length: 2 }, (_, index): ActionItem => ({
        title: `Generated title ${index}`,
        assignee: 'Generated owner',
        dueDate: '2026-10-16',
        priority: 'HIGH',
        status: 'OPEN',
        sourceQuote: index === 0 ? 'Operations must deliver the plan by October 21.' : ' Operations must\n deliver the plan by October 21. ',
      })),
      ...Array.from({ length: 8 }, (_, index): ActionItem => ({
        title: `Generated title ${index + 2}`,
        priority: 'HIGH',
        sourceQuote: `Quoted passage ${index}: ${'x'.repeat(1_000)}`,
      })),
    ];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search?') || url.includes('/meetings?'))
        return json({ items: [{ id: ID }] });
      return json(detail);
    });

    const result = await fetchMeetingContext(API, 'Current blockers', { includeActionItems: false });
    const evidence = result.text.split('Protected transcript evidence:\n')[1];
    expect(evidence.match(/Operations must deliver the plan by October 21\./g)).toHaveLength(1);
    expect(evidence).not.toContain('Generated title');
    expect(evidence).not.toContain('Generated owner');
    expect(evidence).not.toContain('[OPEN]');
    const quotes = evidence.split('\n').filter((line) => line.startsWith('- Quoted passage'));
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((line) => line.slice(2).length <= 500)).toBe(true);
    expect(evidence.length).toBeLessThan(2_100);
    expect(evidence).toContain('More items exist; open the meeting.');
  });

  it('falls back to recent meetings when semantic search fails and bounds detail fan-out', async () => {
    const candidates = Array.from({ length: 15 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
    }));
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search?')) throw new Error('Embedding provider unavailable');
      if (url.includes('?size='))
        return json({
          items: [candidates[0], candidates[0], { id: '../admin' }, ...candidates.slice(1)],
        });
      return json(meeting(url.split('/').at(-1)));
    });

    const result = await fetchMeetingContext(API, 'Revenue risk');
    expect(result.sources).toHaveLength(12);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    expect(result.text).toContain('recent meetings');
    expect(result.text).toContain('does not represent all');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/admin'))).toBe(false);
  });

  it('keeps every analysis section when long content must be abbreviated', async () => {
    const detail = meeting();
    const analysis = detail.analysis!;
    analysis.summary = '<summary> '.repeat(3_000);
    analysis.decisions = Array.from({ length: 30 }, () => ({
      text: `Decision ${'x'.repeat(1_000)}`,
      confidence: 1,
    }));
    analysis.risks = Array.from({ length: 30 }, () => ({
      text: `Critical risk ${'x'.repeat(1_000)}`,
      severity: 'HIGH',
      category: 'delivery',
      sourceQuote: 'Evidence '.repeat(100),
    }));
    analysis.opportunities = Array.from({ length: 30 }, () => ({
      text: `Opportunity ${'x'.repeat(1_000)}`,
      estimatedValue: 'HIGH',
      category: 'growth',
      sourceQuote: '',
    }));
    analysis.actionItems = Array.from({ length: 30 }, () => ({
      title: `Action ${'x'.repeat(1_000)}`,
      assignee: 'Owner',
      dueDate: '2026-10-16',
      priority: 'HIGH',
      sourceQuote: '',
      status: 'OPEN',
    }));
    fetchMock.mockImplementation(async (input) =>
      json(String(input).includes('/search?') ? { items: [{ id: ID }] } : detail),
    );

    const result = await fetchMeetingContext(API, 'Review');
    expect(result.text).toContain('Decisions:');
    expect(result.text).toContain('Critical risk');
    expect(result.text).toContain('Opportunity');
    expect(result.text).toContain('Meeting action items');
    expect(result.text).toContain('More items exist');
    expect(result.text).not.toContain('<summary>');
    expect(result.text.length).toBeLessThan(7_000);
  });

  it('bounds stalled internal calls and degrades without inventing empty evidence', async () => {
    fetchMock.mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('timed out')), {
            once: true,
          });
        }),
    );
    expect(await fetchMeetingContext({ ...API, timeoutMs: 5 }, 'Question')).toEqual({
      text: '',
      sources: [],
    });
  });

  it('redacts source labels and preserves numeric UUID links', () => {
    const result = formatMeetingSources([
      { reference: 'M1', id: ID, title: 'Review [x] <note> person@example.com' },
    ]);
    expect(result).not.toContain('person@example.com');
    expect(result).not.toContain('<note>');
    expect(result).toContain('\\[x\\]');
    expect(result).toContain(`(/meetings/${ID})`);
  });
});

describe('pending task context', () => {
  it('requests both pending statuses and excludes completed tasks before budgeting', async () => {
    fetchMock.mockImplementation(async (input) => {
      const status = new URL(String(input)).searchParams.get('status');
      return json({
        items: [
          {
            id: 'done',
            status: 'DONE',
            title: 'Already delivered',
            priority: 'HIGH',
            meetingTitle: 'Old meeting',
          },
          {
            id: status,
            status,
            title: `Pending ${status}`,
            priority: 'HIGH',
            assignee: 'Owner',
            dueDate: '2026-10-16',
            meetingTitle: 'Review',
          },
        ],
        totalItems: 1,
      });
    });

    const result = await fetchPendingTaskContext(API);
    expect(result.text).toContain('Pending OPEN');
    expect(result.text).toContain('Pending IN_PROGRESS');
    expect(result.text).not.toContain('Already delivered');
    expect(result.text).toContain('Assignee: Owner');
    expect(result.items.map((task) => task.status)).toEqual(['OPEN', 'IN_PROGRESS']);
    expect(result.partial).toBe(false);
    expect(
      fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('status')),
    ).toEqual(['OPEN', 'IN_PROGRESS']);
  });

  it('keeps available tasks when one status fails and labels incomplete coverage', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('IN_PROGRESS')) throw new Error('unavailable');
      return json({
        items: [
          { status: 'OPEN', title: 'Deliver proposal', priority: 'HIGH', meetingTitle: 'Review' },
        ],
        totalItems: 24,
      });
    });
    const result = await fetchPendingTaskContext(API);
    expect(result.text).toContain('Deliver proposal');
    expect(result.text).toContain('Partial list');
    expect(result.text).not.toContain('No pending tasks found');
    expect(result.items.map((task) => task.title)).toEqual(['Deliver proposal']);
    expect(result.partial).toBe(true);
  });

  it('returns no evidence when both queries fail rather than claiming no tasks exist', async () => {
    fetchMock.mockRejectedValue(new Error('unavailable'));
    expect(await fetchPendingTaskContext(API)).toEqual({ text: '', items: [], partial: true });
  });

  it('bounds each status after excluding completed tasks and reports truncated coverage', async () => {
    fetchMock.mockImplementation(async (input) => {
      const status = new URL(String(input)).searchParams.get('status');
      return json({
        items: [
          { status: 'DONE', title: 'Already delivered' },
          ...Array.from({ length: 24 }, (_, i) => ({
            id: `${status}-${i}`,
            status,
            title: `Pending ${status} ${i}`,
            priority: 'HIGH',
            meetingTitle: 'Review',
          })),
        ],
        totalItems: 24,
      });
    });
    const result = await fetchPendingTaskContext(API);
    expect(result.items).toHaveLength(20);
    expect(result.items.filter((task) => task.status === 'OPEN')).toHaveLength(10);
    expect(result.items.filter((task) => task.status === 'IN_PROGRESS')).toHaveLength(10);
    expect(result.text).not.toContain('Already delivered');
    expect(result.partial).toBe(true);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(String(url)).searchParams.get('size')).toBe('10');
      expect(options).toMatchObject({ headers: API.headers, cache: 'no-store' });
    }
  });

  it('distinguishes an empty authorized query from an unavailable task list', async () => {
    fetchMock.mockImplementation(async () => json({ items: [], totalItems: 0 }));
    const result = await fetchPendingTaskContext(API);
    expect(result.items).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.text).toContain('No pending tasks found in authorized meetings');
  });
});
