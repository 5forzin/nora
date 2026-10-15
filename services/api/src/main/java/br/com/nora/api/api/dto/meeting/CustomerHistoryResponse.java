package br.com.nora.api.api.dto.meeting;

import br.com.nora.api.domain.analysis.CommercialIntelligence;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** Separate dated encounters of a client code; neither an opportunity funnel nor Account Health. */
public record CustomerHistoryResponse(String clientCode, List<Item> items, boolean truncated) {
    public record Item(
            UUID id,
            String title,
            OffsetDateTime startedAt,
            String processingStatus,
            String summarySnippet,
            CommercialIntelligence commercialIntelligence,
            CustomerConfidenceResponse customerConfidence) {}
}
