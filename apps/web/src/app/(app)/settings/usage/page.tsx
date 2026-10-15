import type { Route } from "next";
import { requireWorkspacePermission } from "@/lib/enterprise/require-permission";
import Link from "next/link";

import { getUsage } from "@/lib/api/client";
import type { TrendsGranularity, UsageAiBucket, UsageResponse } from "@/lib/api/types";
import { formatCost, serviceLabel } from "@/lib/report/usage-report";
import { barHeightPercent, bucketLabel, bucketRange } from "@/lib/trends/format";
import UsageExportMenu from "./export-menu";
import UsageFilters from "./Filters";
import { SettingsNavigation } from "@/components/settings-navigation";

export const dynamic = "force-dynamic";

/**
 * Tenant usage panel (US33) and the entry point of the consolidated period report (US34).
 *
 * The pipeline behind it was already there with only its operator end built: every external AI
 * call is recorded with tenant, service, tokens and cost, and the platform owner could read it.
 * This is the half where the tenant reads their own line of it.
 *
 * The screen never infers emptiness or availability from the numbers. `dataState` and `ai.state`
 * come from the API precisely so that "nothing yet", "a period with no activity" and "this
 * deployment cannot tell you" render as three different sentences — a zero that actually means
 * "the control plane is off" is a claim the reader has no way to check.
 */

function isGranularity(value: string | undefined): value is TrendsGranularity {
  return value === "WEEK" || value === "MONTH";
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card" style={{ flex: "1 1 150px", minWidth: 140 }}>
      <div className="sec-label">{label}</div>
      <div
        style={{
          fontFamily: "var(--display)",
          fontSize: 24,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          marginTop: 6,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--muted)" }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}

/**
 * Meetings held vs analysed per period. Plain flex columns rather than a charting library, same as
 * the trends panel: the repo has none and this needs two bars per period, not a plotting engine.
 */
function MeetingsChart({ data }: { data: UsageResponse }) {
  const points = data.meetingBuckets;
  const max = Math.max(1, ...points.map((p) => Math.max(p.meetings, p.analysedMeetings)));
  return (
    <div>
      <div style={{ display: "flex", gap: 14, marginBottom: 10 }}>
        <Swatch color="var(--accent-ink)" label="Reuniões" />
        <Swatch color="var(--success)" label="Analisadas" />
      </div>
      <div
        role="img"
        aria-label={`Reuniões e reuniões analisadas por ${data.granularity === "MONTH" ? "mês" : "semana"}`}
        style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 150, paddingTop: 4 }}
      >
        {points.map((p) => {
          const range = bucketRange(p.bucketStart, data.granularity);
          return (
            <div
              key={p.bucketStart}
              title={`${range.start} a ${range.end} · ${p.meetings} reuniões · ${p.analysedMeetings} analisadas`}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%" }}
            >
              <div style={{ flex: 1, width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 3 }}>
                <span
                  style={{
                    width: "42%",
                    maxWidth: 18,
                    height: `${barHeightPercent(p.meetings, max)}%`,
                    background: "var(--accent-ink)",
                    borderRadius: "3px 3px 0 0",
                  }}
                />
                <span
                  style={{
                    width: "42%",
                    maxWidth: 18,
                    height: `${barHeightPercent(p.analysedMeetings, max)}%`,
                    background: "var(--success)",
                    borderRadius: "3px 3px 0 0",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {points.map((p) => (
          <div
            key={p.bucketStart}
            style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden" }}
          >
            {bucketLabel(p.bucketStart, data.granularity)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** AI calls per period. One series, so a single bar per bucket. */
function CallsChart({ buckets, granularity }: { buckets: UsageAiBucket[]; granularity: TrendsGranularity }) {
  const max = Math.max(1, ...buckets.map((b) => b.calls));
  return (
    <div>
      <div
        role="img"
        aria-label={`Chamadas de IA por ${granularity === "MONTH" ? "mês" : "semana"}`}
        style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 110, paddingTop: 4 }}
      >
        {buckets.map((b) => (
          <div
            key={b.bucketStart}
            title={`${b.calls} chamadas · ${b.promptTokens + b.completionTokens} tokens`}
            style={{ flex: 1, display: "flex", alignItems: "flex-end", justifyContent: "center", height: "100%" }}
          >
            <span
              style={{
                width: "60%",
                maxWidth: 26,
                height: `${barHeightPercent(b.calls, max)}%`,
                background: "var(--accent)",
                borderRadius: "3px 3px 0 0",
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {buckets.map((b) => (
          <div
            key={b.bucketStart}
            style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden" }}
          >
            {bucketLabel(b.bucketStart, granularity)}
          </div>
        ))}
      </div>
    </div>
  );
}

function NotEnoughData({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref: Route;
  ctaLabel: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        padding: "64px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 460 }}>
        <h2
          style={{
            fontFamily: "var(--display)",
            fontSize: 19,
            fontWeight: 500,
            letterSpacing: "-0.018em",
            margin: "0 0 6px",
            color: "var(--ink)",
          }}
        >
          {title}
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--muted)", margin: 0, lineHeight: 1.55 }}>{body}</p>
      </div>
      <Link href={ctaHref} className="btn btn-primary">
        {ctaLabel}
      </Link>
    </div>
  );
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ granularity?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const access = await requireWorkspacePermission('readMeetings');
  const granularity: TrendsGranularity = isGranularity(sp.granularity) ? sp.granularity : "MONTH";

  let data: UsageResponse | null = null;
  let errorMessage: string | null = null;
  try {
    data = await getUsage({ granularity, from: sp.from || undefined, to: sp.to || undefined });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Falha ao carregar o consumo.";
  }

  const unitLabel = (data?.granularity ?? granularity) === "MONTH" ? "mês" : "semana";
  const aiMeasured = data?.ai.state === "AVAILABLE";

  return (
    <div className="set-layout">
      <SettingsNavigation section="consumo" />
      <div className="set-pane set-pane--wide">
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <div>
          <h2 className="h2">Consumo</h2>
        </div>
        {data && <UsageExportMenu data={data} />}
      </header>

      <UsageFilters granularity={granularity} from={sp.from} to={sp.to} timezone={data?.timezone} />

      {errorMessage && (
        <div className="notice" style={{ marginTop: 16 }}>
          Não foi possível carregar o consumo. {errorMessage}
        </div>
      )}

      {data && data.dataState === "NO_DATA" && (
        <NotEnoughData
          title="Sem consumo no período"
          body="Nenhuma reunião ou chamada de IA registrada. Selecione outro período."
          ctaHref={(access.permissions.createMeetings ? '/meetings/upload' : '/dashboard') as Route}
          ctaLabel={access.permissions.createMeetings ? 'Fazer upload' : 'Ver reuniões'}
        />
      )}

      {data && data.dataState === "NO_ANALYSED_MEETINGS" && (
        <NotEnoughData
          title="Sem consumo no período"
          body={`${data.meetings} ${data.meetings === 1 ? "reunião recebida" : "reuniões recebidas"}, ainda sem análise ou chamadas de IA registradas.`}
          ctaHref={"/dashboard" as Route}
          ctaLabel="Ver reuniões"
        />
      )}

      {data && data.dataState === "OK" && (
        <>
          <section style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <h3 className="sec-label">Reuniões</h3>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
              <StatTile label="Reuniões no período" value={String(data.meetings)} hint={`por ${unitLabel}, no recorte atual`} />
              <StatTile
                label="Analisadas"
                value={String(data.analysedMeetings)}
                hint="as que geraram resumo, tarefas e temas"
              />
              <StatTile
                label="Chamadas de IA"
                value={aiMeasured ? String(data.ai.calls) : "—"}
                hint={aiMeasured ? "no recorte atual, falhas incluídas" : "não informado neste recorte"}
              />
              <StatTile
                label="Custo estimado"
                value={aiMeasured ? `US$ ${formatCost(data.ai.costUsd)}` : "—"}
                hint="estimativa de tabela, não é fatura"
              />
            </div>

            <MeetingsChart data={data} />
          </section>

          <section style={{ marginTop: 40 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h3 className="sec-label">Consumo de IA</h3>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              {aiMeasured && (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  {data.ai.promptTokens + data.ai.completionTokens} tokens
                </span>
              )}
            </div>

            {data.ai.state === "UNAVAILABLE" && (
              <div className="notice">
                O consumo de IA não está disponível. As contagens de reuniões continuam acessíveis.
              </div>
            )}

            {data.ai.state === "WITHHELD_RESTRICTED_SCOPE" && (
              <div className="notice">
                O total de IA do workspace está oculto porque seu acesso a reuniões é restrito. As contagens acima respeitam suas permissões.
              </div>
            )}

            {aiMeasured && (
              <>
                <CallsChart buckets={data.ai.buckets} granularity={data.granularity} />

                <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 2 }}>
                  {data.ai.byService.map((s) => (
                    <div
                      key={s.service}
                      className="grid grid-cols-2 xl:grid-cols-[minmax(0,1fr)_90px_110px_100px]"
                      style={{
                        alignItems: "baseline",
                        gap: 12,
                        padding: "8px 0",
                        borderTop: "1px solid var(--border)",
                        fontSize: 13,
                      }}
                    >
                      <span style={{ flex: "1 1 40%" }}>{serviceLabel(s.service)}</span>
                      <span style={{ flex: "0 0 96px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {s.calls} {s.calls === 1 ? "chamada" : "chamadas"}
                      </span>
                      <span
                        style={{
                          flex: "0 0 130px",
                          textAlign: "right",
                          color: "var(--muted)",
                          fontSize: 12,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {s.metered
                          ? `${s.promptTokens + s.completionTokens} tokens`
                          : "sem tokens a medir"}
                      </span>
                      <span
                        style={{
                          flex: "0 0 120px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: s.metered ? "var(--ink)" : "var(--muted)",
                          fontSize: 12.5,
                        }}
                      >
                        {s.metered ? `US$ ${formatCost(s.costUsd)}` : "não medido"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <footer
            style={{
              marginTop: 44,
              paddingTop: 16,
              borderTop: "1px solid var(--border)",
              fontSize: 11.5,
              color: "var(--muted)",
              lineHeight: 1.6,
            }}
          >
            <p style={{ margin: 0 }}>
              Estimativa pelo preço de tabela e tokens registrados. Não inclui infraestrutura e não é uma fatura.
            </p>
            {aiMeasured && data.ai.unmeteredCalls > 0 && (
              <p style={{ margin: "6px 0 0" }}>
                {data.ai.unmeteredCalls} sessões de transcrição incluídas nas chamadas, sem tokens ou custo medidos.
              </p>
            )}
            <p style={{ margin: "6px 0 0" }}>
              Fuso do relatório: {data.timezone}.
            </p>
          </footer>
        </>
      )}
      </div>
    </div>
  );
}
