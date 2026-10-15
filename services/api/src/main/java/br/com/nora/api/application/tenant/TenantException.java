package br.com.nora.api.application.tenant;

import java.util.UUID;

/**
 * Failures in the tenant's general configuration (US32 onwards). Distinct from {@link
 * TenantContextException}, which covers the "commercial context" subdomain.
 */
public sealed class TenantException extends RuntimeException {

    private final String code;

    protected TenantException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String code() {
        return code;
    }

    /** Nonexistent tenant. */
    public static final class NotFound extends TenantException {
        public NotFound(UUID tenantId) {
            super("TENANT_NOT_FOUND", "tenant not found: " + tenantId);
        }
    }

    public static final class EnterpriseRequired extends TenantException {
        public EnterpriseRequired() {
            super("ENTERPRISE_REQUIRED", "This feature requires an Enterprise workspace.");
        }
    }

    /**
     * Invalid domain format (US32). Mapped to HTTP 422 to signal that the payload is syntactically
     * correct but semantically not acceptable.
     */
    public static final class InvalidDomain extends TenantException {
        public InvalidDomain(String detail) {
            super("TENANT_DOMAIN_INVALID", detail);
        }
    }
}
