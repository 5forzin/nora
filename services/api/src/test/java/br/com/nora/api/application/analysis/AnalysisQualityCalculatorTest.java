package br.com.nora.api.application.analysis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import br.com.nora.api.domain.analysis.ActionItem;
import br.com.nora.api.domain.analysis.AnalysisQuality;
import br.com.nora.api.domain.analysis.AnalysisQuality.CommercialMetrics;
import br.com.nora.api.domain.analysis.AnalysisQuality.EvidenceCounts;
import br.com.nora.api.domain.analysis.AnalysisQuality.ExtractionMetrics;
import br.com.nora.api.domain.analysis.CommercialIntelligence;
import br.com.nora.api.domain.analysis.MeetingAnalysis;
import br.com.nora.api.domain.analysis.Priority;
import br.com.nora.api.domain.analysis.Sentiment;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class AnalysisQualityCalculatorTest {
    @Test
    void javaAndWorkerShareObservableUnicodeLineAndTurnSemantics() throws Exception {
        var mapper = new ObjectMapper();
        var cases =
                mapper.readTree(
                        Path.of(
                                        "../../packages/shared-contracts/analysis-quality-observations-v1.examples.json")
                                .toFile());
        for (var example : cases) {
            var expected =
                    mapper.treeToValue(
                            example.get("expected"), AnalysisQuality.TranscriptMetrics.class);
            assertThat(AnalysisQualityCalculator.transcript(example.get("text").asText()))
                    .as(example.get("name").asText())
                    .isEqualTo(expected);
        }
    }

    @Test
    void legacyCountsKnownFieldsWithoutPretendingToHaveTheHistoricalProtectedSource() {
        var analysis =
                analysis(
                        List.of(
                                ActionItem.fresh(
                                        "Send the proposal",
                                        "Owner",
                                        LocalDate.of(2026, 10, 16),
                                        Priority.HIGH,
                                        "Send the proposal today."),
                                ActionItem.fresh(
                                        "Confirm the schedule",
                                        null,
                                        null,
                                        Priority.LOW,
                                        "Confirm the schedule later.")));
        var quality =
                AnalysisQualityCalculator.legacy(
                        "A stored transcript without numbered speaker labels.", analysis);
        assertThat(quality.origin()).isEqualTo(AnalysisQuality.Origin.LEGACY_DERIVED);
        assertThat(quality.extraction().actionItems()).isEqualTo(new EvidenceCounts(2, 2, null));
        assertThat(quality.extraction().actionItemsWithAssignee()).isEqualTo(1);
        assertThat(quality.extraction().actionItemsWithDueDate()).isEqualTo(1);
        assertThat(quality.transcript().speakerLabelCount()).isNull();
    }

    @Test
    void anUnavailableStoredTranscriptIsUnknownInsteadOfAnEmptyObservedSource() {
        var quality = AnalysisQualityCalculator.legacy(null, analysis(List.of()));
        assertThat(quality.transcript()).isNull();
        assertThat(quality.extraction().actionItems()).isEqualTo(new EvidenceCounts(0, 0, null));
    }

    @Test
    void removingCommercialIntelligenceAlsoMasksItsQualityEvenWhenIntelligenceWasAlreadyNull() {
        var zero = new EvidenceCounts(0, 0, 0);
        var quality =
                new AnalysisQuality(
                        "1",
                        AnalysisQuality.Origin.WORKER,
                        null,
                        new ExtractionMetrics(
                                zero,
                                0,
                                0,
                                zero,
                                zero,
                                new CommercialMetrics(zero, zero, zero, zero)));
        var analysis = analysis(List.of()).withQuality(quality);
        assertThat(analysis.withCommercialIntelligence(null).quality().extraction().commercial())
                .isNull();
        assertThat(analysis.quality().extraction().commercial()).isNotNull();
    }

    @Test
    void aCommercialUpdateDoesNotLoseThePersistedQualitySnapshot() {
        var quality = AnalysisQualityCalculator.legacy("Source.", analysis(List.of()));
        var analysis =
                analysis(List.of())
                        .withQuality(quality)
                        .withCommercialIntelligence(
                                new CommercialIntelligence(
                                        List.of(), List.of(), List.of(), List.of()));
        assertThat(analysis.quality()).isSameAs(quality);
    }

    @Test
    void invalidEvidenceCountsCannotInflateTheirDenominator() {
        assertThatThrownBy(() -> new EvidenceCounts(1, 2, 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new EvidenceCounts(2, 1, 2))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new EvidenceCounts(-1, 0, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private MeetingAnalysis analysis(List<ActionItem> actions) {
        return MeetingAnalysis.newAnalysis(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "Stored summary.",
                Sentiment.NEUTRAL,
                List.of(),
                List.of(),
                actions,
                List.of(),
                List.of(),
                "test",
                "test",
                0,
                0,
                0,
                0);
    }
}
