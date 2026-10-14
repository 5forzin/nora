package br.com.nora.api.application.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import br.com.nora.api.application.iam.AuthorizationService;
import br.com.nora.api.application.ports.IamRepository;
import br.com.nora.api.application.ports.TenantRepository;
import br.com.nora.api.application.ports.UserRepository;
import br.com.nora.api.domain.iam.Effect;
import br.com.nora.api.domain.iam.PermissionBoundary;
import br.com.nora.api.domain.iam.PolicyStatement;
import br.com.nora.api.domain.iam.PolicyTemplateCatalog;
import br.com.nora.api.domain.tenant.Tenant;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class EnterpriseEntitlementServiceTest {

    private final UUID tenantId = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();
    private final TenantRepository tenants = mock(TenantRepository.class);
    private final UserRepository users = mock(UserRepository.class);
    private final IamRepository iam = mock(IamRepository.class);
    private final AuthorizationService authz = new AuthorizationService(users, iam);
    private final EnterpriseEntitlementService service =
            new EnterpriseEntitlementService(tenants, users, authz);
    private final String base = "nora:tenant/" + tenantId;

    @Test
    void rootBypassDoesNotEnableEnterpriseForFreeOrPro() {
        when(users.isRoot(userId, tenantId)).thenReturn(true);
        for (Tenant.Plan plan : List.of(Tenant.Plan.FREE, Tenant.Plan.PRO)) {
            plan(plan);
            assertThat(service.workspaceAccess(userId, tenantId).root()).isTrue();
            assertThat(service.workspaceAccess(userId, tenantId).capabilities())
                    .isEqualTo(
                            new EnterpriseEntitlementService.Capabilities(
                                    false, false, false, false, false));
            assertThatThrownBy(() -> service.requireEnterprise(tenantId))
                    .isInstanceOf(TenantException.EnterpriseRequired.class);
        }
    }

    @Test
    void enterpriseRootHasAllCapabilities() {
        plan(Tenant.Plan.ENTERPRISE);
        when(users.isRoot(userId, tenantId)).thenReturn(true);
        assertThat(service.workspaceAccess(userId, tenantId).capabilities())
                .isEqualTo(
                        new EnterpriseEntitlementService.Capabilities(
                                true, true, true, true, true));
        service.requireEnterprise(tenantId);
    }

    @Test
    void conditionalReaderCanOpenOverviewWithoutAdministrativeActions() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(
                        List.of(
                                new PolicyStatement(
                                        Effect.ALLOW,
                                        List.of("meeting:read", "task:read"),
                                        List.of(base + ":meeting/*", base + ":task/*"),
                                        Map.of("StringEquals", Map.of("department", "Sales"))),
                                allow(List.of("tenant:context:read"), base + ":tenant/context")));
        assertThat(service.workspaceAccess(userId, tenantId).capabilities())
                .isEqualTo(
                        new EnterpriseEntitlementService.Capabilities(
                                false, false, true, false, true));
        assertThat(service.workspaceAccess(userId, tenantId).permissions().readMeetings()).isTrue();
        assertThat(service.workspaceAccess(userId, tenantId).permissions().readTasks()).isTrue();
    }

    @Test
    void iamAdministratorCanManageUsersAndAccessWithoutCompanyContextOrMeetings() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(List.of(allow(List.of("iam:*"), base + ":*")));
        assertThat(service.workspaceAccess(userId, tenantId).capabilities())
                .isEqualTo(
                        new EnterpriseEntitlementService.Capabilities(
                                true, true, false, false, false));
    }

    @Test
    void readOnlyIamPoliciesDoNotExposeManagementPages() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(
                        List.of(
                                allow(
                                        List.of("iam:group:read", "iam:policy:read"),
                                        base + ":iam/*")));
        assertThat(service.workspaceAccess(userId, tenantId).capabilities().manageAccess())
                .isFalse();
        assertThat(service.workspaceAccess(userId, tenantId).capabilities().manageUsers())
                .isFalse();
    }

    @Test
    void permissionBoundaryStillCapsEnterpriseAdministration() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(List.of(allow(List.of("iam:*"), base + ":*")));
        when(iam.findBoundaryForUser(userId, tenantId))
                .thenReturn(
                        Optional.of(
                                new PermissionBoundary(
                                        userId,
                                        UUID.randomUUID(),
                                        "Read only cap",
                                        List.of(
                                                allow(
                                                        List.of(
                                                                "iam:group:read",
                                                                "iam:policy:read"),
                                                        base + ":iam/*")),
                                        UUID.randomUUID(),
                                        OffsetDateTime.now())));
        assertThat(service.workspaceAccess(userId, tenantId).capabilities().manageAccess())
                .isFalse();
        assertThat(service.workspaceAccess(userId, tenantId).capabilities().manageUsers())
                .isFalse();
    }

    @Test
    void changedPlanIsReadForEveryDecisionAndMissingTenantFailsClosed() {
        plan(Tenant.Plan.ENTERPRISE);
        assertThat(service.isEnterprise(tenantId)).isTrue();
        plan(Tenant.Plan.FREE);
        assertThat(service.isEnterprise(tenantId)).isFalse();
        when(tenants.findById(tenantId)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.isEnterprise(tenantId))
                .isInstanceOf(TenantException.NotFound.class);
    }

    @Test
    void coreRootCanUseSharedFeaturesWithoutEnterpriseCapabilities() {
        plan(Tenant.Plan.FREE);
        when(users.isRoot(userId, tenantId)).thenReturn(true);
        var access = service.workspaceAccess(userId, tenantId);
        assertThat(access.capabilities().manageUsers()).isFalse();
        assertThat(access.permissions())
                .isEqualTo(
                        new EnterpriseEntitlementService.Permissions(
                                true, true, true, true, true, true, true, true, true, true, true,
                                true, true, true, true, true));
    }

    @Test
    void viewerCanReadSharedModulesButCannotMutateThem() {
        plan(Tenant.Plan.ENTERPRISE);
        grantTemplate("read-only-access");
        var permissions = service.workspaceAccess(userId, tenantId).permissions();
        assertThat(permissions.readMeetings()).isTrue();
        assertThat(permissions.readTasks()).isTrue();
        assertThat(permissions.readFlows()).isTrue();
        assertThat(permissions.readIntegrations()).isTrue();
        assertThat(permissions.readWorkspace()).isTrue();
        assertThat(permissions.createMeetings()).isFalse();
        assertThat(permissions.captureMeetings()).isFalse();
        assertThat(permissions.updateMeetings()).isFalse();
        assertThat(permissions.reprocessMeetings()).isFalse();
        assertThat(permissions.deleteMeetings()).isFalse();
        assertThat(permissions.eraseMeetings()).isFalse();
        assertThat(permissions.writeTasks()).isFalse();
        assertThat(permissions.manageFlows()).isFalse();
        assertThat(permissions.testFlows()).isFalse();
        assertThat(permissions.manageIntegrations()).isFalse();
        assertThat(permissions.renameWorkspace()).isFalse();
    }

    @Test
    void nonRootWithFullGrantCanUseFixedTenantResourcesAsWellAsCollections() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(List.of(allow(List.of("*"), "*")));
        assertThat(service.workspaceAccess(userId, tenantId).root()).isFalse();
        assertThat(service.workspaceAccess(userId, tenantId).permissions())
                .isEqualTo(
                        new EnterpriseEntitlementService.Permissions(
                                true, true, true, true, true, true, true, true, true, true, true,
                                true, true, true, true, true));
    }

    @Test
    void analystGetsExactlyTheSharedRightsOfItsTemplate() {
        plan(Tenant.Plan.ENTERPRISE);
        grantTemplate("meeting-analyst");
        var permissions = service.workspaceAccess(userId, tenantId).permissions();
        assertThat(permissions.createMeetings()).isTrue();
        assertThat(permissions.updateMeetings()).isTrue();
        assertThat(permissions.reprocessMeetings()).isTrue();
        assertThat(permissions.deleteMeetings()).isTrue();
        assertThat(permissions.writeTasks()).isTrue();
        assertThat(permissions.readMeetings()).isTrue();
        assertThat(permissions.readTasks()).isTrue();
        assertThat(permissions.captureMeetings()).isFalse();
        assertThat(permissions.eraseMeetings()).isFalse();
        assertThat(permissions.readFlows()).isFalse();
        assertThat(permissions.readIntegrations()).isFalse();
        assertThat(permissions.readWorkspace()).isFalse();
        assertThat(permissions.manageFlows()).isFalse();
    }

    @Test
    void conditionalDenyHidesGlobalMutationButKeepsFilteredReadsAvailable() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(
                        List.of(
                                allow(List.of("meeting:*", "task:read"), base + ":*"),
                                new PolicyStatement(
                                        Effect.DENY,
                                        List.of("meeting:reprocess", "meeting:upload"),
                                        List.of(base + ":meeting/*"),
                                        Map.of("StringEquals", Map.of("department", "Sales")))));
        var permissions = service.workspaceAccess(userId, tenantId).permissions();
        assertThat(permissions.readMeetings()).isTrue();
        assertThat(permissions.readTasks()).isTrue();
        assertThat(permissions.createMeetings()).isFalse();
        assertThat(permissions.reprocessMeetings()).isFalse();
    }

    @Test
    void importingNeedsReadableResultAndCaptureNeedsAllAdditionalGrants() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(List.of(allow(List.of("meeting:upload"), base + ":meeting/*")));
        assertThat(service.workspaceAccess(userId, tenantId).permissions().createMeetings())
                .isFalse();
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(
                        List.of(
                                allow(
                                        List.of(
                                                "meeting:upload",
                                                "meeting:read",
                                                "stt:session:create"),
                                        base + "*")));
        assertThat(service.workspaceAccess(userId, tenantId).permissions().createMeetings())
                .isTrue();
        assertThat(service.workspaceAccess(userId, tenantId).permissions().captureMeetings())
                .isFalse();
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(
                        List.of(
                                allow(
                                        List.of(
                                                "meeting:upload",
                                                "meeting:read",
                                                "stt:session:create",
                                                "meeting:analyze:live"),
                                        base + "*")));
        assertThat(service.workspaceAccess(userId, tenantId).permissions().captureMeetings())
                .isTrue();
    }

    private void grantTemplate(String id) {
        var statements =
                PolicyTemplateCatalog.forTenant(tenantId).stream()
                        .filter(template -> id.equals(template.id()))
                        .findFirst()
                        .orElseThrow()
                        .document()
                        .statements();
        when(iam.collectStatementsForUser(userId, tenantId)).thenReturn(statements);
    }

    @Test
    void readOnlyBoundaryCapsEverySharedMutationWithoutRemovingReadableModules() {
        plan(Tenant.Plan.ENTERPRISE);
        when(iam.collectStatementsForUser(userId, tenantId))
                .thenReturn(List.of(allow(List.of("*"), "*")));
        when(iam.findBoundaryForUser(userId, tenantId))
                .thenReturn(
                        Optional.of(
                                new PermissionBoundary(
                                        userId,
                                        UUID.randomUUID(),
                                        "Shared reader cap",
                                        List.of(
                                                allow(
                                                        List.of(
                                                                "meeting:read",
                                                                "task:read",
                                                                "workflow:read",
                                                                "integration:read",
                                                                "tenant:read"),
                                                        "*")),
                                        UUID.randomUUID(),
                                        OffsetDateTime.now())));
        var permissions = service.workspaceAccess(userId, tenantId).permissions();
        assertThat(permissions.readMeetings()).isTrue();
        assertThat(permissions.readTasks()).isTrue();
        assertThat(permissions.readFlows()).isTrue();
        assertThat(permissions.readIntegrations()).isTrue();
        assertThat(permissions.readWorkspace()).isTrue();
        assertThat(permissions.createMeetings()).isFalse();
        assertThat(permissions.captureMeetings()).isFalse();
        assertThat(permissions.updateMeetings()).isFalse();
        assertThat(permissions.reprocessMeetings()).isFalse();
        assertThat(permissions.deleteMeetings()).isFalse();
        assertThat(permissions.eraseMeetings()).isFalse();
        assertThat(permissions.writeTasks()).isFalse();
        assertThat(permissions.manageFlows()).isFalse();
        assertThat(permissions.testFlows()).isFalse();
        assertThat(permissions.manageIntegrations()).isFalse();
        assertThat(permissions.renameWorkspace()).isFalse();
    }

    private PolicyStatement allow(List<String> actions, String resource) {
        return new PolicyStatement(Effect.ALLOW, actions, List.of(resource), Map.of());
    }

    private void plan(Tenant.Plan plan) {
        when(tenants.findById(tenantId))
                .thenReturn(
                        Optional.of(
                                new Tenant(
                                        tenantId,
                                        "Workspace",
                                        "workspace",
                                        Tenant.Status.ACTIVE,
                                        plan,
                                        Instant.now(),
                                        Instant.now())));
    }
}
