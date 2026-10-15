package br.com.nora.api.application.customer;

import br.com.nora.api.application.iam.AuthorizationService;
import br.com.nora.api.application.meeting.MeetingException;
import br.com.nora.api.application.ports.CustomerAccountRepository;
import br.com.nora.api.application.ports.CustomerConfidenceAssessmentRepository;
import br.com.nora.api.application.ports.MeetingRepository;
import br.com.nora.api.application.ports.NlpWorkerClient.CustomerConfidenceCarrier;
import br.com.nora.api.application.tenant.EnterpriseEntitlementService;
import br.com.nora.api.domain.customer.ConfidenceTrend;
import br.com.nora.api.domain.customer.CustomerAccount;
import br.com.nora.api.domain.customer.CustomerConfidenceAssessment;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Persists the Customer Confidence emitted by the worker (ADR 0015): resolves the customer account
 * by external client code when supplied, otherwise by a detected non-placeholder name. Keeps
 * anonymized clients separate without reconstructing their identities. Trend follows encounter
 * dates, including when historical meetings are analyzed out of order.
 */
@Service
public class CustomerConfidenceService {

    private static final Logger LOG = LoggerFactory.getLogger(CustomerConfidenceService.class);

    /**
     * Trend dead band: score variations within +/- {@value} points are considered stable (STABLE),
     * avoiding noise from small oscillations between meetings.
     */
    private static final int TREND_STABLE_BAND = 5;

    private final CustomerAccountRepository accounts;
    private final CustomerConfidenceAssessmentRepository assessments;
    private final MeetingRepository meetings;
    private final EnterpriseEntitlementService entitlements;
    private final AuthorizationService authz;

    public CustomerConfidenceService(
            CustomerAccountRepository accounts,
            CustomerConfidenceAssessmentRepository assessments,
            MeetingRepository meetings,
            EnterpriseEntitlementService entitlements,
            AuthorizationService authz) {
        this.authz = authz;
        this.accounts = accounts;
        this.assessments = assessments;
        this.meetings = meetings;
        this.entitlements = entitlements;
    }

    /**
     * Replaces the previous assessment, resolving imported anonymous clients by their stable code.
     * Without a code or a meaningful detected account name, no account is created.
     *
     * @return the persisted assessment, or empty when it was a no-op
     */
    @Transactional
    public Optional<CustomerConfidenceAssessment> persist(
            UUID tenantId, UUID meetingId, CustomerConfidenceCarrier carrier) {
        if (!entitlements.isEnterprise(tenantId)) {
            return Optional.empty();
        }

        assessments.deleteByMeetingId(meetingId, tenantId);
        if (carrier == null) {
            return Optional.empty();
        }
        var meeting =
                meetings.findByIdAndTenant(meetingId, tenantId)
                        .orElseThrow(MeetingException.NotFound::new);
        String code = meeting.attributes().get("clientCode");
        if (code != null) {
            code = code.trim();
        }
        String accountName = carrier.accountName() == null ? null : carrier.accountName().trim();
        if ((code == null || code.isBlank())
                && (accountName == null
                        || accountName.isBlank()
                        || accountName.matches(
                                "(?i).*\\[(?:EMPRESA|PESSOA|PERSON_NAME|ORG)(?:[ _]\\d+)?\\].*"))) {
            return Optional.empty();
        }
        CustomerAccount account =
                code != null && !code.isBlank()
                        ? accounts.getOrCreateByExternalCode(tenantId, code)
                        : getOrCreateAccount(tenantId, accountName);
        accounts.linkMeeting(meetingId, account.id(), tenantId);

        ConfidenceTrend trend = computeTrend(tenantId, meetingId, account.id(), carrier.score());

        CustomerConfidenceAssessment assessment =
                CustomerConfidenceAssessment.newAssessment(
                        tenantId,
                        meetingId,
                        account.id(),
                        carrier.score(),
                        carrier.band(),
                        trend,
                        carrier.buyingSignals(),
                        carrier.objections(),
                        carrier.rationale());
        CustomerConfidenceAssessment saved = assessments.save(assessment);
        LOG.info(
                "Customer confidence persisted meetingId={} accountId={} score={} trend={}",
                meetingId,
                account.id(),
                saved.score(),
                saved.trend());
        return Optional.of(saved);
    }

    /** Retrieves the meeting assessments (at most one per account). Scoped by tenant. */
    @Transactional(readOnly = true)
    public List<CustomerConfidenceAssessment> findByMeetingId(UUID meetingId, UUID tenantId) {
        if (!entitlements.isEnterprise(tenantId)) {
            return List.of();
        }
        meetings.findByIdAndTenant(meetingId, tenantId).orElseThrow(MeetingException.NotFound::new);
        return assessments.findByMeetingId(meetingId, tenantId);
    }

    /**
     * Read view for the meeting detail: each assessment already with the account name resolved (the
     * domain aggregate only holds {@code customerAccountId}). Keeps the name resolution in the
     * application layer, leaving the controller thin. Scoped by tenant.
     */
    @Transactional(readOnly = true)
    public List<ConfidenceView> findViewByMeetingId(UUID meetingId, UUID tenantId, UUID userId) {
        if (!entitlements.isEnterprise(tenantId)) {
            return List.of();
        }
        meetings.findByIdAndTenant(meetingId, tenantId).orElseThrow(MeetingException.NotFound::new);
        return assessments.findByMeetingId(meetingId, tenantId).stream()
                .map(
                        a -> {
                            var resolved = accounts.findById(a.customerAccountId(), tenantId);
                            String code =
                                    resolved.map(CustomerAccount::externalClientCode).orElse(null);
                            String name =
                                    code == null
                                            ? resolved.map(CustomerAccount::name).orElse(null)
                                            : "Client " + code;
                            var trend =
                                    computeTrend(
                                            tenantId,
                                            meetingId,
                                            a.customerAccountId(),
                                            a.score(),
                                            userId);
                            var dated =
                                    new CustomerConfidenceAssessment(
                                            a.id(),
                                            a.tenantId(),
                                            a.meetingId(),
                                            a.customerAccountId(),
                                            a.score(),
                                            a.band(),
                                            trend,
                                            a.buyingSignals(),
                                            a.objections(),
                                            a.rationale(),
                                            a.createdAt());
                            return new ConfidenceView(dated, name, code);
                        })
                .toList();
    }

    /** Assessment + resolved account name, for projection in the API. */
    public record ConfidenceView(
            CustomerConfidenceAssessment assessment, String accountName, String clientCode) {
        public ConfidenceView(CustomerConfidenceAssessment assessment, String accountName) {
            this(assessment, accountName, null);
        }
    }

    private CustomerAccount getOrCreateAccount(UUID tenantId, String name) {
        return accounts.findByTenantAndLowerName(tenantId, name)
                .orElseGet(() -> accounts.save(CustomerAccount.create(tenantId, name, null, null)));
    }

    /**
     * Backend-authoritative trend: compares the new score with the one from the last previous
     * meeting of the same account. No history (first meeting of the account) =&gt; null. The
     * worker's guess is ignored.
     */
    private ConfidenceTrend computeTrend(
            UUID tenantId, UUID meetingId, UUID accountId, int newScore) {
        return computeTrend(tenantId, meetingId, accountId, newScore, null);
    }

    private ConfidenceTrend computeTrend(
            UUID tenantId, UUID meetingId, UUID accountId, int newScore, UUID userId) {
        return assessments
                .findLatestByAccountId(accountId, meetingId, tenantId)
                .filter(
                        prior ->
                                userId == null
                                        || meetings.findByIdAndTenant(prior.meetingId(), tenantId)
                                                .map(
                                                        meeting ->
                                                                authz.isAllowed(
                                                                        userId,
                                                                        tenantId,
                                                                        "meeting:read",
                                                                        "nora:tenant/"
                                                                                + tenantId
                                                                                + ":meeting/"
                                                                                + meeting.id(),
                                                                        meeting.attributes()))
                                                .orElse(false))
                .map(
                        prior -> {
                            int delta = newScore - prior.score();
                            if (delta > TREND_STABLE_BAND) {
                                return ConfidenceTrend.IMPROVING;
                            }
                            if (delta < -TREND_STABLE_BAND) {
                                return ConfidenceTrend.DECLINING;
                            }
                            return ConfidenceTrend.STABLE;
                        })
                .orElse(null);
    }
}
