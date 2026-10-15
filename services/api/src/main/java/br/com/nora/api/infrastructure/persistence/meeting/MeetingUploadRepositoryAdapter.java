package br.com.nora.api.infrastructure.persistence.meeting;

import br.com.nora.api.application.ports.MeetingUploadRepository;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
@Transactional
public class MeetingUploadRepositoryAdapter implements MeetingUploadRepository {
    private final JdbcTemplate jdbc;

    public MeetingUploadRepositoryAdapter(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public boolean reserve(UUID tenantId, UUID userId, String key, String fingerprint) {
        // PostgreSQL waits for a concurrent reservation to commit or roll back before deciding.
        return jdbc.update(
                        """
                        INSERT INTO meeting_upload_requests
                            (tenant_id, user_id, idempotency_key, fingerprint)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING
                        """,
                        tenantId,
                        userId,
                        key,
                        fingerprint)
                == 1;
    }

    @Override
    @Transactional(readOnly = true)
    public Upload find(UUID tenantId, UUID userId, String key) {
        return jdbc.queryForObject(
                """
                SELECT fingerprint, meeting_id FROM meeting_upload_requests
                WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
                """,
                (row, ignored) ->
                        new Upload(
                                row.getString("fingerprint"),
                                row.getObject("meeting_id", UUID.class)),
                tenantId,
                userId,
                key);
    }

    @Override
    public void complete(UUID tenantId, UUID userId, String key, UUID meetingId) {
        jdbc.update(
                """
                UPDATE meeting_upload_requests SET meeting_id = ?
                WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
                """,
                meetingId,
                tenantId,
                userId,
                key);
    }
}
