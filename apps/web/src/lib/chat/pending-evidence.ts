import { redactPii } from '@/lib/pii/redact';
import {
  clampContextValue,
  type MeetingSource,
  type PendingTaskContext,
} from './workspace-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: string, max: number): string {
  return clampContextValue(redactPii(value), max).replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function dueDate(value?: string): string | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return `${day}/${month}/${year}`;
}

/** Append the queried current tasks without relying on the model to enumerate them. */
export function formatPendingTaskEvidence(
  tasks: PendingTaskContext,
  sources: MeetingSource[],
): string {
  const pending = tasks.items.filter(
    (task) => task.status === 'OPEN' || task.status === 'IN_PROGRESS',
  );
  const authorizedSources = new Map(
    sources.filter((source) => UUID.test(source.id)).map((source) => [source.id, source]),
  );
  const lines = [`## Pendências consultadas (${pending.length})`];
  if (tasks.partial)
    lines.push(
      '',
      'Cobertura parcial: algumas tarefas não foram recuperadas ou excederam o limite de 10 por estado. Consulte Tarefas para a lista completa.',
    );
  lines.push('');
  if (pending.length === 0) {
    lines.push(
      tasks.partial
        ? 'Nenhuma pendência recuperada nesta consulta parcial.'
        : 'Nenhuma pendência encontrada nas reuniões autorizadas.',
    );
    return lines.join('\n');
  }
  for (const task of pending) {
    const fields = [text(task.title, 250), task.status === 'OPEN' ? 'Aberta' : 'Em andamento'];
    if (task.assignee?.trim()) fields.push(`Responsável: ${text(task.assignee, 100)}`);
    const deadline = dueDate(task.dueDate);
    if (deadline) fields.push(`Prazo: ${deadline}`);
    const source = authorizedSources.get(task.meetingId);
    if (source) fields.push(`Fonte: [${text(source.title, 180)}](/meetings/${source.id})`);
    else if (task.meetingTitle?.trim()) fields.push(`Fonte: ${text(task.meetingTitle, 180)}`);
    lines.push(`- ${fields.join(' · ')}`);
  }
  return lines.join('\n');
}
