package br.com.nora.api.infrastructure.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import br.com.nora.api.api.controllers.CsrfController;
import br.com.nora.api.infrastructure.security.JjwtJwtIssuer.AuthenticatedPrincipal;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpCookie;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestComponent;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootTest(
        classes = CookieCsrfHttpIntegrationTest.Config.class,
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"nora.auth.cookie-secure=false", "nora.auth.cookie-domain="})
class CookieCsrfHttpIntegrationTest {

    @LocalServerPort private int port;
    @Autowired private ObjectMapper mapper;
    @Autowired private ProbeController probe;

    private CookieManager cookies;
    private HttpClient client;

    @BeforeEach
    void setup() {
        cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        client =
                HttpClient.newBuilder()
                        .cookieHandler(cookies)
                        .connectTimeout(Duration.ofSeconds(5))
                        .build();
        probe.writes.set(0);
        probe.searches.set(0);
    }

    @Test
    void browserTokenSurvivesAuthenticatedReadsAndConsecutiveWrites() throws Exception {
        seedCookie("nora_access", "valid-access", "/");
        String token = bootstrap();

        assertThat(request("GET", "/tasks", Map.of(), "").statusCode()).isEqualTo(200);
        assertThat(request("GET", "/auth/me", Map.of(), "").statusCode()).isEqualTo(200);
        assertThat(cookieValue("XSRF-TOKEN")).isEqualTo(token);
        assertThat(request("POST", "/tasks", Map.of("X-XSRF-TOKEN", token), "").statusCode())
                .isEqualTo(204);
        assertThat(cookieValue("XSRF-TOKEN")).isEqualTo(token);
        assertThat(request("GET", "/tasks", Map.of(), "").statusCode()).isEqualTo(200);
        assertThat(request("POST", "/tasks", Map.of("X-XSRF-TOKEN", token), "").statusCode())
                .isEqualTo(204);
        assertThat(probe.writes.get()).isEqualTo(2);
    }

    @Test
    void cookieWritesRejectMissingWrongAndParameterTokensWithoutErrorRedispatch() throws Exception {
        seedCookie("nora_access", "valid-access", "/");
        String token = bootstrap();

        assertThat(request("POST", "/tasks", Map.of(), "").statusCode()).isEqualTo(403);
        assertThat(request("POST", "/tasks", Map.of("X-XSRF-TOKEN", "wrong"), "").statusCode())
                .isEqualTo(403);
        assertThat(request("POST", "/tasks?_csrf=" + token, Map.of(), "").statusCode())
                .isEqualTo(403);
        assertThat(
                        request(
                                        "POST",
                                        "/tasks",
                                        Map.of("Content-Type", "application/x-www-form-urlencoded"),
                                        "_csrf=" + token)
                                .statusCode())
                .isEqualTo(403);
        assertThat(
                        request(
                                        "POST",
                                        "/tasks",
                                        Map.of("Authorization", "Bearer valid-native"),
                                        "")
                                .statusCode())
                .isEqualTo(403);
        assertThat(probe.writes.get()).isZero();
        assertThat(request("GET", "/auth/me", Map.of(), "").statusCode()).isEqualTo(200);
        assertThat(cookieValue("XSRF-TOKEN")).isEqualTo(token);
    }

    @Test
    void refreshOnlyCookiesRequireTheCsrfHeaderForRefreshAndLogout() throws Exception {
        seedCookie("nora_refresh", "valid-refresh", "/auth");
        String token = bootstrap();

        for (String path : List.of("/auth/refresh", "/auth/logout")) {
            assertThat(request("POST", path, Map.of(), "").statusCode()).isEqualTo(403);
            assertThat(request("POST", path, Map.of("X-XSRF-TOKEN", "wrong"), "").statusCode())
                    .isEqualTo(403);
            assertThat(request("POST", path, Map.of("X-XSRF-TOKEN", token), "").statusCode())
                    .isEqualTo(204);
        }
        assertThat(probe.writes.get()).isEqualTo(2);
    }

    @Test
    void billedSearchRequiresCsrfForGetAndHeadBeforeInvokingTheController() throws Exception {
        seedCookie("nora_access", "valid-access", "/");
        String token = bootstrap();

        for (String method : List.of("GET", "HEAD")) {
            assertThat(request(method, "/meetings/search?q=probe", Map.of(), "").statusCode())
                    .isEqualTo(403);
            assertThat(
                            request(
                                            method,
                                            "/meetings/search?q=probe",
                                            Map.of("X-XSRF-TOKEN", "wrong"),
                                            "")
                                    .statusCode())
                    .isEqualTo(403);
        }
        assertThat(probe.searches.get()).isZero();
        for (String method : List.of("GET", "HEAD")) {
            assertThat(
                            request(
                                            method,
                                            "/meetings/search?q=probe",
                                            Map.of("X-XSRF-TOKEN", token),
                                            "")
                                    .statusCode())
                    .isEqualTo(200);
        }
        assertThat(probe.searches.get()).isEqualTo(2);
    }

    @Test
    void nativeBearerClientsRemainCookieFreeAndUnauthenticatedRequestsStayDenied()
            throws Exception {
        Map<String, String> bearer = Map.of("Authorization", "Bearer valid-native");
        assertThat(request("POST", "/tasks", bearer, "").statusCode()).isEqualTo(204);
        assertThat(request("GET", "/meetings/search?q=probe", bearer, "").statusCode())
                .isEqualTo(200);
        assertThat(request("POST", "/tasks", Map.of(), "").statusCode()).isEqualTo(401);
        assertThat(request("GET", "/error", Map.of(), "").statusCode()).isEqualTo(401);
        assertThat(probe.writes.get()).isEqualTo(1);
        assertThat(probe.searches.get()).isEqualTo(1);
    }

    private String bootstrap() throws Exception {
        HttpResponse<String> response = request("GET", "/auth/csrf", Map.of(), "");
        assertThat(response.statusCode()).isEqualTo(200);
        String token = mapper.readTree(response.body()).get("token").asText();
        assertThat(cookieValue("XSRF-TOKEN")).isEqualTo(token);
        return token;
    }

    private void seedCookie(String name, String value, String path) {
        HttpCookie cookie = new HttpCookie(name, value);
        cookie.setVersion(0);
        cookie.setPath(path);
        cookies.getCookieStore().add(URI.create("http://localhost:" + port), cookie);
    }

    private String cookieValue(String name) {
        return cookies.getCookieStore().getCookies().stream()
                .filter(cookie -> cookie.getName().equals(name))
                .map(HttpCookie::getValue)
                .findFirst()
                .orElse(null);
    }

    private HttpResponse<String> request(
            String method, String path, Map<String, String> headers, String body) throws Exception {
        HttpRequest.Builder request =
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                        .timeout(Duration.ofSeconds(10))
                        .method(method, HttpRequest.BodyPublishers.ofString(body));
        headers.forEach(request::header);
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @TestComponent
    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration(
            exclude = {
                DataSourceAutoConfiguration.class,
                HibernateJpaAutoConfiguration.class,
                FlywayAutoConfiguration.class,
                UserDetailsServiceAutoConfiguration.class
            })
    @Import({SecurityConfig.class, CsrfController.class, ProbeController.class})
    static class Config {
        @Bean
        JwtAuthenticationFilter jwtFilter() {
            JjwtJwtIssuer issuer = mock(JjwtJwtIssuer.class);
            AuthenticatedPrincipal principal =
                    new AuthenticatedPrincipal(
                            UUID.randomUUID(), UUID.randomUUID(), "director@nora.test", List.of());
            when(issuer.parse("valid-access")).thenReturn(principal);
            when(issuer.parse("valid-native")).thenReturn(principal);
            return new JwtAuthenticationFilter(issuer);
        }
    }

    @TestComponent
    @RestController
    static class ProbeController {
        private final AtomicInteger writes = new AtomicInteger();
        private final AtomicInteger searches = new AtomicInteger();

        @GetMapping({"/tasks", "/auth/me"})
        String read() {
            return "ok";
        }

        @PostMapping({"/tasks", "/auth/refresh", "/auth/logout"})
        ResponseEntity<Void> write() {
            writes.incrementAndGet();
            return ResponseEntity.noContent().build();
        }

        @GetMapping("/meetings/search")
        String search() {
            searches.incrementAndGet();
            return "[]";
        }
    }
}
