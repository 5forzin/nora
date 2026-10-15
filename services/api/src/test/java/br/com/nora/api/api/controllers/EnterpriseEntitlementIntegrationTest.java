package br.com.nora.api.api.controllers;

import static org.assertj.core.api.Assertions.assertThat;

import br.com.nora.api.application.workflow.WorkflowContextFactory;
import br.com.nora.api.application.workflow.WorkflowEngine;
import br.com.nora.api.application.workflow.WorkflowService;
import br.com.nora.api.domain.workflow.Workflow;
import br.com.nora.api.domain.workflow.WorkflowExecution;
import br.com.nora.api.domain.workflow.WorkflowExecutionStatus;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Testcontainers
class EnterpriseEntitlementIntegrationTest {

    private static final String PASSWORD = "StrongPassword123";

    @Container
    static final PostgreSQLContainer<?> POSTGRES =
            new PostgreSQLContainer<>("postgres:16-alpine")
                    .withDatabaseName("nora")
                    .withUsername("nora")
                    .withPassword("nora_dev");

    @DynamicPropertySource
    static void registerProps(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
    }

    @Autowired TestRestTemplate rest;
    @Autowired ObjectMapper mapper;
    @Autowired JdbcTemplate jdbc;
    @Autowired PasswordEncoder passwords;
    @Autowired WorkflowService workflows;
    @Autowired WorkflowEngine workflowEngine;
    @Autowired WorkflowContextFactory workflowContexts;

    @BeforeEach
    void setUp() {
        rest.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
    }

    @Test
    void freeAndProRootsCannotBypassEnterpriseEndpoints() throws Exception {
        String jwt = signup("plan-core@nora.dev");
        UUID tenant = tenant(jwt);
        for (String plan : List.of("FREE", "PRO")) {
            setPlan(tenant, plan);
            JsonNode me = read(exchange(HttpMethod.GET, "/auth/me", null, jwt), HttpStatus.OK);
            assertThat(me.path("plan").asText()).isEqualTo(plan);
            assertThat(me.path("root").asBoolean()).isTrue();
            assertThat(me.path("tenantName").asText()).isNotBlank();
            assertThat(me.path("permissions").size()).isEqualTo(16);
            me.path("permissions").forEach(value -> assertThat(value.asBoolean()).isTrue());
            me.path("capabilities").forEach(value -> assertThat(value.asBoolean()).isFalse());
            for (String route :
                    List.of(
                            "/iam/users",
                            "/iam/groups",
                            "/iam/policies",
                            "/iam/policy-templates",
                            "/iam/audit",
                            "/iam/invites",
                            "/tenant/context",
                            "/tenant/context/versions",
                            "/tenant/context/versions/1",
                            "/tenant/domain")) {
                JsonNode error =
                        read(exchange(HttpMethod.GET, route, null, jwt), HttpStatus.FORBIDDEN);
                assertThat(error.path("code").asText()).isEqualTo("ENTERPRISE_REQUIRED");
            }
            read(
                    exchange(HttpMethod.POST, "/iam/groups", Map.of("name", "Forbidden"), jwt),
                    HttpStatus.FORBIDDEN);
            read(
                    exchange(
                            HttpMethod.POST,
                            "/iam/users/invite",
                            Map.of("email", "member@example.com"),
                            jwt),
                    HttpStatus.FORBIDDEN);
            read(
                    exchange(
                            HttpMethod.PUT,
                            "/tenant/context",
                            Map.of("companyName", "Forbidden"),
                            jwt),
                    HttpStatus.FORBIDDEN);
            read(
                    exchange(
                            HttpMethod.PUT,
                            "/tenant/domain",
                            Map.of("allowedEmailDomain", "example.com"),
                            jwt),
                    HttpStatus.FORBIDDEN);
            read(exchange(HttpMethod.GET, "/meetings", null, jwt), HttpStatus.OK);
            read(exchange(HttpMethod.GET, "/tasks", null, jwt), HttpStatus.OK);
            read(exchange(HttpMethod.GET, "/tenant", null, jwt), HttpStatus.OK);
        }
    }

    @Test
    void planChangesTakeEffectForExistingJwtAndProfileUpdatesCannotUpgrade() throws Exception {
        String jwt = signup("plan-live@nora.dev");
        UUID tenant = tenant(jwt);
        setPlan(tenant, "ENTERPRISE");
        JsonNode enterprise = read(exchange(HttpMethod.GET, "/auth/me", null, jwt), HttpStatus.OK);
        assertThat(enterprise.path("plan").asText()).isEqualTo("ENTERPRISE");
        enterprise.path("capabilities").forEach(value -> assertThat(value.asBoolean()).isTrue());
        read(exchange(HttpMethod.GET, "/iam/users", null, jwt), HttpStatus.OK);
        read(
                exchange(
                        HttpMethod.PUT,
                        "/tenant/context",
                        Map.of("companyName", "Enterprise Example"),
                        jwt),
                HttpStatus.OK);

        setPlan(tenant, "PRO");
        read(exchange(HttpMethod.GET, "/tenant/context", null, jwt), HttpStatus.FORBIDDEN);
        JsonNode updated =
                read(
                        exchange(
                                HttpMethod.PATCH,
                                "/users/me",
                                Map.of("displayName", "Updated", "plan", "ENTERPRISE"),
                                jwt),
                        HttpStatus.OK);
        assertThat(updated.path("displayName").asText()).isEqualTo("Updated");
        assertThat(updated.path("plan").asText()).isEqualTo("PRO");
        assertThat(updated.path("permissions").size()).isEqualTo(16);
        updated.path("permissions").forEach(value -> assertThat(value.asBoolean()).isTrue());
        updated.path("capabilities").forEach(value -> assertThat(value.asBoolean()).isFalse());
        assertThat(
                        jdbc.queryForObject(
                                "SELECT plan FROM tenants WHERE id = ?", String.class, tenant))
                .isEqualTo("PRO");
    }

    @Test
    void enterpriseMemberGetsOnlyEffectiveCapabilitiesAndStillNeedsIam() throws Exception {
        String root = signup("plan-member-root@nora.dev");
        UUID tenant = tenant(root);
        setPlan(tenant, "ENTERPRISE");
        UUID member = UUID.randomUUID();
        String email = "plan-readonly@nora.dev";
        jdbc.update(
                "INSERT INTO users (id, tenant_id, email, password_hash, display_name, status, is_root, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'Reader', 'ACTIVE', FALSE, NOW(), NOW(), NOW())",
                member,
                tenant,
                email,
                passwords.encode(PASSWORD));
        String jwt = login(email);
        JsonNode empty = read(exchange(HttpMethod.GET, "/auth/me", null, jwt), HttpStatus.OK);
        empty.path("capabilities").forEach(value -> assertThat(value.asBoolean()).isFalse());
        assertThat(empty.path("permissions").size()).isEqualTo(16);
        empty.path("permissions").forEach(value -> assertThat(value.asBoolean()).isFalse());
        read(exchange(HttpMethod.GET, "/iam/users", null, jwt), HttpStatus.FORBIDDEN);

        String base = "nora:tenant/" + tenant;
        JsonNode policy =
                read(
                        exchange(
                                HttpMethod.POST,
                                "/iam/policies",
                                Map.of(
                                        "name",
                                        "Scoped reader",
                                        "document",
                                        Map.of(
                                                "version",
                                                "2026-10-14",
                                                "statements",
                                                List.of(
                                                        Map.of(
                                                                "effect",
                                                                "Allow",
                                                                "action",
                                                                List.of(
                                                                        "meeting:read",
                                                                        "task:read"),
                                                                "resource",
                                                                List.of(
                                                                        base + ":meeting/*",
                                                                        base + ":task/*"),
                                                                "condition",
                                                                Map.of(
                                                                        "StringEquals",
                                                                        Map.of(
                                                                                "department",
                                                                                "Sales"))),
                                                        Map.of(
                                                                "effect",
                                                                "Allow",
                                                                "action",
                                                                List.of("tenant:context:read"),
                                                                "resource",
                                                                List.of(
                                                                        base
                                                                                + ":tenant/context"))))),
                                root),
                        HttpStatus.CREATED);
        read(
                exchange(
                        HttpMethod.POST,
                        "/iam/users/" + member + "/policies/" + policy.path("id").asText(),
                        null,
                        root),
                HttpStatus.NO_CONTENT);
        JsonNode access =
                read(exchange(HttpMethod.GET, "/auth/me", null, jwt), HttpStatus.OK)
                        .path("capabilities");
        assertThat(access.path("viewExecutiveOverview").asBoolean()).isTrue();
        assertThat(access.path("readCompanyContext").asBoolean()).isTrue();
        assertThat(access.path("manageUsers").asBoolean()).isFalse();
        assertThat(access.path("manageAccess").asBoolean()).isFalse();
        assertThat(access.path("manageCompanyContext").asBoolean()).isFalse();
        read(
                exchange(
                        HttpMethod.POST,
                        "/iam/users/invite",
                        Map.of("email", "blocked@example.com"),
                        jwt),
                HttpStatus.FORBIDDEN);
    }

    @Test
    void coreMcpHidesAndRefusesEnterpriseToolWithExistingTokenAfterDowngrade() throws Exception {
        String jwt = signup("plan-mcp@nora.dev");
        UUID tenant = tenant(jwt);
        String mcp =
                read(
                                exchange(
                                        HttpMethod.POST,
                                        "/mcp/tokens",
                                        Map.of("name", "Plan test"),
                                        jwt),
                                HttpStatus.CREATED)
                        .path("token")
                        .asText();
        JsonNode coreTools = rpc(mcp, "tools/list", Map.of()).path("result").path("tools");
        assertThat(toolNames(coreTools)).hasSize(4).doesNotContain("get_customer_confidence");
        JsonNode failure =
                rpc(
                                mcp,
                                "tools/call",
                                Map.of(
                                        "name",
                                        "get_customer_confidence",
                                        "arguments",
                                        Map.of("meetingId", UUID.randomUUID().toString())))
                        .path("result");
        assertThat(failure.path("isError").asBoolean()).isTrue();
        assertThat(failure.toString()).contains("Enterprise");

        setPlan(tenant, "ENTERPRISE");
        assertThat(toolNames(rpc(mcp, "tools/list", Map.of()).path("result").path("tools")))
                .hasSize(5)
                .contains("get_customer_confidence");
        setPlan(tenant, "FREE");
        assertThat(toolNames(rpc(mcp, "tools/list", Map.of()).path("result").path("tools")))
                .hasSize(4);
    }

    @Test
    void confidenceFlowsAreHiddenAndCannotExecuteAfterDowngrade() throws Exception {
        String jwt = signup("plan-flows@nora.dev");
        UUID tenant = tenant(jwt);
        Map<String, Object> definition =
                Map.of(
                        "nodes",
                        List.of(
                                Map.of(
                                        "id",
                                        "trigger",
                                        "kind",
                                        "trigger",
                                        "type",
                                        "meeting.analysis_completed"),
                                Map.of(
                                        "id",
                                        "confidence",
                                        "kind",
                                        "condition",
                                        "type",
                                        " customer_confidence_below ",
                                        "params",
                                        Map.of("value", 70)),
                                Map.of(
                                        "id",
                                        "email",
                                        "kind",
                                        "action",
                                        "type",
                                        "send_email",
                                        "params",
                                        Map.of("to", "test@example.com"))),
                        "edges",
                        List.of(
                                Map.of("id", "e1", "source", "trigger", "target", "confidence"),
                                Map.of("id", "e2", "source", "confidence", "target", "email")));
        Map<String, Object> body =
                Map.of("name", "Confidence alert", "definition", definition, "active", false);
        read(exchange(HttpMethod.POST, "/workflows", body, jwt), HttpStatus.FORBIDDEN);
        setPlan(tenant, "ENTERPRISE");
        JsonNode created =
                read(exchange(HttpMethod.POST, "/workflows", body, jwt), HttpStatus.CREATED);
        UUID flowId = UUID.fromString(created.path("id").asText());
        Workflow saved = workflows.get(flowId, tenant);
        setPlan(tenant, "FREE");
        assertThat(read(exchange(HttpMethod.GET, "/workflows", null, jwt), HttpStatus.OK).isEmpty())
                .isTrue();
        for (String route :
                List.of("/workflows/" + flowId, "/workflows/" + flowId + "/executions")) {
            JsonNode error = read(exchange(HttpMethod.GET, route, null, jwt), HttpStatus.FORBIDDEN);
            assertThat(error.path("code").asText()).isEqualTo("ENTERPRISE_REQUIRED");
        }
        read(
                exchange(HttpMethod.POST, "/workflows/" + flowId + "/test", null, jwt),
                HttpStatus.FORBIDDEN);
        WorkflowExecution result =
                workflowEngine.execute(
                        saved,
                        workflowContexts.latestCompletedOrSample(
                                tenant, saved.triggerType().wire()));
        assertThat(result.status()).isEqualTo(WorkflowExecutionStatus.FAILED);
        assertThat(result.logJson())
                .contains("requires an Enterprise workspace")
                .doesNotContain("Trigger", "Condition:");
    }

    private List<String> toolNames(JsonNode tools) {
        List<String> names = new ArrayList<>();
        tools.forEach(tool -> names.add(tool.path("name").asText()));
        return names;
    }

    private JsonNode rpc(String token, String method, Object params) throws Exception {
        return read(
                exchange(
                        HttpMethod.POST,
                        "/mcp",
                        Map.of("jsonrpc", "2.0", "id", 1, "method", method, "params", params),
                        token),
                HttpStatus.OK);
    }

    private UUID tenant(String jwt) throws Exception {
        return UUID.fromString(
                read(exchange(HttpMethod.GET, "/auth/me", null, jwt), HttpStatus.OK)
                        .path("tenantId")
                        .asText());
    }

    private void setPlan(UUID tenant, String plan) {
        jdbc.update("UPDATE tenants SET plan = ? WHERE id = ?", plan, tenant);
    }

    private String signup(String email) throws Exception {
        JsonNode created =
                read(
                        exchange(
                                HttpMethod.POST,
                                "/auth/signup",
                                Map.of(
                                        "email",
                                        email,
                                        "password",
                                        PASSWORD,
                                        "displayName",
                                        "Plan owner"),
                                null),
                        HttpStatus.CREATED);
        read(
                exchange(
                        HttpMethod.POST,
                        "/auth/verify-email",
                        Map.of("token", created.path("emailVerificationDevToken").asText()),
                        null),
                HttpStatus.NO_CONTENT);
        return login(email);
    }

    private String login(String email) throws Exception {
        return read(
                        exchange(
                                HttpMethod.POST,
                                "/auth/login",
                                Map.of("email", email, "password", PASSWORD),
                                null),
                        HttpStatus.OK)
                .path("accessToken")
                .asText();
    }

    private ResponseEntity<String> exchange(
            HttpMethod method, String path, Object body, String token) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return rest.exchange(
                path,
                method,
                new HttpEntity<>(body == null ? null : mapper.writeValueAsString(body), headers),
                String.class);
    }

    private JsonNode read(ResponseEntity<String> response, HttpStatus status) throws Exception {
        assertThat(response.getStatusCode()).as("%s", response.getBody()).isEqualTo(status);
        return response.getBody() == null
                ? mapper.createObjectNode()
                : mapper.readTree(response.getBody());
    }
}
