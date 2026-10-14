package br.com.nora.api.application.ports;

import java.util.UUID;

/** Persistent upload deduplication, including tombstones for erased meetings. */
public interface MeetingUploadRepository {
    boolean reserve(UUID tenantId, UUID userId, String key, String fingerprint);

    Upload find(UUID tenantId, UUID userId, String key);

    void complete(UUID tenantId, UUID userId, String key, UUID meetingId);

    record Upload(String fingerprint, UUID meetingId) {}
}
