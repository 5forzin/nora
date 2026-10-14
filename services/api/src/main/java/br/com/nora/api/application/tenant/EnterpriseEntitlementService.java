package br.com.nora.api.application.tenant;

import br.com.nora.api.application.iam.AuthorizationService;
import br.com.nora.api.application.ports.TenantRepository;
import br.com.nora.api.application.ports.UserRepository;
import br.com.nora.api.domain.tenant.Tenant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Server-authoritative plan access; IAM still limits every Enterprise operation. */
@Service
public class EnterpriseEntitlementService {

    public record Capabilities(
            boolean manageUsers,
            boolean manageAccess,
            boolean readCompanyContext,
            boolean manageCompanyContext,
            boolean viewExecutiveOverview) {}

    public record Permissions(
            boolean createMeetings,
            boolean captureMeetings,
            boolean reprocessMeetings,
            boolean deleteMeetings,
            boolean eraseMeetings,
            boolean writeTasks,
            boolean manageFlows,
            boolean testFlows,
            boolean manageIntegrations,
            boolean readFlows,
            boolean readIntegrations,
            boolean readWorkspace,
            boolean renameWorkspace,
            boolean updateMeetings,
            boolean readMeetings,
            boolean readTasks) {}

    public record WorkspaceAccess(
            String tenantName,
            String plan,
            boolean root,
            Capabilities capabilities,
            Permissions permissions) {}

    private final TenantRepository tenants;
    private final UserRepository users;
    private final AuthorizationService authz;

    public EnterpriseEntitlementService(
            TenantRepository tenants, UserRepository users, AuthorizationService authz) {
        this.tenants = tenants;
        this.users = users;
        this.authz = authz;
    }

    @Transactional(readOnly = true)
    public boolean isEnterprise(UUID tenantId) {
        return tenant(tenantId).plan() == Tenant.Plan.ENTERPRISE;
    }

    @Transactional(readOnly = true)
    public void requireEnterprise(UUID tenantId) {
        if (!isEnterprise(tenantId)) {
            throw new TenantException.EnterpriseRequired();
        }
    }

    @Transactional(readOnly = true)
    public WorkspaceAccess workspaceAccess(UUID userId, UUID tenantId) {
        Tenant tenant = tenant(tenantId);
        boolean root = users.isRoot(userId, tenantId);
        Capabilities capabilities;
        if (tenant.plan() != Tenant.Plan.ENTERPRISE) {
            capabilities = new Capabilities(false, false, false, false, false);
        } else if (root) {
            capabilities = new Capabilities(true, true, true, true, true);
        } else {
            String base = "nora:tenant/" + tenantId;
            boolean directory = allowed(userId, tenantId, "iam:group:read", base + ":iam/*");
            boolean context =
                    allowed(userId, tenantId, "tenant:context:read", base + ":tenant/context");
            capabilities =
                    new Capabilities(
                            directory
                                    && allowed(
                                            userId, tenantId, "iam:user:invite", base + ":invite/*")
                                    && allowed(
                                            userId, tenantId, "iam:invite:read", base + ":invite/*")
                                    && allowed(
                                            userId,
                                            tenantId,
                                            "iam:invite:revoke",
                                            base + ":invite/*"),
                            canManageAccess(userId, tenantId, base + ":iam/*"),
                            context,
                            context
                                    && allowed(
                                            userId,
                                            tenantId,
                                            "tenant:context:write",
                                            base + ":tenant/context"),
                            authz.hasAnyAllow(userId, tenantId, "meeting:read", base + ":meeting/*")
                                    && authz.hasAnyAllow(
                                            userId, tenantId, "task:read", base + ":task/*"));
        }
        return new WorkspaceAccess(
                tenant.name(),
                tenant.plan().name(),
                root,
                capabilities,
                permissions(userId, tenantId, root));
    }

    private boolean allowed(UUID userId, UUID tenantId, String action, String resource) {
        return authz.isAllowed(userId, tenantId, action, resource);
    }

    private Permissions permissions(UUID userId, UUID tenantId, boolean root) {
        if (root) {
            return new Permissions(
                    true, true, true, true, true, true, true, true, true, true, true, true, true,
                    true, true, true);
        }
        String base = "nora:tenant/" + tenantId;
        String meeting = base + ":meeting/*";
        String task = base + ":task/*";
        String workflow = base + ":workflow/*";
        String integration = base + ":integration/*";
        boolean createMeetings =
                uniform(userId, tenantId, "meeting:upload", meeting)
                        && uniform(userId, tenantId, "meeting:read", meeting);
        return new Permissions(
                createMeetings,
                createMeetings
                        && allowed(userId, tenantId, "stt:session:create", base)
                        && uniform(userId, tenantId, "meeting:analyze:live", meeting),
                uniform(userId, tenantId, "meeting:reprocess", meeting),
                uniform(userId, tenantId, "meeting:delete", meeting),
                uniform(userId, tenantId, "meeting:erase", meeting),
                uniform(userId, tenantId, "task:write", task),
                uniform(userId, tenantId, "workflow:write", workflow),
                uniform(userId, tenantId, "workflow:test", workflow),
                allowed(userId, tenantId, "integration:write", integration),
                authz.hasAnyAllow(userId, tenantId, "workflow:read", workflow),
                allowed(userId, tenantId, "integration:read", integration),
                allowed(userId, tenantId, "tenant:read", base),
                allowed(userId, tenantId, "tenant:name:write", base),
                uniform(userId, tenantId, "meeting:update", meeting),
                authz.hasAnyAllow(userId, tenantId, "meeting:read", meeting),
                authz.hasAnyAllow(userId, tenantId, "task:read", task));
    }

    private boolean uniform(UUID userId, UUID tenantId, String action, String resource) {
        return authz.uniformDecision(userId, tenantId, action, resource).orElse(false);
    }

    private boolean canManageAccess(UUID userId, UUID tenantId, String resource) {
        return List.of(
                        "iam:group:read",
                        "iam:group:create",
                        "iam:group:delete",
                        "iam:group:add-member",
                        "iam:group:remove-member",
                        "iam:policy:read",
                        "iam:policy:create",
                        "iam:policy:update",
                        "iam:policy:delete",
                        "iam:attachment:create",
                        "iam:attachment:delete",
                        "iam:boundary:read",
                        "iam:boundary:set",
                        "iam:boundary:delete",
                        "iam:audit:read",
                        "iam:policy:simulate")
                .stream()
                .allMatch(action -> allowed(userId, tenantId, action, resource));
    }

    private Tenant tenant(UUID tenantId) {
        return tenants.findById(tenantId).orElseThrow(() -> new TenantException.NotFound(tenantId));
    }
}
