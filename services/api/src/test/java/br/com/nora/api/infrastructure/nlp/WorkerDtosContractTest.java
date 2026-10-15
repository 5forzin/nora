package br.com.nora.api.infrastructure.nlp;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Locks the JSON contract sent to the NLP worker. The worker validates with Pydantic {@code
 * extra="forbid"} (services/nlp-worker/src/nora_nlp/models.py) — any key outside the list brings
 * the analysis down with a 422 in production. That is exactly what happened when the API was
 * sending "commercialPlaybook" and "keyFeatures" to a worker that only knows "objectionHandling"
 * and "keyDifferentiators".
 */
class WorkerDtosContractTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Fields accepted by TenantContext in the worker (models.py, camelCase aliases).
    private static final Set<String> WORKER_TENANT_CONTEXT_FIELDS =
            Set.of(
                    "companyName",
                    "industry",
                    "valueProposition",
                    "products",
                    "competitors",
                    "idealCustomerProfile",
                    "objectionHandling",
                    "glossary");

    // Fields accepted by TenantProduct in the worker.
    private static final Set<String> WORKER_PRODUCT_FIELDS =
            Set.of("name", "description", "keyDifferentiators");

    @Test
    void tenantContext_serializesOnlyKeysTheWorkerAccepts() {
        WorkerDtos.TenantContext ctx =
                new WorkerDtos.TenantContext(
                        "Acme",
                        "SaaS",
                        "vendemos",
                        List.of(new WorkerDtos.Product("NORA", "plataforma", List.of("flows"))),
                        List.of("Rival"),
                        "PMEs",
                        List.of("preço alto -> ROI"),
                        List.of(new WorkerDtos.GlossaryEntry("MQL", "lead qualificado")));

        JsonNode json = MAPPER.valueToTree(ctx);

        assertThat(fieldNames(json)).isSubsetOf(WORKER_TENANT_CONTEXT_FIELDS);
        assertThat(json.has("objectionHandling")).isTrue();
        assertThat(fieldNames(json.path("products").get(0))).isSubsetOf(WORKER_PRODUCT_FIELDS);
        assertThat(json.path("products").get(0).has("keyDifferentiators")).isTrue();
    }

    @Test
    void commercialFactsPreserveUnknownsAndFinancialKinds() throws Exception {
        WorkerDtos.AnalyzeResponse response =
                MAPPER.readValue(
                        """
            {"commercialIntelligence": {
              "products":[{"name":"ERP","relationship":"CURRENT","sourceQuote":"We use ERP"}],
              "personas":[{"speaker":null,"role":null,"decisionRole":"UNKNOWN","sourceQuote":"We use ERP"}],
              "budgets":[{"amount":120000,"currency":"BRL","kind":"REVENUE","approval":"UNKNOWN","period":"yearly","sourceQuote":"Revenue is BRL 120000 yearly"}],
              "sentimentByTopic":[{"topic":"Support","sentiment":"NEGATIVE","sourceQuote":"Support is slow"}]
            }}
            """,
                        WorkerDtos.AnalyzeResponse.class);
        assertThat(response.commercialIntelligence().personas().getFirst().role()).isNull();
        assertThat(response.commercialIntelligence().budgets().getFirst().kind().name())
                .isEqualTo("REVENUE");
        assertThat(response.commercialIntelligence().budgets().getFirst().approval().name())
                .isEqualTo("UNKNOWN");
        assertThat(
                        MAPPER.readValue("{}", WorkerDtos.AnalyzeResponse.class)
                                .commercialIntelligence())
                .isNull();
    }

    private static Set<String> fieldNames(JsonNode node) {
        Iterator<String> it = node.fieldNames();
        java.util.HashSet<String> names = new java.util.HashSet<>();
        it.forEachRemaining(names::add);
        return names;
    }
}
