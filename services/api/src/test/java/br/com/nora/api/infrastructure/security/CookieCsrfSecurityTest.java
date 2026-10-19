package br.com.nora.api.infrastructure.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.head;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import br.com.nora.api.api.controllers.CsrfController;
import br.com.nora.api.infrastructure.security.JjwtJwtIssuer.AuthenticatedPrincipal;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.test.context.web.WebAppConfiguration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

@ExtendWith(SpringExtension.class)
@WebAppConfiguration
@ContextConfiguration(
        classes = {SecurityConfig.class, CsrfController.class, CookieCsrfSecurityTest.Config.class})
@TestPropertySource(
        properties = {"nora.auth.cookie-secure=true", "nora.auth.cookie-domain=nora.test"})
class CookieCsrfSecurityTest {

    @Autowired WebApplicationContext context;
    private MockMvc mvc;

    @BeforeEach
    void setup() {
        mvc = MockMvcBuilders.webAppContextSetup(context).apply(springSecurity()).build();
    }

    @Test
    void bootstrapReturnsRawTokenInAnUncacheableResponseAndHttpOnlyCookie() throws Exception {
        MvcResult result = mvc.perform(get("/auth/csrf")).andExpect(status().isOk()).andReturn();
        Cookie cookie = result.getResponse().getCookie("XSRF-TOKEN");
        assertThat(cookie).isNotNull();
        assertThat(cookie.isHttpOnly()).isTrue();
        assertThat(cookie.getSecure()).isTrue();
        assertThat(cookie.getDomain()).isEqualTo("nora.test");
        assertThat(cookie.getPath()).isEqualTo("/");
        assertThat(cookie.getAttribute("SameSite")).isEqualTo("Lax");
        assertThat(result.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).isEqualTo("no-store");
        var body = new ObjectMapper().readTree(result.getResponse().getContentAsString());
        assertThat(body.get("token").asText()).isEqualTo(cookie.getValue());
        assertThat(body.get("headerName").asText()).isEqualTo("X-XSRF-TOKEN");
    }

    @Test
    void cookieWritesRequireCsrfEvenWithAnAuthorizationHeader() throws Exception {
        for (String name : List.of("nora_access", "nora_refresh")) {
            mvc.perform(post("/auth/logout").cookie(new Cookie(name, "session")))
                    .andExpect(status().isForbidden());
            mvc.perform(
                            post("/auth/refresh")
                                    .cookie(new Cookie(name, "session"))
                                    .header(HttpHeaders.AUTHORIZATION, "Bearer unrelated")
                                    .contentType("application/x-www-form-urlencoded")
                                    .content("action=logout"))
                    .andExpect(status().isForbidden());
        }
    }

    @Test
    void matchingCookieAndHeaderPermitWritesButMismatchesDoNot() throws Exception {
        Cookie csrf = bootstrap();
        Cookie session = new Cookie("nora_access", "session");
        mvc.perform(post("/tasks").cookie(session, csrf).param("_csrf", csrf.getValue()))
                .andExpect(status().isForbidden());
        mvc.perform(post("/tasks").cookie(session, csrf).header("X-XSRF-TOKEN", "wrong"))
                .andExpect(status().isForbidden());
        mvc.perform(post("/tasks").cookie(session, csrf).header("X-XSRF-TOKEN", csrf.getValue()))
                .andExpect(status().isNoContent());
        mvc.perform(
                        post("/auth/refresh")
                                .cookie(new Cookie("nora_refresh", "refresh"), csrf)
                                .header("X-XSRF-TOKEN", csrf.getValue()))
                .andExpect(status().isNoContent());
    }

    @Test
    void billedSearchRejectsCrossSiteNavigationIncludingHead() throws Exception {
        Cookie session = new Cookie("nora_access", "session");
        mvc.perform(get("/meetings/search").cookie(session)).andExpect(status().isForbidden());
        mvc.perform(head("/meetings/search").cookie(session)).andExpect(status().isForbidden());
        Cookie csrf = bootstrap();
        mvc.perform(
                        get("/meetings/search")
                                .cookie(session, csrf)
                                .header("X-XSRF-TOKEN", csrf.getValue()))
                .andExpect(status().isOk());
        mvc.perform(get("/tasks").cookie(session)).andExpect(status().isOk());
    }

    @Test
    void nativeBearerClientsDoNotNeedBrowserCsrfTokens() throws Exception {
        mvc.perform(post("/tasks").header(HttpHeaders.AUTHORIZATION, "Bearer native"))
                .andExpect(status().isNoContent());
        mvc.perform(get("/meetings/search").header(HttpHeaders.AUTHORIZATION, "Bearer native"))
                .andExpect(status().isOk());
        mvc.perform(post("/tasks")).andExpect(status().isUnauthorized());
    }

    private Cookie bootstrap() throws Exception {
        return mvc.perform(get("/auth/csrf"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getCookie("XSRF-TOKEN");
    }

    @Configuration
    @EnableWebSecurity
    @EnableWebMvc
    static class Config {
        @Bean
        JwtAuthenticationFilter jwtFilter() {
            JjwtJwtIssuer issuer = mock(JjwtJwtIssuer.class);
            when(issuer.parse(anyString()))
                    .thenReturn(
                            new AuthenticatedPrincipal(
                                    UUID.randomUUID(),
                                    UUID.randomUUID(),
                                    "director@nora.test",
                                    List.of()));
            return new JwtAuthenticationFilter(issuer);
        }

        @Bean
        ProbeController probes() {
            return new ProbeController();
        }
    }

    @RestController
    static class ProbeController {
        @PostMapping({"/tasks", "/auth/refresh", "/auth/logout"})
        ResponseEntity<Void> write() {
            return ResponseEntity.noContent().build();
        }

        @GetMapping({"/tasks", "/meetings/search"})
        ResponseEntity<String> read() {
            return ResponseEntity.ok("[]");
        }
    }
}
