import type { AnalysisQuality, EvidenceCounts } from '@/lib/api/types';

function count(value: number): string {
  return value.toLocaleString('pt-BR');
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[12.5px]">
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd className="m-0 shrink-0 tabular-nums">{value === null ? 'Não disponível' : count(value)}</dd>
    </div>
  );
}

export default function AnalysisQualityPanel({ quality, expanded = false, showCommercial = false }: {
  quality: AnalysisQuality;
  expanded?: boolean;
  showCommercial?: boolean;
}) {
  const { transcript, extraction } = quality;
  const groups: { label: string; counts: EvidenceCounts }[] = [
    { label: 'Tarefas', counts: extraction.actionItems },
    { label: 'Riscos', counts: extraction.risks },
    { label: 'Oportunidades', counts: extraction.opportunities },
    ...(showCommercial && extraction.commercial ? [
      { label: 'Produtos', counts: extraction.commercial.products },
      { label: 'Pessoas e papéis', counts: extraction.commercial.personas },
      { label: 'Valores', counts: extraction.commercial.budgets },
      { label: 'Sentimento por tópico', counts: extraction.commercial.sentimentByTopic },
    ] : []),
  ];
  const total = groups.reduce((sum, group) => sum + group.counts.total, 0);
  const withQuote = groups.reduce((sum, group) => sum + group.counts.withSourceQuote, 0);
  const hasMatches = groups.some((group) => group.counts.matchedSourceQuote !== null);
  const content = (
    <div className="grid min-w-0 gap-6 pt-4 md:grid-cols-2">
      <section aria-label="Texto recebido" className="min-w-0">
        <h3 className="m-0 mb-2 text-[13px] font-medium">Texto recebido</h3>
        {transcript ? <dl className="m-0">
          <Metric label="Caracteres" value={transcript.characterCount} />
          <Metric label="Linhas com conteúdo" value={transcript.nonEmptyLineCount} />
          <Metric label="Linhas repetidas" value={transcript.duplicateLineCount} />
          <Metric label="Caracteres de substituição (�)" value={transcript.replacementCharacterCount} />
          <Metric label="Caracteres de controle" value={transcript.controlCharacterCount} />
          {transcript.speakerLabelCount !== null && <>
            <Metric label="Rótulos de locutor" value={transcript.speakerLabelCount} />
            <Metric label="Turnos identificados" value={transcript.labeledTurnCount} />
            <Metric label="Turnos vazios" value={transcript.emptyLabeledTurnCount} />
          </>}
        </dl> : <p className="m-0 text-[12.5px]" style={{ color: 'var(--muted)' }}>Texto não disponível para contagem.</p>}
      </section>
      <section aria-label="Fontes dos itens extraídos" className="min-w-0">
        <h3 className="m-0 mb-2 text-[13px] font-medium">Fontes dos itens extraídos</h3>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-2 text-[12px]">
          <span />
          <span style={{ color: 'var(--muted)' }}>Com fonte</span>
          <span style={{ color: 'var(--muted)' }}>Encontrada</span>
          {groups.map(({ label, counts }) => (
            <div key={label} className="contents">
              <span>{label}</span>
              <span className="text-right tabular-nums" aria-label={`${label}: ${counts.withSourceQuote} de ${counts.total} com fonte`}>{counts.withSourceQuote}/{counts.total}</span>
              <span className="text-right tabular-nums" aria-label={`${label}: ${counts.matchedSourceQuote === null ? 'correspondência não disponível' : `${counts.matchedSourceQuote} fontes encontradas no texto protegido`}`}>{counts.matchedSourceQuote === null ? '—' : counts.matchedSourceQuote}</span>
            </div>
          ))}
        </div>
        <p className="mb-0 mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {hasMatches ? 'Correspondência verificada no texto protegido, com espaços normalizados.' : 'Correspondência indisponível nesta análise anterior.'}
        </p>
        {extraction.actionItems.total > 0 && <p className="mb-0 mt-3 text-[12px]" style={{ color: 'var(--muted)' }}>
          {quality.origin === 'WORKER' ? 'Na extração' : 'Nas tarefas registradas'}: {extraction.actionItemsWithAssignee}/{extraction.actionItems.total} com responsável · {extraction.actionItemsWithDueDate}/{extraction.actionItems.total} com prazo.
        </p>}
      </section>
      <p className="m-0 text-[11.5px] leading-relaxed md:col-span-2" style={{ color: 'var(--muted)' }}>
        Estas contagens não medem a precisão da transcrição ou da interpretação da IA.
      </p>
    </div>
  );
  if (expanded) return content;
  return (
    <details className="card card--pad min-w-0">
      <summary className="cursor-pointer text-[13px] font-medium">
        Qualidade dos dados
        {total > 0 && <span className="ml-3 inline-block text-[12px] font-normal" style={{ color: 'var(--muted)' }}>{withQuote}/{total} itens com fonte</span>}
      </summary>
      {content}
    </details>
  );
}
