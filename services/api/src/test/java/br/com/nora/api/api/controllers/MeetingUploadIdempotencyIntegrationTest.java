package br.com.nora.api.api.controllers;

import static org.assertj.core.api.Assertions.assertThat;

import br.com.nora.api.application.meeting.MeetingService.UploadCommand;
import br.com.nora.api.application.meeting.MeetingUploadService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Testcontainers
class MeetingUploadIdempotencyIntegrationTest {
    private static final String TEXT = "Marina: deliver the reviewed proposal on Friday.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
    }

    @Autowired TestRestTemplate rest;
    @Autowired ObjectMapper mapper;
    @Autowired JdbcTemplate jdbc;
    @Autowired MeetingUploadService uploads;
    @Autowired PlatformTransactionManager transactions;

    @BeforeEach
    void client() {
        rest.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
    }

    @Test
    void retryAfterLostResponseReturnsOriginalWithoutCreatingOrDispatchingAgain() throws Exception {
        Account account = account();
        String key = UUID.randomUUID().toString();
        JsonNode first = read(upload(account, key, "Pilot", TEXT), HttpStatus.ACCEPTED);
        UUID id = UUID.fromString(first.path("id").asText());
        jdbc.update("UPDATE meetings SET processing_status = 'FAILED' WHERE id = ?", id);

        JsonNode retry = read(upload(account, key, "Pilot", TEXT), HttpStatus.ACCEPTED);
        assertThat(retry.path("id").asText()).isEqualTo(id.toString());
        assertThat(retry.path("processingStatus").asText()).isEqualTo("FAILED");
        assertThat(count("meetings", account.tenantId())).isEqualTo(1);
        assertThat(count("meeting_upload_requests", account.tenantId())).isEqualTo(1);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT count(*) FROM iam_audit_events WHERE tenant_id = ? AND action = 'meeting.uploaded'",
                                Long.class,
                                account.tenantId()))
                .isEqualTo(1);
    }

    @Test
    void concurrentRetriesCommitExactlyOneMeeting() throws Exception {
        Account account = account();
        String key = UUID.randomUUID().toString();
        CountDownLatch start = new CountDownLatch(1);
        List<Future<ResponseEntity<String>>> attempts = new ArrayList<>();
        try (var executor = Executors.newFixedThreadPool(6)) {
            for (int i = 0; i < 6; i++) {
                attempts.add(
                        executor.submit(
                                () -> {
                                    start.await();
                                    return upload(account, key, "Concurrent", TEXT);
                                }));
            }
            start.countDown();
            List<String> ids = new ArrayList<>();
            for (var attempt : attempts) {
                ids.add(
                        read(attempt.get(30, TimeUnit.SECONDS), HttpStatus.ACCEPTED)
                                .path("id")
                                .asText());
            }
            assertThat(ids.stream().distinct()).hasSize(1);
        }
        assertThat(count("meetings", account.tenantId())).isEqualTo(1);
        assertThat(count("transcripts", account.tenantId())).isEqualTo(1);
    }

    @Test
    void conflictingContentDoesNotOverwriteOriginal() throws Exception {
        Account account = account();
        String key = UUID.randomUUID().toString();
        read(upload(account, key, "Original", TEXT), HttpStatus.ACCEPTED);
        JsonNode titleConflict =
                read(upload(account, key, "Changed title", TEXT), HttpStatus.CONFLICT);
        assertThat(titleConflict.path("code").asText()).isEqualTo("UPLOAD_IDEMPOTENCY_CONFLICT");
        JsonNode textConflict =
                read(upload(account, key, "Original", "Different transcript"), HttpStatus.CONFLICT);
        assertThat(textConflict.path("code").asText()).isEqualTo("UPLOAD_IDEMPOTENCY_CONFLICT");
        assertThat(count("meetings", account.tenantId())).isEqualTo(1);
    }

    @Test
    void keysAreScopedToBothTenantAndUser() throws Exception {
        Account first = account();
        Account second = account();
        String key = UUID.randomUUID().toString();
        String a = read(upload(first, key, "Pilot", TEXT), HttpStatus.ACCEPTED).path("id").asText();
        String b =
                read(upload(second, key, "Pilot", TEXT), HttpStatus.ACCEPTED).path("id").asText();
        assertThat(a).isNotEqualTo(b);

        UUID memberId = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO users (id, tenant_id, email, password_hash, display_name, status, is_root, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'unused', 'Member', 'ACTIVE', FALSE, NOW(), NOW(), NOW())",
                memberId,
                first.tenantId(),
                memberId + "@nora.dev");
        var memberUpload =
                uploads.upload(
                        new UploadCommand(
                                first.tenantId(),
                                memberId,
                                "Pilot",
                                null,
                                null,
                                "pt-BR",
                                "TXT",
                                List.of(),
                                List.of(),
                                TEXT,
                                Map.of()),
                        key);
        assertThat(memberUpload.id().toString()).isNotEqualTo(a);
        assertThat(count("meeting_upload_requests", first.tenantId())).isEqualTo(2);
    }

    @Test
    void deletedOrErasedMeetingsCannotBeResurrectedByOfflineRetries() throws Exception {
        Account account = account();
        for (String endpoint : List.of("/meetings/", "/privacy/meetings/")) {
            String key = UUID.randomUUID().toString();
            String id =
                    read(upload(account, key, "Remove", TEXT), HttpStatus.ACCEPTED)
                            .path("id")
                            .asText();
            HttpHeaders headers = new HttpHeaders();
            headers.setBearerAuth(account.token());
            assertThat(
                            rest.exchange(
                                            endpoint + id,
                                            HttpMethod.DELETE,
                                            new HttpEntity<>(headers),
                                            String.class)
                                    .getStatusCode())
                    .isEqualTo(HttpStatus.NO_CONTENT);
            JsonNode retry = read(upload(account, key, "Remove", TEXT), HttpStatus.CONFLICT);
            assertThat(retry.path("code").asText()).isEqualTo("UPLOAD_ALREADY_REMOVED");
        }
        assertThat(count("meeting_upload_requests", account.tenantId())).isEqualTo(2);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT count(*) FROM meeting_upload_requests WHERE tenant_id = ? AND meeting_id IS NULL",
                                Long.class,
                                account.tenantId()))
                .isEqualTo(1);
    }

    @Test
    void rejectedUploadsDoNotReserveKeysAndLegacyRequestsStayIndependent() throws Exception {
        Account account = account();
        String key = UUID.randomUUID().toString();
        read(upload(account, key, "Pilot", "   "), HttpStatus.BAD_REQUEST);
        read(upload(account, key, "Pilot", "x".repeat(1_000_001)), HttpStatus.PAYLOAD_TOO_LARGE);
        assertThat(count("meeting_upload_requests", account.tenantId())).isZero();
        read(upload(account, key, "Pilot", TEXT), HttpStatus.ACCEPTED);
        read(upload(account, "invalid key", "Pilot", TEXT), HttpStatus.BAD_REQUEST);
        String first =
                read(upload(account, null, "Pilot", TEXT), HttpStatus.ACCEPTED).path("id").asText();
        String second =
                read(upload(account, null, "Pilot", TEXT), HttpStatus.ACCEPTED).path("id").asText();
        assertThat(first).isNotEqualTo(second);
        assertThat(count("meeting_upload_requests", account.tenantId())).isEqualTo(1);
    }

    @Test
    void reservationRowsAreFilteredByDatabaseTenantPolicy() throws Exception {
        Account a = account();
        Account b = account();
        read(upload(a, "rls-key", "A", TEXT), HttpStatus.ACCEPTED);
        read(upload(b, "rls-key", "B", TEXT), HttpStatus.ACCEPTED);
        jdbc.execute("CREATE ROLE upload_reader NOBYPASSRLS");
        jdbc.execute("GRANT USAGE ON SCHEMA public, nora TO upload_reader");
        jdbc.execute("GRANT SELECT ON meeting_upload_requests TO upload_reader");
        new TransactionTemplate(transactions)
                .executeWithoutResult(
                        status -> {
                            jdbc.execute("SET LOCAL ROLE upload_reader");
                            jdbc.queryForObject(
                                    "SELECT set_config('nora.current_tenant_id', ?, true)",
                                    String.class,
                                    a.tenantId().toString());
                            assertThat(
                                            jdbc.queryForList(
                                                    "SELECT DISTINCT tenant_id FROM meeting_upload_requests",
                                                    UUID.class))
                                    .containsExactly(a.tenantId());
                            assertThat(count("meeting_upload_requests", b.tenantId())).isZero();
                        });
    }

    private long count(String table, UUID tenant) {
        return jdbc.queryForObject(
                "SELECT count(*) FROM " + table + " WHERE tenant_id = ?", Long.class, tenant);
    }

    private Account account() throws Exception {
        String email = UUID.randomUUID() + "@nora.dev";
        String password = "SenhaForte123";
        JsonNode signup =
                read(
                        rest.postForEntity(
                                "/auth/signup",
                                Map.of(
                                        "email",
                                        email,
                                        "password",
                                        password,
                                        "displayName",
                                        "Synthetic uploader"),
                                String.class),
                        HttpStatus.CREATED);
        read(
                rest.postForEntity(
                        "/auth/verify-email",
                        Map.of("token", signup.path("emailVerificationDevToken").asText()),
                        String.class),
                HttpStatus.NO_CONTENT);
        JsonNode login =
                read(
                        rest.postForEntity(
                                "/auth/login",
                                Map.of("email", email, "password", password),
                                String.class),
                        HttpStatus.OK);
        return new Account(
                login.path("accessToken").asText(),
                UUID.fromString(login.path("tenantId").asText()));
    }

    private ResponseEntity<String> upload(Account account, String key, String title, String text)
            throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(account.token());
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        if (key != null) headers.set("Idempotency-Key", key);
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        HttpHeaders metadataHeaders = new HttpHeaders();
        metadataHeaders.setContentType(MediaType.APPLICATION_JSON);
        body.add(
                "metadata",
                new HttpEntity<>(
                        mapper.writeValueAsString(
                                Map.of(
                                        "title",
                                        title,
                                        "transcriptFormat",
                                        "TXT",
                                        "language",
                                        "pt-BR")),
                        metadataHeaders));
        body.add(
                "file",
                new ByteArrayResource(text.getBytes(StandardCharsets.UTF_8)) {
                    @Override
                    public String getFilename() {
                        return "recording.txt";
                    }
                });
        return rest.postForEntity("/meetings", new HttpEntity<>(body, headers), String.class);
    }

    private JsonNode read(ResponseEntity<String> response, HttpStatus expected) throws Exception {
        assertThat(response.getStatusCode()).as("body=%s", response.getBody()).isEqualTo(expected);
        return response.getBody() == null
                ? mapper.createObjectNode()
                : mapper.readTree(response.getBody());
    }

    private record Account(String token, UUID tenantId) {}
}
