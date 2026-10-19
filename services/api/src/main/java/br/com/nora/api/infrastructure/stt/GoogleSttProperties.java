package br.com.nora.api.infrastructure.stt;

import java.net.URI;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Google Live configuration; the account key is never included in diagnostics. */
@ConfigurationProperties(prefix = "nora.stt.google")
public record GoogleSttProperties(
        String apiKey,
        String baseUrl,
        String realtimeUrl,
        String model,
        int newSessionTtlSeconds,
        int sessionTtlSeconds,
        int requestTimeoutMs) {

    static final String DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
    static final String DEFAULT_REALTIME_URL =
            "wss://generativelanguage.googleapis.com/ws/"
                    + "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
    static final String DEFAULT_MODEL = "gemini-3.5-transcribe-live";
    static final int SAMPLE_RATE = 16_000;

    public GoogleSttProperties {
        apiKey = apiKey == null || "unset".equals(apiKey.trim()) ? "" : apiKey.trim();
        baseUrl = orDefault(baseUrl, DEFAULT_BASE_URL).replaceAll("/+$", "");
        realtimeUrl = orDefault(realtimeUrl, DEFAULT_REALTIME_URL);
        model = orDefault(model, DEFAULT_MODEL);
        if (model.startsWith("models/")) {
            model = model.substring("models/".length());
        }
        newSessionTtlSeconds = newSessionTtlSeconds > 0 ? newSessionTtlSeconds : 600;
        sessionTtlSeconds = sessionTtlSeconds > 0 ? sessionTtlSeconds : 1_800;
        requestTimeoutMs = requestTimeoutMs > 0 ? requestTimeoutMs : 5_000;
        if (newSessionTtlSeconds > sessionTtlSeconds || sessionTtlSeconds >= 72_000) {
            throw new IllegalArgumentException("Invalid Google STT credential lifetime.");
        }
        if (!model.matches("gemini-[A-Za-z0-9.-]+")) {
            throw new IllegalArgumentException("Invalid Google STT model.");
        }
        validateEndpoints(baseUrl, realtimeUrl);
    }

    public boolean isConfigured() {
        return !apiKey.isBlank();
    }

    private static String orDefault(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static void validateEndpoints(String baseUrl, String realtimeUrl) {
        try {
            URI rest = URI.create(baseUrl);
            boolean localTestEndpoint =
                    "http".equals(rest.getScheme())
                            && ("localhost".equals(rest.getHost())
                                    || "127.0.0.1".equals(rest.getHost()))
                            && rest.getPort() > 0;
            boolean googleEndpoint = DEFAULT_BASE_URL.equals(baseUrl);
            if ((!googleEndpoint && !localTestEndpoint)
                    || rest.getRawUserInfo() != null
                    || rest.getRawQuery() != null
                    || rest.getRawFragment() != null
                    || !DEFAULT_REALTIME_URL.equals(realtimeUrl)) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(
                    "Google STT requires its HTTPS and constrained WebSocket endpoints.");
        }
    }

    @Override
    public String toString() {
        return "GoogleSttProperties[apiKey=<redacted>, model="
                + model
                + ", newSessionTtlSeconds="
                + newSessionTtlSeconds
                + ", sessionTtlSeconds="
                + sessionTtlSeconds
                + ", requestTimeoutMs="
                + requestTimeoutMs
                + "]";
    }
}
