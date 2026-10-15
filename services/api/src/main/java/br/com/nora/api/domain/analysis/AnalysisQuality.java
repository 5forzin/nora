package br.com.nora.api.domain.analysis;

import java.util.Objects;

/** Observable counts, not a transcription accuracy or extraction recall score. */
public record AnalysisQuality(
        String version, Origin origin, TranscriptMetrics transcript, ExtractionMetrics extraction) {
    public AnalysisQuality {
        if (!"1".equals(version)) {
            throw new IllegalArgumentException("Unsupported quality version");
        }
        Objects.requireNonNull(origin);
        Objects.requireNonNull(extraction);
    }

    public enum Origin {
        WORKER,
        LEGACY_DERIVED
    }

    public AnalysisQuality withoutCommercial() {
        if (extraction.commercial() == null) {
            return this;
        }
        return new AnalysisQuality(
                version,
                origin,
                transcript,
                new ExtractionMetrics(
                        extraction.actionItems(),
                        extraction.actionItemsWithAssignee(),
                        extraction.actionItemsWithDueDate(),
                        extraction.risks(),
                        extraction.opportunities(),
                        null));
    }

    private static void nonNegative(Integer value) {
        if (value != null && value < 0) {
            throw new IllegalArgumentException("Quality counts must not be negative");
        }
    }

    public record EvidenceCounts(int total, int withSourceQuote, Integer matchedSourceQuote) {
        public EvidenceCounts {
            nonNegative(total);
            nonNegative(withSourceQuote);
            nonNegative(matchedSourceQuote);
            if (withSourceQuote > total
                    || (matchedSourceQuote != null && matchedSourceQuote > withSourceQuote)) {
                throw new IllegalArgumentException(
                        "Evidence counts exceed their observed denominator");
            }
        }
    }

    public record TranscriptMetrics(
            int characterCount,
            int nonEmptyLineCount,
            Integer speakerLabelCount,
            Integer labeledTurnCount,
            Integer emptyLabeledTurnCount,
            int replacementCharacterCount,
            int controlCharacterCount,
            int duplicateLineCount) {
        public TranscriptMetrics {
            nonNegative(characterCount);
            nonNegative(nonEmptyLineCount);
            nonNegative(speakerLabelCount);
            nonNegative(labeledTurnCount);
            nonNegative(emptyLabeledTurnCount);
            nonNegative(replacementCharacterCount);
            nonNegative(controlCharacterCount);
            nonNegative(duplicateLineCount);
            boolean noLabels = speakerLabelCount == null;
            if (noLabels != (labeledTurnCount == null)
                    || noLabels != (emptyLabeledTurnCount == null)
                    || (!noLabels
                            && (speakerLabelCount > labeledTurnCount
                                    || emptyLabeledTurnCount > labeledTurnCount))) {
                throw new IllegalArgumentException("Speaker-label observations must be consistent");
            }
        }
    }

    public record CommercialMetrics(
            EvidenceCounts products,
            EvidenceCounts personas,
            EvidenceCounts budgets,
            EvidenceCounts sentimentByTopic) {
        public CommercialMetrics {
            Objects.requireNonNull(products);
            Objects.requireNonNull(personas);
            Objects.requireNonNull(budgets);
            Objects.requireNonNull(sentimentByTopic);
        }
    }

    public record ExtractionMetrics(
            EvidenceCounts actionItems,
            int actionItemsWithAssignee,
            int actionItemsWithDueDate,
            EvidenceCounts risks,
            EvidenceCounts opportunities,
            CommercialMetrics commercial) {
        public ExtractionMetrics {
            Objects.requireNonNull(actionItems);
            Objects.requireNonNull(risks);
            Objects.requireNonNull(opportunities);
            nonNegative(actionItemsWithAssignee);
            nonNegative(actionItemsWithDueDate);
            if (actionItemsWithAssignee > actionItems.total()
                    || actionItemsWithDueDate > actionItems.total()) {
                throw new IllegalArgumentException(
                        "Identified fields exceed extracted action items");
            }
        }
    }
}
