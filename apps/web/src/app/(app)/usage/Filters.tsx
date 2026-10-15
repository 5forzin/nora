"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { useEffect, useState } from "react";
import type { TrendsGranularity } from "@/lib/api/client";
import { reportingDateInput, reportingDateRange } from "@/lib/trends/date-range";

interface Props {
  granularity: TrendsGranularity;
  from?: string;
  to?: string;
  timezone?: string;
}

/**
 * Same filter bar as the trends panel — a form that rewrites the query string and lets the Server
 * Component refetch — with the default flipped: consumption is read per month, so `MONTH` is the
 * state with no query parameter and `WEEK` is the one that writes it.
 */
export default function UsageFilters({ granularity, from, to, timezone }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [unit, setUnit] = useState<TrendsGranularity>(granularity);
  const [start, setStart] = useState(reportingDateInput(from, timezone));
  const [end, setEnd] = useState(reportingDateInput(to, timezone, true));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = params.get("granularity");
    setUnit(raw === "WEEK" ? "WEEK" : "MONTH");
    setStart(reportingDateInput(params.get("from"), timezone));
    setEnd(reportingDateInput(params.get("to"), timezone, true));
    setError(null);
  }, [params, timezone]);

  function apply(e?: React.FormEvent) {
    e?.preventDefault();
    const qs = new URLSearchParams();
    if (unit === "WEEK") qs.set("granularity", "WEEK");
    try {
      const range = reportingDateRange(start, end, timezone);
      if (range.from) qs.set("from", range.from);
      if (range.to) qs.set("to", range.to);
    } catch {
      setError(timezone ? "Informe datas válidas e um fim igual ou posterior ao início." : "O fuso do relatório não está disponível. Recarregue a página antes de filtrar por data.");
      return;
    }
    setError(null);
    const q = qs.toString();
    router.push((q ? `/usage?${q}` : "/usage") as Route);
  }

  function clear() {
    setUnit("MONTH");
    setStart("");
    setEnd("");
    setError(null);
    router.push("/usage" as Route);
  }

  const hasAny = Boolean(unit === "WEEK" || start || end);

  return (
    <form onSubmit={apply} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <select
        className="select"
        value={unit}
        onChange={(e) => setUnit(e.target.value === "WEEK" ? "WEEK" : "MONTH")}
        aria-label="Agrupar por"
      >
        <option value="MONTH">Por mês</option>
        <option value="WEEK">Por semana</option>
      </select>
      <input
        className="input"
        type="date"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        aria-label="De"
      />
      <input
        className="input"
        type="date"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        aria-label="Até"
      />
      <button className="btn btn-primary btn-sm" type="submit" style={{ borderRadius: 8 }}>
        Aplicar
      </button>
      {hasAny && (
        <button className="btn btn-ghost btn-sm" type="button" onClick={clear}>
          Limpar
        </button>
      )}
      {error && <div role="alert" className="notice notice--danger" style={{ flexBasis: "100%" }}>{error}</div>}
    </form>
  );
}
