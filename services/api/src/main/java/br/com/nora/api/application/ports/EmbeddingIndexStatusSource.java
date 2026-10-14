package br.com.nora.api.application.ports;

import java.util.List;
import java.util.UUID;

/**
 * Cross-tenant read of how complete the RAG index is — the input to the backfill preview (GET
 * /admin/platform/embeddings/backfill). Operator-only aggregation, deliberately not scoped to one
 * tenant: the question it answers is "who is invisible to semantic search", which cannot be asked
 * one tenant at a time when the operator does not yet know which tenants are behind.
 *
 * <p>It reads and never writes, and it costs nothing: no provider call, only SQL over {@code
 * meetings}, {@code meeting_analyses} and {@code meeting_embeddings}. Same posture as {@code
 * BusinessMetricsSource} (ADR 0024), including which database role answers it — see the adapter.
 */
public interface EmbeddingIndexStatusSource {

    /** Whole-deployment totals for the current {@code modelId}. */
    Totals totals(String modelId);

    /** Per-tenant breakdown, worst first, capped at {@code maxRows}. */
    List<TenantIndexStatus> byTenant(String modelId, int maxRows);

    /** Which datasource answered: {@code telemetry} (BYPASSRLS) or {@code primary}. */
    String source();

    /**
     * Counts over meetings that have an analysed summary. Indexed rows carry a vector from the
     * current model; missingVector has no row at all; staleModel has a row from another provider or
     * model; staleContent has the current model but an incomplete summary payload.
     */
    record Totals(
            long analysedMeetings,
            long indexed,
            long missingVector,
            long staleModel,
            long staleContent) {}

    /** The same counters for one tenant. */
    record TenantIndexStatus(
            UUID tenantId,
            long analysedMeetings,
            long indexed,
            long missingVector,
            long staleModel,
            long staleContent) {}
}
