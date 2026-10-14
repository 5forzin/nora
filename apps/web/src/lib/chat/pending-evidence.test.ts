import { describe, expect, it } from 'vitest';
import type { TaskListItemDto } from '@/lib/api/client';
import { formatPendingTaskEvidence } from './pending-evidence';
import type { MeetingSource, PendingTaskContext } from './workspace-context';

const SALES_ID = '12345678-9012-4012-8012-123456789012';
const OPS_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNKNOWN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOURCES: MeetingSource[] = [
  { reference: 'M1', id: SALES_ID, title: 'Comercial — condições do piloto' },
  { reference: 'M2', id: OPS_ID, title: 'Operações — prazo confirmado' },
];

function task(overrides: Partial<TaskListItemDto> = {}): TaskListItemDto {
  return {
    id: 'task-1',
    title: 'Confirmar as condições por escrito',
    status: 'OPEN',
    priority: 'HIGH',
    assignee: 'Comercial',
    dueDate: '2026-10-16',
    meetingId: SALES_ID,
    meetingTitle: SOURCES[0].title,
    updatedAt: '2026-10-14T13:00:00Z',
    ...overrides,
  };
}

function context(items: TaskListItemDto[], partial = false): PendingTaskContext {
  return { text: 'Untrusted model context is not copied.', items, partial };
}

describe('current pending task evidence', () => {
  it('lists every queried pending task across areas and excludes completed work', () => {
    const evidence = formatPendingTaskEvidence(
      context([
        task(),
        task({
          id: 'task-2',
          title: 'Preparar o plano de instalação',
          status: 'IN_PROGRESS',
          assignee: 'Operações',
          dueDate: '2026-10-21',
          meetingId: OPS_ID,
        }),
        task({ id: 'task-3', title: 'Negociar o orçamento', assignee: 'Financeiro' }),
        task({ id: 'done', title: 'Revisar o documento', status: 'DONE' }),
      ]),
      SOURCES,
    );
    expect(evidence).toContain('## Pendências consultadas (3)');
    expect(evidence).toContain('Confirmar as condições por escrito · Aberta');
    expect(evidence).toContain('Preparar o plano de instalação · Em andamento');
    expect(evidence).toContain('Responsável: Comercial · Prazo: 16/10/2026');
    expect(evidence).toContain('Responsável: Operações · Prazo: 21/10/2026');
    expect(evidence).toContain('Responsável: Financeiro');
    expect(evidence).toContain(`](/meetings/${SALES_ID})`);
    expect(evidence).toContain(`](/meetings/${OPS_ID})`);
    expect(evidence).not.toContain('Revisar o documento');
    expect(evidence).not.toContain('Untrusted model context');
    expect(evidence).not.toContain('Cobertura parcial');
  });

  it('keeps unknown or invalid sources as escaped inactive labels', () => {
    const evidence = formatPendingTaskEvidence(
      context([
        task({ meetingId: UNKNOWN_ID, meetingTitle: 'Restrita [x](https://example.com)' }),
        task({ id: 'invalid', meetingId: '../admin', meetingTitle: 'Invalid source' }),
      ]),
      [...SOURCES, { reference: 'M3', id: '../admin', title: 'Invalid source' }],
    );
    expect(evidence).not.toContain('](/meetings/');
    expect(evidence).not.toContain(UNKNOWN_ID);
    expect(evidence).not.toContain('../admin');
    expect(evidence).toContain('Fonte: Restrita \\[x\\]\\(https://example\\.com\\)');
  });

  it('redacts fields before adding trusted numeric UUIDs and escapes Markdown injection', () => {
    const evidence = formatPendingTaskEvidence(
      context([
        task({
          title: 'Consultar [cliente](https://evil.invalid) <script> person@example.com',
          assignee: 'Contato (11) 98765-4321',
          meetingTitle: 'unused raw@example.com',
        }),
      ]),
      [{ reference: 'M1', id: SALES_ID, title: 'Review *budget* contact@example.com' }],
    );
    expect(evidence).not.toContain('person@example.com');
    expect(evidence).not.toContain('contact@example.com');
    expect(evidence).not.toContain('raw@example.com');
    expect(evidence).not.toContain('(11) 98765-4321');
    expect(evidence).not.toContain('<script>');
    expect(evidence).toContain('\\[cliente\\]\\(https://evil\\.invalid\\)');
    expect(evidence).toContain('Review \\*budget\\*');
    expect(evidence).toContain('EMAIL');
    expect(evidence).toContain('PHONE');
    expect(evidence).toContain(`](/meetings/${SALES_ID})`);
  });

  it('does not invent missing owners or deadlines and rejects invalid calendar dates', () => {
    const evidence = formatPendingTaskEvidence(
      context([
        task({ assignee: undefined, dueDate: undefined }),
        task({ id: 'invalid-date', assignee: ' ', dueDate: '2026-02-30' }),
        task({ id: 'invalid-format', assignee: undefined, dueDate: 'next Friday' }),
      ]),
      SOURCES,
    );
    expect(evidence).not.toContain('Responsável:');
    expect(evidence).not.toContain('Prazo:');
    expect(evidence).not.toContain('next Friday');
    expect(evidence).not.toContain('30/02/2026');
  });

  it('labels the bounded twenty-item query as partial without dropping its items', () => {
    const evidence = formatPendingTaskEvidence(
      context(
        Array.from({ length: 20 }, (_, i) => task({ id: `task-${i}`, title: `Tarefa ${i}` })),
        true,
      ),
      SOURCES,
    );
    expect(evidence).toContain('## Pendências consultadas (20)');
    expect(evidence).toContain('Cobertura parcial');
    expect(evidence).toContain('limite de 10 por estado');
    expect(evidence.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(20);
    expect(evidence).toContain('Tarefa 19');
  });

  it('distinguishes empty current data from a failed query', () => {
    const empty = formatPendingTaskEvidence(context([]), SOURCES);
    expect(empty).toContain('## Pendências consultadas (0)');
    expect(empty).toContain('Nenhuma pendência encontrada nas reuniões autorizadas');
    expect(empty).not.toContain('Cobertura parcial');
    const unavailable = formatPendingTaskEvidence({ text: '', items: [], partial: true }, SOURCES);
    expect(unavailable).toContain('Cobertura parcial');
    expect(unavailable).toContain('Nenhuma pendência recuperada nesta consulta parcial');
    expect(unavailable).not.toContain('Nenhuma pendência encontrada');
  });
});
