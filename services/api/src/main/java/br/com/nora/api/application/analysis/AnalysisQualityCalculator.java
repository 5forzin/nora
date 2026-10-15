package br.com.nora.api.application.analysis;

import br.com.nora.api.domain.analysis.AnalysisQuality;
import br.com.nora.api.domain.analysis.AnalysisQuality.CommercialMetrics;
import br.com.nora.api.domain.analysis.AnalysisQuality.EvidenceCounts;
import br.com.nora.api.domain.analysis.AnalysisQuality.ExtractionMetrics;
import br.com.nora.api.domain.analysis.AnalysisQuality.TranscriptMetrics;
import br.com.nora.api.domain.analysis.MeetingAnalysis;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Legacy observations are derived locally; the historical protected source is unavailable. */
public final class AnalysisQualityCalculator {
    private static final Pattern WHITESPACE =
            Pattern.compile("[\\s\\u001c-\\u001f]+", Pattern.UNICODE_CHARACTER_CLASS);
    private static final Pattern LABEL =
            Pattern.compile(
                    "(?<![\\w\\[])(?:\\[((?:LOCUTOR|SPEAKER)[ _]*\\d+)\\]|"
                            + "((?:LOCUTOR|SPEAKER)[ _]*\\d+))\\s*:",
                    Pattern.CASE_INSENSITIVE
                            | Pattern.UNICODE_CASE
                            | Pattern.UNICODE_CHARACTER_CLASS);

    private AnalysisQualityCalculator() {}

    private static String normalize(String text) {
        return WHITESPACE
                .matcher(Normalizer.normalize(text, Normalizer.Form.NFC))
                .replaceAll(" ")
                .trim();
    }

    public static TranscriptMetrics transcript(String text) {
        String[] lines = text.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        Map<String, Integer> frequencies = new HashMap<>();
        Set<String> labels = new HashSet<>();
        List<Boolean> turns = new ArrayList<>();
        int nonEmpty = 0;
        for (String line : lines) {
            String normalized = normalize(line);
            if (!normalized.isEmpty()) {
                nonEmpty++;
                frequencies.merge(normalized, 1, Integer::sum);
            }
        }
        Matcher match = LABEL.matcher(text);
        int previousEnd = -1;
        while (match.find()) {
            if (previousEnd >= 0) {
                turns.set(
                        turns.size() - 1,
                        !normalize(text.substring(previousEnd, match.start())).isEmpty());
            }
            String label = match.group(1) == null ? match.group(2) : match.group(1);
            labels.add(label.replaceAll("[ _]+", "").toUpperCase(Locale.ROOT));
            turns.add(false);
            previousEnd = match.end();
        }
        if (previousEnd >= 0) {
            turns.set(turns.size() - 1, !normalize(text.substring(previousEnd)).isEmpty());
        }
        return new TranscriptMetrics(
                text.codePointCount(0, text.length()),
                nonEmpty,
                turns.isEmpty() ? null : labels.size(),
                turns.isEmpty() ? null : turns.size(),
                turns.isEmpty() ? null : (int) turns.stream().filter(value -> !value).count(),
                (int) text.codePoints().filter(value -> value == 0xfffd).count(),
                (int)
                        text.codePoints()
                                .filter(
                                        value ->
                                                Character.getType(value) == Character.CONTROL
                                                        && value != '\t'
                                                        && value != '\r'
                                                        && value != '\n')
                                .count(),
                frequencies.values().stream().mapToInt(value -> value - 1).sum());
    }

    private static EvidenceCounts evidence(List<String> quotes) {
        return new EvidenceCounts(
                quotes.size(),
                (int)
                        quotes.stream()
                                .filter(value -> value != null && !normalize(value).isEmpty())
                                .count(),
                null);
    }

    public static AnalysisQuality legacy(String rawText, MeetingAnalysis analysis) {
        var commercial = analysis.commercialIntelligence();
        return new AnalysisQuality(
                "1",
                AnalysisQuality.Origin.LEGACY_DERIVED,
                rawText == null ? null : transcript(rawText),
                new ExtractionMetrics(
                        evidence(
                                analysis.actionItems().stream()
                                        .map(item -> item.sourceQuote())
                                        .toList()),
                        (int)
                                analysis.actionItems().stream()
                                        .filter(
                                                item ->
                                                        item.assignee() != null
                                                                && !normalize(item.assignee())
                                                                        .isEmpty())
                                        .count(),
                        (int)
                                analysis.actionItems().stream()
                                        .filter(item -> item.dueDate() != null)
                                        .count(),
                        evidence(
                                analysis.risks().stream().map(item -> item.sourceQuote()).toList()),
                        evidence(
                                analysis.opportunities().stream()
                                        .map(item -> item.sourceQuote())
                                        .toList()),
                        commercial == null
                                ? null
                                : new CommercialMetrics(
                                        evidence(
                                                commercial.products().stream()
                                                        .map(item -> item.sourceQuote())
                                                        .toList()),
                                        evidence(
                                                commercial.personas().stream()
                                                        .map(item -> item.sourceQuote())
                                                        .toList()),
                                        evidence(
                                                commercial.budgets().stream()
                                                        .map(item -> item.sourceQuote())
                                                        .toList()),
                                        evidence(
                                                commercial.sentimentByTopic().stream()
                                                        .map(item -> item.sourceQuote())
                                                        .toList()))));
    }
}
