package br.com.nora.api.infrastructure.persistence.embedding;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MeetingEmbeddingJpaRepository
        extends JpaRepository<MeetingEmbeddingJpaEntity, UUID> {

    List<MeetingEmbeddingJpaEntity> findByTenantIdAndModel(UUID tenantId, String model);

    /**
     * Upsert by meeting_id (re-analysis overwrites). Under RLS enforce, tenant_id matches the GUC.
     */
    @Modifying
    @Query(
            value =
                    "INSERT INTO meeting_embeddings"
                            + " (meeting_id, tenant_id, model, dim, embedding, source_chars, created_at,"
                            + " updated_at) VALUES (:meetingId, :tenantId, :model, :dim, :embedding,"
                            + " :sourceChars, now(), now()) ON CONFLICT (meeting_id) DO UPDATE SET model"
                            + " = EXCLUDED.model, dim = EXCLUDED.dim, embedding = EXCLUDED.embedding,"
                            + " source_chars = EXCLUDED.source_chars, updated_at = now()",
            nativeQuery = true)
    void upsert(
            @Param("meetingId") UUID meetingId,
            @Param("tenantId") UUID tenantId,
            @Param("model") String model,
            @Param("dim") int dim,
            @Param("embedding") String embedding,
            @Param("sourceChars") int sourceChars);

    /**
     * Backfill candidates have an analysis and a missing, wrong-model or truncated-summary vector.
     * Newest first. Under RLS enforce all tables are filtered by the GUC the caller set.
     *
     * <p>{@code m.deleted_at IS NULL} because native SQL does not see the entity's
     * {@code @SQLRestriction}: a soft-deleted meeting is invisible to the product, so paying an
     * external embedding call to index it would spend money on a row nothing can ever search.
     */
    @Query(
            value =
                    "SELECT m.id, a.summary FROM meetings m JOIN meeting_analyses a"
                            + " ON a.meeting_id = m.id AND a.tenant_id = m.tenant_id"
                            + " LEFT JOIN meeting_embeddings e"
                            + " ON e.meeting_id = m.id AND e.tenant_id = m.tenant_id"
                            + " WHERE m.tenant_id = :tenantId AND"
                            + " m.deleted_at IS NULL AND"
                            + " btrim(a.summary) <> ''"
                            + " AND (e.meeting_id IS NULL OR e.model <> :model"
                            + " OR e.source_chars <> char_length(a.summary)) ORDER BY"
                            + " m.created_at DESC LIMIT :limit",
            nativeQuery = true)
    List<Object[]> findPendingIndex(
            @Param("tenantId") UUID tenantId,
            @Param("model") String model,
            @Param("limit") int limit);

    /** Same predicate as {@link #findPendingIndex}, counted without the ceiling. */
    @Query(
            value =
                    "SELECT COUNT(*) FROM meetings m JOIN meeting_analyses a"
                            + " ON a.meeting_id = m.id AND a.tenant_id = m.tenant_id"
                            + " LEFT JOIN meeting_embeddings e"
                            + " ON e.meeting_id = m.id AND e.tenant_id = m.tenant_id"
                            + " WHERE m.tenant_id = :tenantId AND m.deleted_at IS NULL"
                            + " AND btrim(a.summary) <> '' AND (e.meeting_id IS NULL"
                            + " OR e.model <> :model OR e.source_chars <> char_length(a.summary))",
            nativeQuery = true)
    long countPendingIndex(@Param("tenantId") UUID tenantId, @Param("model") String model);
}
