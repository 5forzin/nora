package br.com.nora.api.domain.analysis;

import java.math.BigDecimal;
import java.util.List;
import java.util.Objects;

/** Evidence-backed commercial facts; unknown values stay null rather than being inferred. */
public record CommercialIntelligence(
        List<Product> products,
        List<Persona> personas,
        List<Budget> budgets,
        List<TopicSentiment> sentimentByTopic) {
    public CommercialIntelligence {
        products = bounded(products);
        personas = bounded(personas);
        budgets = bounded(budgets);
        sentimentByTopic = bounded(sentimentByTopic);
    }

    private static <T> List<T> bounded(List<T> values) {
        if (values == null) {
            return List.of();
        }
        if (values.size() > 30) {
            throw new IllegalArgumentException("Commercial lists allow at most 30 items");
        }
        return List.copyOf(values);
    }

    private static String required(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Commercial evidence and labels must not be blank");
        }
        return value;
    }

    public enum Relationship {
        CURRENT,
        OPPORTUNITY,
        COMPETITOR,
        MENTIONED
    }

    public enum DecisionRole {
        DECISION_MAKER,
        INFLUENCER,
        USER,
        UNKNOWN
    }

    public enum BudgetKind {
        BUDGET,
        PROPOSAL,
        PRICE,
        REVENUE,
        OTHER
    }

    public enum Approval {
        APPROVED,
        NOT_APPROVED,
        UNKNOWN
    }

    public record Product(String name, Relationship relationship, String sourceQuote) {
        public Product {
            required(name);
            required(sourceQuote);
            Objects.requireNonNull(relationship);
        }
    }

    public record Persona(
            String speaker, String role, DecisionRole decisionRole, String sourceQuote) {
        public Persona {
            required(sourceQuote);
            Objects.requireNonNull(decisionRole);
        }
    }

    public record Budget(
            BigDecimal amount,
            String currency,
            BudgetKind kind,
            Approval approval,
            String period,
            String sourceQuote) {
        public Budget {
            if (amount != null && amount.signum() < 0) {
                throw new IllegalArgumentException("Commercial amount must not be negative");
            }
            required(sourceQuote);
            Objects.requireNonNull(kind);
            Objects.requireNonNull(approval);
        }
    }

    public record TopicSentiment(String topic, Sentiment sentiment, String sourceQuote) {
        public TopicSentiment {
            required(topic);
            required(sourceQuote);
            Objects.requireNonNull(sentiment);
        }
    }
}
