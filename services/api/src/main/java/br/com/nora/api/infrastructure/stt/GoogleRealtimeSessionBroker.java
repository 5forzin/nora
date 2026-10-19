package br.com.nora.api.infrastructure.stt;

import br.com.nora.api.application.stt.RealtimeSttSession;
import br.com.nora.api.application.stt.SttException;
import br.com.nora.api.application.stt.ports.RealtimeSttBroker;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** Mints one constrained Google Live credential without sending the account key to the client. */
@Component
@ConditionalOnProperty(name = "nora.stt.provider", havingValue = "google")
public class GoogleRealtimeSessionBroker implements RealtimeSttBroker {

    private static final Logger LOG = LoggerFactory.getLogger(GoogleRealtimeSessionBroker.class);

    private final GoogleSttProperties props;
    private final ObjectMapper mapper;
    private final HttpClient http;

    public GoogleRealtimeSessionBroker(GoogleSttProperties props, ObjectMapper mapper) {
        this.props = props;
        this.mapper = mapper;
        this.http =
                HttpClient.newBuilder()
                        .connectTimeout(
                                Duration.ofMillis(Math.max(1_000L, props.requestTimeoutMs() / 2L)))
                        .followRedirects(HttpClient.Redirect.NEVER)
                        .build();
    }

    @Override
    public String provider() {
        return "google";
    }

    @Override
    public String model() {
        return props.model();
    }

    @Override
    public RealtimeSttSession openSession(String language) {
        if (!props.isConfigured()) {
            throw new SttException.NotConfigured();
        }
        Instant issuedAt = Instant.now();
        Instant openingExpiry = issuedAt.plusSeconds(props.newSessionTtlSeconds());
        HttpResponse<String> response = send(language, issuedAt, openingExpiry);
        if (response.statusCode() != 200) {
            LOG.warn("Google STT session mint refused: status={}", response.statusCode());
            throw new SttException.BrokerError(
                    "The provider refused the session (HTTP " + response.statusCode() + ").");
        }
        String secret = credential(response.body());
        return new RealtimeSttSession(
                secret,
                openingExpiry,
                props.realtimeUrl(),
                provider(),
                props.model(),
                language,
                "audio/pcm",
                GoogleSttProperties.SAMPLE_RATE);
    }

    private HttpResponse<String> send(String language, Instant issuedAt, Instant openingExpiry) {
        try {
            HttpRequest request =
                    HttpRequest.newBuilder(URI.create(props.baseUrl() + "/auth_tokens"))
                            .timeout(Duration.ofMillis(props.requestTimeoutMs()))
                            .header("X-goog-api-key", props.apiKey())
                            .header("Content-Type", "application/json")
                            .POST(
                                    HttpRequest.BodyPublishers.ofString(
                                            payload(language, issuedAt, openingExpiry)))
                            .build();
            return http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SttException.BrokerError("Interrupted while creating the STT session.");
        } catch (Exception e) {
            LOG.warn("Google STT session mint failed: {}", e.getClass().getSimpleName());
            throw new SttException.BrokerError("Could not reach the transcription provider.");
        }
    }

    private String payload(String language, Instant issuedAt, Instant openingExpiry) {
        ObjectNode body = mapper.createObjectNode();
        body.put("uses", 1);
        body.put("expireTime", issuedAt.plusSeconds(props.sessionTtlSeconds()).toString());
        body.put("newSessionExpireTime", openingExpiry.toString());
        // This is the REST field. The SDK's liveConnectConstraints name is not accepted on the
        // wire.
        ObjectNode setup = body.putObject("bidiGenerateContentSetup");
        setup.put("model", "models/" + props.model());
        setup.putObject("generationConfig").putArray("responseModalities").add("TEXT");
        setup.putObject("inputAudioTranscription").putArray("languageCodes").add(language);
        return body.toString();
    }

    private String credential(String raw) {
        try {
            JsonNode name = mapper.readTree(raw).path("name");
            String value = name.isTextual() ? name.textValue() : "";
            if (!value.startsWith("auth_tokens/")
                    || value.length() <= "auth_tokens/".length()
                    || value.contains(props.apiKey())
                    || value.chars()
                            .anyMatch(
                                    c -> Character.isWhitespace(c) || Character.isISOControl(c))) {
                throw new IllegalArgumentException();
            }
            return value;
        } catch (Exception e) {
            throw new SttException.BrokerError(
                    "The provider returned an unreadable session credential.");
        }
    }
}
