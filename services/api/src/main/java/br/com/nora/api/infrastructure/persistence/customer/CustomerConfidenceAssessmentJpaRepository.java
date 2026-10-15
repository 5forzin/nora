package br.com.nora.api.infrastructure.persistence.customer;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CustomerConfidenceAssessmentJpaRepository
        extends JpaRepository<CustomerConfidenceAssessmentJpaEntity, UUID> {

    List<CustomerConfidenceAssessmentJpaEntity> findByMeetingIdAndTenantId(
            UUID meetingId, UUID tenantId);

    @Query(
            value =
                    "SELECT a.* FROM customer_confidence_assessments a "
                            + "JOIN meetings prior ON prior.id = a.meeting_id AND prior.tenant_id = a.tenant_id "
                            + "JOIN meetings current ON current.id = :meetingId AND current.tenant_id = :tenantId "
                            + "WHERE a.customer_account_id = :accountId AND a.tenant_id = :tenantId "
                            + "AND prior.deleted_at IS NULL AND current.deleted_at IS NULL "
                            + "AND prior.started_at < current.started_at "
                            + "ORDER BY prior.started_at DESC, prior.id DESC LIMIT 1",
            nativeQuery = true)
    List<CustomerConfidenceAssessmentJpaEntity> findPreviousByEncounterDate(
            @Param("accountId") UUID accountId,
            @Param("tenantId") UUID tenantId,
            @Param("meetingId") UUID meetingId);

    @Modifying
    @Query(
            value =
                    "DELETE FROM customer_confidence_assessments "
                            + "WHERE meeting_id = :meetingId AND tenant_id = :tenantId",
            nativeQuery = true)
    int deleteByMeetingNative(@Param("meetingId") UUID meetingId, @Param("tenantId") UUID tenantId);

    /**
     * Deletes the assessment of a (meeting, account) pair via native SQL so that Postgres' ON
     * DELETE CASCADE removes signals/objections. Avoids the UPDATE assessment_id=NULL round that
     * Hibernate would attempt with orphanRemoval + unidirectional @JoinColumn.
     */
    @Modifying
    @Query(
            value =
                    "DELETE FROM customer_confidence_assessments WHERE meeting_id = :meetingId "
                            + "AND customer_account_id = :customerAccountId AND tenant_id = :tenantId",
            nativeQuery = true)
    int deleteByMeetingAndAccountNative(
            @Param("meetingId") UUID meetingId,
            @Param("customerAccountId") UUID customerAccountId,
            @Param("tenantId") UUID tenantId);
}
