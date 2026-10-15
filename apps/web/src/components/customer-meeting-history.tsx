import Link from 'next/link';
import type { Route } from 'next';
import { getCustomerMeetingHistory } from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';

export async function CustomerMeetingHistory({ clientCode, currentMeetingId }: { clientCode: string; currentMeetingId: string }) {
  let history;
  try {
    history = await getCustomerMeetingHistory(clientCode);
  } catch {
    return <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Histórico indisponível no momento.</p>;
  }
  const meetings = history.items.filter((meeting) => meeting.id !== currentMeetingId);
  return (
    <div>
      <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 12px', overflowWrap: 'anywhere' }}>Cliente {clientCode} · outras reuniões com este código</p>
      {meetings.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Nenhuma outra reunião acessível.</p>
      ) : (
        <ul className="m-0 list-none divide-y p-0" style={{ borderColor: 'var(--border)' }}>
          {meetings.map((meeting) => (
            <li key={meeting.id} style={{ padding: '12px 0' }}>
              <Link href={`/meetings/${meeting.id}` as Route} style={{ color: 'var(--accent-ink)', fontSize: 13.5, overflowWrap: 'anywhere' }}>{meeting.title}</Link>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{meeting.startedAt ? formatDateTime(meeting.startedAt) : 'Data não informada'}</div>
              {meeting.summarySnippet && <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{meeting.summarySnippet}</p>}
            </li>
          ))}
        </ul>
      )}
      {history.truncated && <p style={{ color: 'var(--muted)', fontSize: 12, margin: '12px 0 0' }}>O histórico atingiu o limite de exibição.</p>}
    </div>
  );
}
