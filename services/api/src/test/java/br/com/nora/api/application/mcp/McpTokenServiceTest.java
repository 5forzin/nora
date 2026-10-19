package br.com.nora.api.application.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import br.com.nora.api.application.ports.McpTokenRepository;
import br.com.nora.api.application.ports.SecureTokenGenerator;
import br.com.nora.api.application.ports.UserRepository;
import br.com.nora.api.domain.identity.Email;
import br.com.nora.api.domain.identity.McpToken;
import br.com.nora.api.domain.identity.User;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;

class McpTokenServiceTest {

    private static final UUID TENANT = UUID.randomUUID();
    private static final UUID USER = UUID.randomUUID();
    private static final UUID TOKEN_ID = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-10-19T12:00:00Z");
    private static final String PRESENTED = "nora_mcp_test-credential";

    private final McpTokenRepository tokens = mock(McpTokenRepository.class);
    private final UserRepository users = mock(UserRepository.class);
    private final SecureTokenGenerator generator = mock(SecureTokenGenerator.class);
    private final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    private final AtomicReference<McpToken> stored = new AtomicReference<>();
    private McpTokenService service;
    private User owner;

    @BeforeEach
    void setUp() {
        stored.set(McpToken.issue(TOKEN_ID, TENANT, USER, "desktop", "hash", NOW, null));
        owner = User.newUnverified(USER, TENANT, Email.of("owner@nora.dev"), "hash", "Owner", NOW);
        owner.markEmailVerified(NOW);
        service = new McpTokenService(tokens, users, generator, () -> NOW, transactions);
        when(transactions.getTransaction(any()))
                .thenAnswer(ignored -> new SimpleTransactionStatus());
        when(generator.hash(PRESENTED)).thenReturn("hash");
        when(tokens.findByTokenHash("hash")).thenAnswer(ignored -> Optional.of(copy(stored.get())));
        when(tokens.findByIdAndOwner(TOKEN_ID, TENANT, USER))
                .thenAnswer(ignored -> Optional.of(copy(stored.get())));
        when(tokens.save(any()))
                .thenAnswer(
                        invocation -> {
                            McpToken token = copy(invocation.getArgument(0));
                            stored.set(token);
                            return copy(token);
                        });
        doAnswer(
                        invocation -> {
                            McpToken current = copy(stored.get());
                            if (current.isActive(NOW)) {
                                current.markUsed(invocation.getArgument(3));
                                stored.set(current);
                            }
                            return null;
                        })
                .when(tokens)
                .updateLastUsedAt(TOKEN_ID, TENANT, USER, NOW);
        when(users.findById(USER)).thenReturn(Optional.of(owner));
    }

    @Test
    void aValidTokenAuthenticatesAndRecordsUsage() {
        assertThat(service.authenticate(PRESENTED))
                .contains(new McpTokenService.ResolvedToken(TENANT, USER, "owner@nora.dev"));
        assertThat(stored.get().lastUsedAt()).isEqualTo(NOW);
        assertThat(stored.get().isRevoked()).isFalse();
        verify(tokens).updateLastUsedAt(TOKEN_ID, TENANT, USER, NOW);
    }

    @Test
    void revocationBetweenResolutionAndUsageStampCannotResurrectTheCredential() {
        when(users.findById(USER))
                .thenAnswer(
                        ignored -> {
                            service.revoke(TOKEN_ID, TENANT, USER);
                            return Optional.of(owner);
                        });

        // The request already resolved the credential; its bookkeeping must not undo the revoke.
        assertThat(service.authenticate(PRESENTED)).isPresent();
        assertThat(stored.get().revokedAt()).isEqualTo(NOW);
        assertThat(stored.get().lastUsedAt()).isNull();
        assertThat(service.authenticate(PRESENTED)).isEmpty();
    }

    @Test
    void anAlreadyRevokedTokenNeverAuthenticates() {
        service.revoke(TOKEN_ID, TENANT, USER);

        assertThat(service.authenticate(PRESENTED)).isEmpty();
        assertThat(stored.get().isRevoked()).isTrue();
    }

    @Test
    void anExpiredTokenNeverAuthenticates() {
        stored.set(
                McpToken.issue(
                        TOKEN_ID, TENANT, USER, "desktop", "hash", NOW.minusSeconds(60), NOW));

        assertThat(service.authenticate(PRESENTED)).isEmpty();
        assertThat(stored.get().lastUsedAt()).isNull();
    }

    @Test
    void aUsageWriteFailureDoesNotRejectAValidCredential() {
        doThrow(new IllegalStateException("usage storage unavailable"))
                .when(tokens)
                .updateLastUsedAt(TOKEN_ID, TENANT, USER, NOW);

        assertThat(service.authenticate(PRESENTED)).isPresent();
        assertThat(stored.get().isRevoked()).isFalse();
    }

    private static McpToken copy(McpToken token) {
        return new McpToken(
                token.id(),
                token.tenantId(),
                token.userId(),
                token.name(),
                token.tokenHash(),
                token.createdAt(),
                token.expiresAt(),
                token.revokedAt(),
                token.lastUsedAt());
    }
}
