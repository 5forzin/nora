ALTER TABLE meeting_analyses ADD COLUMN commercial_intelligence JSONB;

CREATE INDEX idx_meetings_tenant_client_chronology
    ON meetings (tenant_id, (attributes ->> 'clientCode'), started_at, id)
    WHERE deleted_at IS NULL AND attributes ->> 'clientCode' IS NOT NULL;

ALTER TABLE customer_accounts ADD COLUMN external_client_code VARCHAR(256);
CREATE UNIQUE INDEX idx_customer_accounts_tenant_external_code
    ON customer_accounts (tenant_id, external_client_code)
    WHERE external_client_code IS NOT NULL;
