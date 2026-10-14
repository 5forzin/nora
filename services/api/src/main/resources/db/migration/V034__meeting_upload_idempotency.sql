-- Keys survive meeting erasure, preventing an offline retry from recreating removed content.
-- No transcript or metadata is stored here; the fingerprint detects accidental key reuse.
ALTER TABLE meetings ADD CONSTRAINT meetings_tenant_id_id_uk UNIQUE (tenant_id, id);

CREATE TABLE meeting_upload_requests (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    fingerprint CHAR(64) NOT NULL,
    meeting_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, user_id, idempotency_key),
    CONSTRAINT meeting_upload_requests_user_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT meeting_upload_requests_meeting_fk
        FOREIGN KEY (tenant_id, meeting_id) REFERENCES meetings(tenant_id, id)
        ON DELETE SET NULL (meeting_id) DEFERRABLE INITIALLY DEFERRED
);

-- The deferred FK allows JDBC to record the result before JPA flushes the meeting at commit.
CREATE INDEX idx_meeting_upload_requests_meeting ON meeting_upload_requests (tenant_id, meeting_id)
    WHERE meeting_id IS NOT NULL;

ALTER TABLE meeting_upload_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meeting_upload_requests
    USING (tenant_id = nora.current_tenant_id())
    WITH CHECK (tenant_id = nora.current_tenant_id());
