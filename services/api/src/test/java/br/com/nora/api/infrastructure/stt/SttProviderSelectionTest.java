package br.com.nora.api.infrastructure.stt;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import br.com.nora.api.application.platform.UsageRecorder;
import br.com.nora.api.application.stt.SttSessionService;
import br.com.nora.api.application.stt.ports.RealtimeSttBroker;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.NoSuchBeanDefinitionException;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

class SttProviderSelectionTest {
    private final ApplicationContextRunner context =
            new ApplicationContextRunner().withUserConfiguration(Config.class);

    @Test
    void existingDeploymentsKeepTheOpenAiBroker() {
        context.run(
                app -> {
                    assertThat(app).hasSingleBean(RealtimeSttBroker.class);
                    assertThat(app.getBean(RealtimeSttBroker.class))
                            .isInstanceOf(OpenAiRealtimeSessionBroker.class);
                });
    }

    @Test
    void googleIsSelectedExplicitlyAndHasSeparateSettings() {
        context.withPropertyValues(
                        "nora.stt.provider=google", "nora.stt.google.api-key=test-google-key")
                .run(
                        app -> {
                            assertThat(app).hasSingleBean(RealtimeSttBroker.class);
                            assertThat(app.getBean(RealtimeSttBroker.class))
                                    .isInstanceOf(GoogleRealtimeSessionBroker.class);
                            assertThat(app.getBean(GoogleSttProperties.class).isConfigured())
                                    .isTrue();
                            assertThat(app.getBean(SttProperties.class).openai().isConfigured())
                                    .isFalse();
                        });
    }

    @Test
    void unsupportedProvidersCannotFallBackToAnotherVendorsCredential() {
        context.withPropertyValues("nora.stt.provider=unknown")
                .run(
                        app -> {
                            assertThat(app).hasFailed();
                            assertThat(app.getStartupFailure())
                                    .hasRootCauseInstanceOf(NoSuchBeanDefinitionException.class);
                        });
    }

    @TestConfiguration(proxyBeanMethods = false)
    @EnableConfigurationProperties({SttProperties.class, GoogleSttProperties.class})
    @Import({
        OpenAiRealtimeSessionBroker.class,
        GoogleRealtimeSessionBroker.class,
        SttSessionService.class,
        SttRateLimiter.class
    })
    static class Config {
        @Bean
        ObjectMapper objectMapper() {
            return new ObjectMapper();
        }

        @Bean
        UsageRecorder usageRecorder() {
            return mock(UsageRecorder.class);
        }
    }
}
