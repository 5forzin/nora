package br.com.nora.api.infrastructure.persistence.identity;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface McpTokenJpaRepository extends JpaRepository<McpTokenJpaEntity, UUID> {

    Optional<McpTokenJpaEntity> findByTokenHash(String tokenHash);

    List<McpTokenJpaEntity> findAllByTenantIdAndUserIdOrderByCreatedAtDesc(
            UUID tenantId, UUID userId);

    Optional<McpTokenJpaEntity> findByIdAndTenantIdAndUserId(UUID id, UUID tenantId, UUID userId);

    @Modifying
    @Query(
            """
            update McpTokenJpaEntity t set t.lastUsedAt = :usedAt
            where t.id = :id and t.tenantId = :tenantId and t.userId = :userId
              and t.revokedAt is null and (t.expiresAt is null or t.expiresAt > :usedAt)
              and (t.lastUsedAt is null or t.lastUsedAt < :usedAt)
            """)
    int updateLastUsedAt(
            @Param("id") UUID id,
            @Param("tenantId") UUID tenantId,
            @Param("userId") UUID userId,
            @Param("usedAt") Instant usedAt);
}
