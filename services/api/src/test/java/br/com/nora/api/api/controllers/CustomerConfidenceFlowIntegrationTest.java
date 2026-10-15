package br.com.nora.api.api.controllers;

import static org.assertj.core.api.Assertions.assertThat;

import br.com.nora.api.application.analysis.AnalysisService;
import br.com.nora.api.application.ports.NlpWorkerClient;
import br.com.nora.api.application.ports.NlpWorkerClient.CustomerConfidenceCarrier;
import br.com.nora.api.application.tenant.TenantContextService;
import br.com.nora.api.application.workflow.WorkflowContextFactory;
import br.com.nora.api.domain.analysis.CommercialIntelligence;
import br.com.nora.api.domain.analysis.MeetingAnalysis;
import br.com.nora.api.domain.analysis.Sentiment;
import br.com.nora.api.domain.customer.BuyingSignal;
import br.com.nora.api.domain.customer.BuyingSignalType;
import br.com.nora.api.domain.customer.ConfidenceBand;
import br.com.nora.api.domain.customer.ConfidenceTrend;
import br.com.nora.api.domain.customer.Objection;
import br.com.nora.api.domain.customer.ObjectionSeverity;
import br.com.nora.api.domain.customer.ObjectionType;
import br.com.nora.api.domain.tenant.TenantContext;
import br.com.nora.api.infrastructure.nlp.WorkerDtos;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * End-to-end Customer Confidence flow (ADR 0015): upload -> stub analysis that emits the
 * customerConfidence block -> auto-created account (dedup by name) -> persisted assessment -> trend
 * recomputed server-side on the 2nd meeting -> GET /meetings/{id} returns customerConfidence. Also
 * covers an internal meeting (no accountName) => no account and a null field in the response.
 *
 * <p>The worker is stubbed by a @Primary bean (same pattern as ProductivityFlowIntegrationTest);
 * the emitted confidence carrier is controlled by {@link ConfidenceScript}.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Testcontainers
@Import(CustomerConfidenceFlowIntegrationTest.StubWorkerConfig.class)
class CustomerConfidenceFlowIntegrationTest {

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

    @LocalServerPort int port;
    @Autowired TestRestTemplate rest;
    @Autowired ObjectMapper mapper;
    @Autowired JdbcTemplate jdbc;
    @Autowired AnalysisService analysisService;
    @Autowired ConfidenceScript script;
    @Autowired TenantContextService companyContext;
    @Autowired WorkflowContextFactory workflowContexts;

    @BeforeEach
    void setUp() {
        rest.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
        script.reset();
    }

    @Test
    void coreAnalysisDoesNotUseStoredCompanyContextOrPersistConfidence() throws Exception {
        String token = signupAndLogin("conf-core@nora.dev", "SenhaForte123", "Core Owner");
        UUID tenantId = principalTenantId(token);
        UUID userId =
                UUID.fromString(
                        authGet("/auth/me", token).read(HttpStatus.OK).path("userId").asText());
        companyContext.upsert(
                tenantId,
                new TenantContextService.UpsertCommand(
                        "Private Enterprise Context",
                        null,
                        null,
                        null,
                        List.of(),
                        List.of(),
                        List.of()),
                userId);
        jdbc.update("UPDATE tenants SET plan = 'FREE' WHERE id = ?", tenantId);
        script.set(carrier("Core Must Not Persist", 70, ConfidenceBand.MEDIUM));
        UUID meetingId = uploadMeeting(token, "Core Meeting");
        analysisService.run(meetingId, tenantId);

        assertThat(script.lastContext.get()).isEmpty();
        JsonNode detail = authGet("/meetings/" + meetingId, token).read(HttpStatus.OK);
        assertThat(detail.path("customerConfidence").isNull()).isTrue();
        assertThat(detail.path("analysis").path("commercialIntelligence").isNull()).isTrue();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT count(*) FROM customer_confidence_assessments WHERE tenant_id = ?",
                                Integer.class,
                                tenantId))
                .isZero();
        assertThat(
                        workflowContexts
                                .forMeeting(
                                        tenantId,
                                        meetingId,
                                        "meeting.analysis_completed",
                                        OffsetDateTime.now())
                                .customerConfidenceScore())
                .isNull();
    }

    @Test
    void downgradeHidesAlreadyPersistedConfidenceFromDetailsAndFlowContext() throws Exception {
        String token =
                signupAndLogin("conf-downgrade@nora.dev", "SenhaForte123", "Former Enterprise");
        UUID tenantId = principalTenantId(token);
        script.set(carrier("Historic Account", 70, ConfidenceBand.MEDIUM));
        UUID meetingId = uploadMeeting(token, "Prior Enterprise Meeting");
        analysisService.run(meetingId, tenantId);
        assertThat(
                        authGet("/meetings/" + meetingId, token)
                                .read(HttpStatus.OK)
                                .path("customerConfidence")
                                .isNull())
                .isFalse();
        jdbc.update("UPDATE tenants SET plan = 'PRO' WHERE id = ?", tenantId);
        assertThat(
                        authGet("/meetings/" + meetingId, token)
                                .read(HttpStatus.OK)
                                .path("customerConfidence")
                                .isNull())
                .isTrue();
        assertThat(
                        workflowContexts
                                .forMeeting(
                                        tenantId,
                                        meetingId,
                                        "meeting.analysis_completed",
                                        OffsetDateTime.now())
                                .customerConfidenceScore())
                .isNull();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT count(*) FROM customer_confidence_assessments WHERE meeting_id = ?",
                                Integer.class,
                                meetingId))
                .isPositive();
    }

    @Test
    void externalMeetingCreatesAccountAndPersistsConfidence() throws Exception {
        String token = signupAndLogin("conf@nora.dev", "SenhaForte123", "Owner Conf");
        UUID tenantId = principalTenantId(token);
        UUID meetingId = uploadMeeting(token, "Discovery Acme Corp");

        // Worker emits confidence for the "Acme Corp" account (score 70).
        script.set(carrier("Acme Corp", 70, ConfidenceBand.MEDIUM));
        analysisService.run(meetingId, tenantId);

        JsonNode detail = authGet("/meetings/" + meetingId, token).read(HttpStatus.OK);
        JsonNode cc = detail.get("customerConfidence");
        assertThat(cc.isNull()).isFalse();
        assertThat(cc.get("score").asInt()).isEqualTo(70);
        assertThat(cc.get("band").asText()).isEqualTo("MEDIUM");
        assertThat(cc.get("accountName").asText()).isEqualTo("Acme Corp");
        // First meeting for the account => no trend.
        assertThat(cc.get("trend").isNull()).isTrue();
        assertThat(cc.get("buyingSignals").size()).isEqualTo(1);
        assertThat(cc.get("buyingSignals").get(0).get("type").asText())
                .isEqualTo("BUDGET_DISCUSSED");
        assertThat(cc.get("objections").size()).isEqualTo(1);
        assertThat(cc.get("objections").get(0).get("type").asText()).isEqualTo("PRICE");
        assertThat(cc.get("objections").get(0).get("competitor").asText())
                .isEqualTo("Concorrente X");
        assertThat(cc.get("rationale").asText()).contains("stub");
    }

    @Test
    void secondMeetingSameAccountDedupesAndComputesTrend() throws Exception {
        String token = signupAndLogin("trend@nora.dev", "SenhaForte123", "Owner Trend");
        UUID tenantId = principalTenantId(token);

        // 1st meeting: "Globex" account created, score 50.
        UUID meeting1 = uploadMeeting(token, "Call Globex #1");
        script.set(carrier("Globex", 50, ConfidenceBand.MEDIUM));
        analysisService.run(meeting1, tenantId);
        JsonNode d1 = authGet("/meetings/" + meeting1, token).read(HttpStatus.OK);
        assertThat(d1.get("customerConfidence").get("trend").isNull()).isTrue();

        // 2nd meeting, same account (case-insensitive "globex"), score 80 => IMPROVING.
        UUID meeting2 = uploadMeeting(token, "Call Globex #2");
        script.set(carrier("globex", 80, ConfidenceBand.HIGH));
        analysisService.run(meeting2, tenantId);
        JsonNode d2 = authGet("/meetings/" + meeting2, token).read(HttpStatus.OK);
        JsonNode cc2 = d2.get("customerConfidence");
        assertThat(cc2.get("score").asInt()).isEqualTo(80);
        assertThat(cc2.get("trend").asText()).isEqualTo("IMPROVING");
        // Dedup: the canonical name keeps the original ("Globex") from the 1st creation.
        assertThat(cc2.get("accountName").asText()).isEqualTo("Globex");
    }

    @Test
    void internalMeetingPersistsNoConfidence() throws Exception {
        String token = signupAndLogin("internal@nora.dev", "SenhaForte123", "Owner Int");
        UUID tenantId = principalTenantId(token);
        UUID meetingId = uploadMeeting(token, "Retro interna do time");

        // Worker does NOT emit confidence (internal meeting).
        script.set(null);
        analysisService.run(meetingId, tenantId);

        JsonNode detail = authGet("/meetings/" + meetingId, token).read(HttpStatus.OK);
        assertThat(detail.get("customerConfidence").isNull()).isTrue();
    }

    @Test
    void confidenceIsTenantIsolated() throws Exception {
        String tokenA = signupAndLogin("cca@nora.dev", "SenhaForte123", "A");
        String tokenB = signupAndLogin("ccb@nora.dev", "SenhaForte123", "B");
        UUID tenantA = principalTenantId(tokenA);
        UUID meetingA = uploadMeeting(tokenA, "Reuniao tenant A confidence");

        script.set(carrier("Initech", 60, ConfidenceBand.MEDIUM));
        analysisService.run(meetingA, tenantA);

        // Tenant B cannot see A's meeting => 404 on the GET.
        ResponseEntity<String> resp = authGetRaw("/meetings/" + meetingA, tokenB);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /* ---------- builders ---------- */

    private static CommercialIntelligence commercialFacts() {
        return new CommercialIntelligence(
                List.of(
                        new CommercialIntelligence.Product(
                                "ERP", CommercialIntelligence.Relationship.CURRENT, "We use ERP")),
                List.of(
                        new CommercialIntelligence.Persona(
                                null,
                                null,
                                CommercialIntelligence.DecisionRole.UNKNOWN,
                                "We use ERP")),
                List.of(
                        new CommercialIntelligence.Budget(
                                new java.math.BigDecimal("4000"),
                                "BRL",
                                CommercialIntelligence.BudgetKind.PROPOSAL,
                                CommercialIntelligence.Approval.NOT_APPROVED,
                                "monthly",
                                "The proposal is BRL 4000 monthly and is not approved")),
                List.of(
                        new CommercialIntelligence.TopicSentiment(
                                "Support", Sentiment.NEGATIVE, "Support is slow")));
    }

    @Test
    void commercialFactsRoundTripAndDowngradeMasksStoredData() throws Exception {
        String token =
                signupAndLogin("commercial-facts@nora.dev", "StrongPass123!", "Commercial Owner");
        UUID tenant = principalTenantId(token);
        UUID id =
                uploadMeeting(
                        token,
                        "Commercial encounter",
                        Map.of(
                                "attributes",
                                Map.of("clientCode", "C-42", "externalId", "source-42")));
        script.set(carrier(null, 60, ConfidenceBand.MEDIUM));
        analysisService.run(id, tenant);
        JsonNode detail = authGet("/meetings/" + id, token).read(HttpStatus.OK);
        assertThat(
                        detail.path("analysis")
                                .path("commercialIntelligence")
                                .path("products")
                                .get(0)
                                .path("name")
                                .asText())
                .isEqualTo("ERP");
        assertThat(
                        detail.path("analysis")
                                .path("commercialIntelligence")
                                .path("personas")
                                .get(0)
                                .path("role")
                                .isNull())
                .isTrue();
        assertThat(detail.path("attributes").path("externalId").asText()).isEqualTo("source-42");
        assertThat(detail.path("customerConfidence").path("clientCode").asText()).isEqualTo("C-42");
        assertThat(detail.path("analysis").path("quality").path("origin").asText())
                .isEqualTo("WORKER");
        assertThat(
                        detail.path("analysis")
                                .path("quality")
                                .path("extraction")
                                .path("commercial")
                                .isObject())
                .isTrue();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT commercial_intelligence IS NOT NULL FROM meeting_analyses WHERE meeting_id = ?",
                                Boolean.class,
                                id))
                .isTrue();
        String storedQuality =
                jdbc.queryForObject(
                        "SELECT quality_observations::text FROM meeting_analyses WHERE meeting_id = ?",
                        String.class,
                        id);
        assertThat(storedQuality).isNotBlank();
        jdbc.update(
                "UPDATE meeting_analyses SET quality_observations = NULL WHERE meeting_id = ?", id);
        JsonNode legacy = authGet("/meetings/" + id, token).read(HttpStatus.OK);
        assertThat(legacy.path("analysis").path("quality").path("origin").asText())
                .isEqualTo("LEGACY_DERIVED");
        assertThat(
                        legacy.path("analysis")
                                .path("quality")
                                .path("extraction")
                                .path("actionItems")
                                .path("matchedSourceQuote")
                                .isNull())
                .isTrue();
        jdbc.update(
                "UPDATE meeting_analyses SET quality_observations = CAST(? AS jsonb) WHERE meeting_id = ?",
                storedQuality,
                id);
        jdbc.update("UPDATE tenants SET plan = 'FREE' WHERE id = ?", tenant);
        JsonNode downgraded = authGet("/meetings/" + id, token).read(HttpStatus.OK);
        assertThat(downgraded.path("analysis").path("commercialIntelligence").isNull()).isTrue();
        assertThat(downgraded.path("customerConfidence").isNull()).isTrue();
        assertThat(
                        downgraded
                                .path("analysis")
                                .path("quality")
                                .path("extraction")
                                .path("commercial")
                                .isNull())
                .isTrue();
        assertThat(
                        authGet("/meetings/customer-history?clientCode=C-42", token)
                                .read(HttpStatus.FORBIDDEN)
                                .path("code")
                                .asText())
                .isEqualTo("ENTERPRISE_REQUIRED");
    }

    @Test
    void externalCodesGroupAnonymousEncountersByDateEvenWhenAnalyzedOutOfOrder() throws Exception {
        String token =
                signupAndLogin("commercial-history@nora.dev", "StrongPass123!", "History Owner");
        UUID tenant = principalTenantId(token);
        UUID newer =
                uploadMeeting(
                        token,
                        "Later encounter",
                        Map.of(
                                "startedAt",
                                "2026-03-10T15:00:00Z",
                                "attributes",
                                Map.of("clientCode", "T03585")));
        script.set(carrier("[EMPRESA]", 80, ConfidenceBand.HIGH));
        analysisService.run(newer, tenant);
        UUID older =
                uploadMeeting(
                        token,
                        "Earlier encounter",
                        Map.of(
                                "startedAt",
                                "2026-02-10T15:00:00Z",
                                "attributes",
                                Map.of("clientCode", "T03585")));
        script.set(carrier(null, 50, ConfidenceBand.MEDIUM));
        analysisService.run(older, tenant);
        UUID undated =
                uploadMeeting(
                        token,
                        "Unknown date",
                        Map.of("attributes", Map.of("clientCode", "T03585")));
        script.set(carrier(null, 40, ConfidenceBand.MEDIUM));
        analysisService.run(undated, tenant);
        UUID unrelated =
                uploadMeeting(
                        token,
                        "Other client",
                        Map.of(
                                "startedAt",
                                "2026-03-11T15:00:00Z",
                                "attributes",
                                Map.of("clientCode", "OTHER")));
        analysisService.run(unrelated, tenant);
        JsonNode history =
                authGet("/meetings/customer-history?clientCode=T03585", token).read(HttpStatus.OK);
        assertThat(history.path("items").findValuesAsText("id"))
                .containsExactly(older.toString(), newer.toString(), undated.toString());
        assertThat(history.path("truncated").asBoolean()).isFalse();
        assertThat(history.path("items").get(0).path("customerConfidence").path("trend").isNull())
                .isTrue();
        assertThat(history.path("items").get(1).path("customerConfidence").path("trend").asText())
                .isEqualTo("IMPROVING");
        assertThat(history.path("items").get(2).path("customerConfidence").path("trend").isNull())
                .isTrue();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT count(*) FROM customer_accounts WHERE tenant_id = ? AND external_client_code = 'T03585'",
                                Integer.class,
                                tenant))
                .isEqualTo(1);
        assertThat(
                        authGet("/meetings/customer-history?clientCode=absent", token)
                                .read(HttpStatus.OK)
                                .path("items")
                                .isEmpty())
                .isTrue();
        String outsider =
                signupAndLogin(
                        "commercial-history-outsider@nora.dev", "StrongPass123!", "Other Tenant");
        assertThat(
                        authGet("/meetings/customer-history?clientCode=T03585", outsider)
                                .read(HttpStatus.OK)
                                .path("items")
                                .isEmpty())
                .isTrue();
        script.set(null);
        analysisService.run(newer, tenant);
        assertThat(
                        authGet("/meetings/" + newer, token)
                                .read(HttpStatus.OK)
                                .path("customerConfidence")
                                .isNull())
                .isTrue();
    }

    private static CustomerConfidenceCarrier carrier(
            String accountName, int score, ConfidenceBand band) {
        BuyingSignal signal =
                new BuyingSignal(
                        BuyingSignalType.BUDGET_DISCUSSED,
                        "Temos orcamento aprovado para este trimestre",
                        0.8,
                        0);
        Objection objection =
                new Objection(
                        ObjectionType.PRICE,
                        "O preco esta acima do que esperavamos",
                        ObjectionSeverity.MEDIUM,
                        "Concorrente X",
                        0);
        // the trend below is a guess from the worker; the backend ignores it.
        return new CustomerConfidenceCarrier(
                accountName,
                score,
                band,
                ConfidenceTrend.STABLE,
                List.of(signal),
                List.of(objection),
                "rationale do stub para o customer confidence em teste integrado");
    }

    /* ---------- helpers (mirror ProductivityFlowIntegrationTest) ---------- */

    private UUID principalTenantId(String token) throws Exception {
        UUID meeting = uploadMeeting(token, "tmp tenant probe " + UUID.randomUUID());
        JsonNode detail = authGet("/meetings/" + meeting, token).read(HttpStatus.OK);
        return UUID.fromString(detail.get("tenantId").asText());
    }

    private UUID uploadMeeting(String token, String title) throws Exception {
        return uploadMeeting(token, title, Map.of("startedAt", OffsetDateTime.now().toString()));
    }

    private UUID uploadMeeting(String token, String title, Map<String, Object> extra)
            throws Exception {
        Map<String, Object> fields = new java.util.HashMap<>(extra);
        fields.putAll(Map.of("title", title, "language", "pt-BR", "transcriptFormat", "TXT"));
        String metadata = mapper.writeValueAsString(fields);
        String content =
                "Lucas: bom dia. Marina: bom dia.\n"
                        + "Lucas: vamos discutir o tema da reuniao. Marina: certo.";
        ResponseEntity<String> resp =
                multipartUpload(
                        "/meetings", token, metadata, content.getBytes(StandardCharsets.UTF_8));
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        JsonNode body = mapper.readTree(resp.getBody());
        return UUID.fromString(body.get("id").asText());
    }

    private String signupAndLogin(String email, String pwd, String name) throws Exception {
        JsonNode signup =
                postJson(
                                "/auth/signup",
                                Map.of("email", email, "password", pwd, "displayName", name))
                        .read(HttpStatus.CREATED);
        String verifyToken = signup.get("emailVerificationDevToken").asText();
        postJson("/auth/verify-email", Map.of("token", verifyToken)).read(HttpStatus.NO_CONTENT);
        jdbc.update(
                "UPDATE tenants SET plan = 'ENTERPRISE' WHERE id = "
                        + "(SELECT tenant_id FROM users WHERE email = ?)",
                email);
        JsonNode login =
                postJson("/auth/login", Map.of("email", email, "password", pwd))
                        .read(HttpStatus.OK);
        return login.get("accessToken").asText();
    }

    private ResponseEntity<String> multipartUpload(
            String path, String token, String metadataJson, byte[] fileBytes) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        headers.setBearerAuth(token);

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();

        HttpHeaders metaH = new HttpHeaders();
        metaH.setContentType(MediaType.APPLICATION_JSON);
        body.add("metadata", new HttpEntity<>(metadataJson, metaH));

        HttpHeaders fileH = new HttpHeaders();
        fileH.setContentType(MediaType.TEXT_PLAIN);
        ByteArrayResource fileResource =
                new ByteArrayResource(fileBytes) {
                    @Override
                    public String getFilename() {
                        return "transcript.txt";
                    }
                };
        body.add("file", new HttpEntity<>(fileResource, fileH));

        HttpEntity<MultiValueMap<String, Object>> entity = new HttpEntity<>(body, headers);
        return rest.postForEntity(path, entity, String.class);
    }

    private RequestExec postJson(String path, Map<String, ?> body) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<String> entity = new HttpEntity<>(mapper.writeValueAsString(body), headers);
        return new RequestExec(rest.postForEntity(path, entity, String.class));
    }

    private RequestExec authGet(String path, String token) {
        return new RequestExec(authGetRaw(path, token));
    }

    private ResponseEntity<String> authGetRaw(String path, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return rest.exchange(path, HttpMethod.GET, new HttpEntity<>(headers), String.class);
    }

    private final class RequestExec {
        final ResponseEntity<String> response;

        RequestExec(ResponseEntity<String> r) {
            this.response = r;
        }

        JsonNode read(HttpStatus expected) throws Exception {
            assertThat(response.getStatusCode())
                    .as("body=%s", response.getBody())
                    .isEqualTo(expected);
            return response.getBody() == null
                    ? mapper.createObjectNode()
                    : mapper.readTree(response.getBody());
        }
    }

    /**
     * Controllable state of the customerConfidence block that the worker stub should emit on the
     * next analysis. Lets each test declare the carrier (or null for an internal meeting).
     */
    static final class ConfidenceScript {
        private final AtomicReference<CustomerConfidenceCarrier> next = new AtomicReference<>();
        private final AtomicReference<Optional<TenantContext>> lastContext =
                new AtomicReference<>(Optional.empty());

        void set(CustomerConfidenceCarrier carrier) {
            next.set(carrier);
        }

        void reset() {
            next.set(null);
            lastContext.set(Optional.empty());
        }

        CustomerConfidenceCarrier current() {
            return next.get();
        }
    }

    /** Deterministic worker stub. Emits the confidence defined by {@link ConfidenceScript}. */
    @TestConfiguration
    static class StubWorkerConfig {

        @Bean
        ConfidenceScript confidenceScript() {
            return new ConfidenceScript();
        }

        @Bean
        @Primary
        NlpWorkerClient stubWorker(ConfidenceScript scriptBean) {
            return new NlpWorkerClient() {
                @Override
                public AnalysisResult analyze(
                        UUID meetingId,
                        UUID tenantId,
                        String language,
                        String transcript,
                        Optional<TenantContext> tenantContext,
                        Optional<br.com.nora.api.domain.meeting.productivity.MeetingGoal> goal) {
                    scriptBean.lastContext.set(tenantContext);
                    MeetingAnalysis analysis =
                            MeetingAnalysis.newAnalysis(
                                    meetingId,
                                    tenantId,
                                    "Resumo stub para a reuniao em teste integrado.",
                                    Sentiment.NEUTRAL,
                                    List.of("topico1"),
                                    List.of(),
                                    List.of(),
                                    List.of(),
                                    List.of(),
                                    "stub-1",
                                    "meeting-analysis-v1",
                                    100,
                                    50,
                                    10,
                                    0);
                    return AnalysisResult.of(
                            analysis.withCommercialIntelligence(commercialFacts())
                                    .withQuality(qualityFacts(transcript)),
                            null,
                            scriptBean.current());
                }

                @Override
                public WorkerDtos.LiveAnalyzeResponse analyzeLive(
                        String transcriptChunk,
                        String language,
                        WorkerDtos.LiveHighlights previousHighlights) {
                    return new WorkerDtos.LiveAnalyzeResponse(
                            List.of(),
                            List.of(),
                            List.of(),
                            List.of(),
                            new WorkerDtos.LiveMetadata(0, 0, 0, 0, "stub-live"));
                }
            };
        }
    }

    private static br.com.nora.api.domain.analysis.AnalysisQuality qualityFacts(String transcript) {
        var zero = new br.com.nora.api.domain.analysis.AnalysisQuality.EvidenceCounts(0, 0, 0);
        var one = new br.com.nora.api.domain.analysis.AnalysisQuality.EvidenceCounts(1, 1, 1);
        return new br.com.nora.api.domain.analysis.AnalysisQuality(
                "1",
                br.com.nora.api.domain.analysis.AnalysisQuality.Origin.WORKER,
                br.com.nora.api.application.analysis.AnalysisQualityCalculator.transcript(
                        transcript),
                new br.com.nora.api.domain.analysis.AnalysisQuality.ExtractionMetrics(
                        zero,
                        0,
                        0,
                        zero,
                        zero,
                        new br.com.nora.api.domain.analysis.AnalysisQuality.CommercialMetrics(
                                one, one, one, one)));
    }
}
