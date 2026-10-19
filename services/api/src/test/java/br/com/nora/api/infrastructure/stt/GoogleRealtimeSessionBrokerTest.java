package br.com.nora.api.infrastructure.stt;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import br.com.nora.api.application.stt.RealtimeSttSession;
import br.com.nora.api.application.stt.SttException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.junit5.WireMockRuntimeInfo;
import com.github.tomakehurst.wiremock.junit5.WireMockTest;
import com.github.tomakehurst.wiremock.verification.LoggedRequest;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

@WireMockTest
@ExtendWith(OutputCaptureExtension.class)
class GoogleRealtimeSessionBrokerTest {

    private static final String KEY = "test-google-server-account-key";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static GoogleSttProperties props(String baseUrl, String key) {
        return new GoogleSttProperties(key, baseUrl, null, null, 600, 1_800, 2_000);
    }

    private static GoogleRealtimeSessionBroker broker(WireMockRuntimeInfo wm) {
        return new GoogleRealtimeSessionBroker(props(wm.getHttpBaseUrl() + "/v1beta", KEY), MAPPER);
    }

    private static void stub(WireMockRuntimeInfo wm, int status, String body) {
        wm.getWireMock()
                .register(
                        post(urlPathEqualTo("/v1beta/auth_tokens"))
                                .willReturn(
                                        aResponse()
                                                .withStatus(status)
                                                .withHeader("Content-Type", "application/json")
                                                .withBody(body)));
    }

    @Test
    void mintsOnlyAConstrainedSingleUseCredentialWithTheRegionalLanguage(WireMockRuntimeInfo wm)
            throws Exception {
        stub(wm, 200, "{\"name\":\"auth_tokens/ephemeral-client-token\"}");
        Instant startedAt = Instant.now();
        RealtimeSttSession session = broker(wm).openSession("pt-BR");
        LoggedRequest request =
                wm.getWireMock()
                        .find(postRequestedFor(urlPathEqualTo("/v1beta/auth_tokens")))
                        .getFirst();
        JsonNode body = MAPPER.readTree(request.getBodyAsString());
        assertThat(request.getHeader("X-goog-api-key")).isEqualTo(KEY);
        assertThat(request.getHeader("Authorization")).isNull();
        assertThat(request.getUrl()).isEqualTo("/v1beta/auth_tokens");
        assertThat(request.getBodyAsString()).doesNotContain(KEY);
        assertThat(body.path("uses").asInt()).isEqualTo(1);
        assertThat(body.has("fieldMask")).isFalse();
        assertThat(body.has("liveConnectConstraints")).isFalse();
        JsonNode setup = body.path("bidiGenerateContentSetup");
        assertThat(setup.path("model").asText()).isEqualTo("models/gemini-3.5-transcribe-live");
        assertThat(setup.path("generationConfig").path("responseModalities"))
                .isEqualTo(MAPPER.readTree("[\"TEXT\"]"));
        assertThat(setup.path("inputAudioTranscription").path("languageCodes"))
                .isEqualTo(MAPPER.readTree("[\"pt-BR\"]"));
        Instant openingExpiry = Instant.parse(body.path("newSessionExpireTime").asText());
        Instant sessionExpiry = Instant.parse(body.path("expireTime").asText());
        assertThat(openingExpiry)
                .isBetween(startedAt.plusSeconds(600), Instant.now().plusSeconds(600));
        assertThat(Duration.between(openingExpiry, sessionExpiry))
                .isEqualTo(Duration.ofSeconds(1_200));
        assertThat(session.expiresAt()).isEqualTo(openingExpiry);
        assertThat(session.clientSecret()).isEqualTo("auth_tokens/ephemeral-client-token");
        assertThat(session.provider()).isEqualTo("google");
        assertThat(session.model()).isEqualTo("gemini-3.5-transcribe-live");
        assertThat(session.language()).isEqualTo("pt-BR");
        assertThat(session.audioFormat()).isEqualTo("audio/pcm");
        assertThat(session.sampleRate()).isEqualTo(16_000);
        assertThat(session.websocketUrl()).isEqualTo(GoogleSttProperties.DEFAULT_REALTIME_URL);
        assertThat(session.toString()).doesNotContain(KEY, "ephemeral-client-token");
    }

    @Test
    void missingCredentialsFailBeforeSendingAnyRequest(WireMockRuntimeInfo wm) {
        for (String key : List.of("", "unset", "  ")) {
            GoogleRealtimeSessionBroker broker =
                    new GoogleRealtimeSessionBroker(
                            props(wm.getHttpBaseUrl() + "/v1beta", key), MAPPER);
            assertThatThrownBy(() -> broker.openSession("pt-BR"))
                    .isInstanceOf(SttException.NotConfigured.class);
        }
        wm.getWireMock().verifyThat(0, postRequestedFor(urlPathEqualTo("/v1beta/auth_tokens")));
    }

    @Test
    void providerErrorsNeverEchoTheirBodyOrCredential(
            WireMockRuntimeInfo wm, CapturedOutput output) {
        stub(wm, 401, "{\"error\":{\"message\":\"Invalid API key: " + KEY + "\"}}");
        assertThatThrownBy(() -> broker(wm).openSession("pt-BR"))
                .isInstanceOf(SttException.BrokerError.class)
                .hasMessageContaining("401")
                .hasMessageNotContaining(KEY);
        assertThat(output.getAll()).doesNotContain(KEY);
    }

    @Test
    void malformedAndReflectedCredentialsAreRefused(WireMockRuntimeInfo wm) {
        for (String body :
                List.of(
                        "not JSON",
                        "null",
                        "{}",
                        "{\"name\":42}",
                        "{\"name\":\"auth_tokens/\"}",
                        "{\"name\":\"" + KEY + "\"}",
                        "{\"name\":\"auth_tokens/" + KEY + "\"}",
                        "{\"name\":\"auth_tokens/bad\\nheader\"}")) {
            stub(wm, 200, body);
            assertThatThrownBy(() -> broker(wm).openSession("pt-BR"))
                    .isInstanceOf(SttException.BrokerError.class)
                    .hasMessageNotContaining(KEY);
        }
    }

    @Test
    void redirectsCannotForwardTheAccountKey(WireMockRuntimeInfo wm) {
        wm.getWireMock()
                .register(
                        post(urlPathEqualTo("/v1beta/auth_tokens"))
                                .willReturn(
                                        aResponse()
                                                .withStatus(307)
                                                .withHeader(
                                                        "Location",
                                                        wm.getHttpBaseUrl() + "/redirected")));
        assertThatThrownBy(() -> broker(wm).openSession("pt-BR"))
                .isInstanceOf(SttException.BrokerError.class)
                .hasMessageContaining("307");
        wm.getWireMock().verifyThat(0, postRequestedFor(urlPathEqualTo("/redirected")));
    }

    @Test
    void aStalledProviderHasABoundedFailure(WireMockRuntimeInfo wm) {
        wm.getWireMock()
                .register(
                        post(urlPathEqualTo("/v1beta/auth_tokens"))
                                .willReturn(
                                        aResponse()
                                                .withStatus(200)
                                                .withFixedDelay(500)
                                                .withBody("{\"name\":\"auth_tokens/late\"}")));
        GoogleSttProperties config =
                new GoogleSttProperties(
                        KEY, wm.getHttpBaseUrl() + "/v1beta", null, null, 600, 1_800, 100);
        assertThatThrownBy(
                        () -> new GoogleRealtimeSessionBroker(config, MAPPER).openSession("pt-BR"))
                .isInstanceOf(SttException.BrokerError.class)
                .hasMessageNotContaining(KEY);
    }

    @Test
    void defaultsHideTheAccountKeyAndRejectCredentialBearingEndpoints() {
        GoogleSttProperties config = new GoogleSttProperties(KEY, null, null, null, 0, 0, 0);
        assertThat(config.model()).isEqualTo("gemini-3.5-transcribe-live");
        assertThat(config.newSessionTtlSeconds()).isEqualTo(600);
        assertThat(config.sessionTtlSeconds()).isEqualTo(1_800);
        assertThat(config.toString()).doesNotContain(KEY).contains("<redacted>");
        for (String endpoint :
                List.of(
                        "https://attacker.invalid/v1beta",
                        "https://generativelanguage.googleapis.com/v1beta?key=" + KEY,
                        "http://localhost:1234@attacker.invalid/v1beta")) {
            assertThatThrownBy(() -> new GoogleSttProperties(KEY, endpoint, null, null, 0, 0, 0))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageNotContaining(KEY);
        }
    }
}
