package br.com.nora.api.api.dto.auth;

import br.com.nora.api.application.tenant.EnterpriseEntitlementService.Capabilities;
import br.com.nora.api.application.tenant.EnterpriseEntitlementService.Permissions;
import br.com.nora.api.application.tenant.EnterpriseEntitlementService.WorkspaceAccess;
import br.com.nora.api.domain.identity.User;
import java.time.Instant;
import java.util.UUID;

/** Identity of the authenticated user (Account tab in settings). */
public record MeResponse(
        UUID userId,
        UUID tenantId,
        String email,
        String displayName,
        boolean emailVerified,
        Instant createdAt,
        String tenantName,
        String plan,
        boolean root,
        Capabilities capabilities,
        Permissions permissions) {

    public static MeResponse from(User user, WorkspaceAccess access) {
        return new MeResponse(
                user.id(),
                user.tenantId(),
                user.email().value(),
                user.displayName(),
                user.isEmailVerified(),
                user.createdAt(),
                access.tenantName(),
                access.plan(),
                access.root(),
                access.capabilities(),
                access.permissions());
    }
}
