package br.com.nora.api.application.customer;

import br.com.nora.api.application.iam.AuthorizationService;
import br.com.nora.api.application.ports.MeetingRepository;
import br.com.nora.api.application.tenant.EnterpriseEntitlementService;
import br.com.nora.api.domain.meeting.Meeting;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CustomerHistoryService {
    private final MeetingRepository meetings;
    private final AuthorizationService authz;
    private final EnterpriseEntitlementService entitlements;

    public CustomerHistoryService(
            MeetingRepository meetings,
            AuthorizationService authz,
            EnterpriseEntitlementService entitlements) {
        this.meetings = meetings;
        this.authz = authz;
        this.entitlements = entitlements;
    }

    @Transactional(readOnly = true)
    public History find(UUID tenantId, UUID userId, String clientCode) {
        entitlements.requireEnterprise(tenantId);
        if (clientCode == null || clientCode.isBlank() || clientCode.trim().length() > 256) {
            throw new IllegalArgumentException("clientCode must have between 1 and 256 characters");
        }
        String code = clientCode.trim();

        String resource = "nora:tenant/" + tenantId + ":meeting/";
        authz.requireAnyAllow(userId, tenantId, "meeting:read", resource + "*");
        List<Meeting> visible =
                authz.filterAllowed(
                        userId,
                        tenantId,
                        "meeting:read",
                        meetings.findByClientCode(tenantId, code),
                        meeting -> resource + meeting.id(),
                        Meeting::attributes);
        return new History(code, visible.stream().limit(200).toList(), visible.size() > 200);
    }

    public record History(String clientCode, List<Meeting> items, boolean truncated) {}
}
