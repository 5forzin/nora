package br.com.nora.api.application.analysis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import br.com.nora.api.application.customer.CustomerConfidenceService;
import br.com.nora.api.application.embedding.EmbeddingService;
import br.com.nora.api.application.platform.UsageRecorder;
import br.com.nora.api.application.ports.DomainEventPublisher;
import br.com.nora.api.application.ports.EmbeddingClient;
import br.com.nora.api.application.ports.EmbeddingRepository;
import br.com.nora.api.application.ports.MeetingAnalysisRepository;
import br.com.nora.api.application.ports.MeetingGoalRepository;
import br.com.nora.api.application.ports.MeetingRepository;
import br.com.nora.api.application.ports.NlpWorkerClient;
import br.com.nora.api.application.ports.ProductivityAssessmentRepository;
import br.com.nora.api.application.ports.TenantContextRepository;
import br.com.nora.api.application.ports.TenantRlsContext;
import br.com.nora.api.application.ports.TranscriptRepository;
import br.com.nora.api.application.tenant.EnterpriseEntitlementService;
import br.com.nora.api.domain.analysis.MeetingAnalysis;
import br.com.nora.api.domain.analysis.Sentiment;
import br.com.nora.api.domain.meeting.Meeting;
import br.com.nora.api.domain.meeting.ProcessingStatus;
import br.com.nora.api.domain.meeting.Transcript;
import br.com.nora.api.domain.meeting.TranscriptFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

class AnalysisEmbeddingTest {

    @Test
    void indexesFullRedactedSummaryWithoutRawTitleOrTranscript() {
        UUID tenantId = UUID.randomUUID();
        Meeting meeting =
                Meeting.newPending(
                        tenantId,
                        UUID.randomUUID(),
                        "Private title: raw-person@example.com",
                        null,
                        null,
                        "en",
                        TranscriptFormat.TXT,
                        List.of(),
                        List.of());
        Transcript transcript =
                Transcript.create(
                        meeting.id(),
                        tenantId,
                        TranscriptFormat.TXT,
                        "Private transcript: 12345678900");
        String summary =
                "General context. ".repeat(25)
                        + "[PERSON_NAME_1] must resolve the procurement blocker before launch. 🚀";
        MeetingAnalysis analysis =
                MeetingAnalysis.newAnalysis(
                        meeting.id(),
                        tenantId,
                        summary,
                        Sentiment.NEUTRAL,
                        List.of(),
                        List.of(),
                        List.of(),
                        List.of(),
                        List.of(),
                        "test:model",
                        "v1",
                        10,
                        20,
                        1,
                        1);
        MeetingRepository meetings = mock(MeetingRepository.class);
        TranscriptRepository transcripts = mock(TranscriptRepository.class);
        MeetingAnalysisRepository analyses = mock(MeetingAnalysisRepository.class);
        NlpWorkerClient worker = mock(NlpWorkerClient.class);
        EmbeddingClient client = mock(EmbeddingClient.class);
        EmbeddingRepository index = mock(EmbeddingRepository.class);
        UsageRecorder usage = mock(UsageRecorder.class);
        float[] vector = new float[] {1f, 2f};
        when(meetings.findByIdAndTenant(meeting.id(), tenantId)).thenReturn(Optional.of(meeting));
        when(meetings.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        when(transcripts.findByMeetingAndTenant(meeting.id(), tenantId))
                .thenReturn(Optional.of(transcript));
        when(worker.analyze(
                        meeting.id(),
                        tenantId,
                        "en",
                        transcript.rawText(),
                        Optional.empty(),
                        Optional.empty()))
                .thenReturn(NlpWorkerClient.AnalysisResult.of(analysis));
        when(analyses.save(analysis)).thenReturn(analysis);
        when(client.isEnabled()).thenReturn(true);
        when(client.modelId()).thenReturn("test:embedding");
        when(client.embedWithUsage(summary)).thenReturn(new EmbeddingClient.Embedding(vector, 12));
        AnalysisService service =
                new AnalysisService(
                        meetings,
                        transcripts,
                        mock(TenantContextRepository.class),
                        analyses,
                        mock(MeetingGoalRepository.class),
                        mock(ProductivityAssessmentRepository.class),
                        worker,
                        mock(CustomerConfidenceService.class),
                        usage,
                        mock(TenantRlsContext.class),
                        new EmbeddingService(client, index, usage),
                        mock(DomainEventPublisher.class),
                        mock(EnterpriseEntitlementService.class));

        assertThat(service.run(meeting.id(), tenantId)).isSameAs(analysis);

        ArgumentCaptor<String> payload = ArgumentCaptor.forClass(String.class);
        verify(client).embedWithUsage(payload.capture());
        assertThat(payload.getValue())
                .isEqualTo(summary)
                .contains("procurement blocker")
                .doesNotContain(meeting.title(), transcript.rawText());
        verify(index)
                .upsert(
                        meeting.id(),
                        tenantId,
                        "test:embedding",
                        vector,
                        summary.codePointCount(0, summary.length()));
        ArgumentCaptor<Meeting> saved = ArgumentCaptor.forClass(Meeting.class);
        verify(meetings, org.mockito.Mockito.times(2)).save(saved.capture());
        Meeting completed = saved.getAllValues().getLast();
        assertThat(completed.processingStatus()).isEqualTo(ProcessingStatus.COMPLETED);
        assertThat(completed.summarySnippet()).hasSize(240);
    }
}
