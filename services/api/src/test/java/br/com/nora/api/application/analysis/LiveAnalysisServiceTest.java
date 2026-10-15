package br.com.nora.api.application.analysis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import br.com.nora.api.application.platform.UsageRecorder;
import br.com.nora.api.application.ports.NlpWorkerClient;
import br.com.nora.api.infrastructure.nlp.WorkerDtos;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;

class LiveAnalysisServiceTest {
    @ParameterizedTest
    @ValueSource(ints = {0, 20, 21, 22, 30, 31, 200, 1000})
    void growingHistoryKeepsRecentContextWithoutChangingAccumulatedHighlights(int count) {
        NlpWorkerClient worker = mock(NlpWorkerClient.class);
        var usage = mock(UsageRecorder.class);
        var service = new LiveAnalysisService(worker, usage);
        var items =
                new ArrayList<>(
                        IntStream.range(0, count)
                                .mapToObj(
                                        i ->
                                                new WorkerDtos.LiveHighlightItem(
                                                        "Observation " + i,
                                                        0.8,
                                                        "Synthetic source " + i))
                                .toList());
        var tasks =
                new ArrayList<>(
                        IntStream.range(0, count)
                                .mapToObj(
                                        i ->
                                                new WorkerDtos.LiveTaskItem(
                                                        "Task " + i,
                                                        null,
                                                        "MEDIUM",
                                                        "Synthetic source " + i))
                                .toList());
        var previous = new WorkerDtos.LiveHighlights(items, items, items, tasks);
        var response =
                new WorkerDtos.LiveAnalyzeResponse(
                        List.of(), List.of(), List.of(), List.of(), null);
        when(worker.analyzeLive(any(), any(), any())).thenReturn(response);

        assertThat(
                        service.analyze(
                                UUID.randomUUID(), "Synthetic transcript chunk", "pt-BR", previous))
                .isSameAs(response);

        var context = ArgumentCaptor.forClass(WorkerDtos.LiveHighlights.class);
        verify(worker)
                .analyzeLive(eq("Synthetic transcript chunk"), eq("pt-BR"), context.capture());
        var recent = items.subList(Math.max(0, count - 20), count);
        assertThat(context.getValue().decisions()).containsExactlyElementsOf(recent);
        assertThat(context.getValue().nextSteps()).containsExactlyElementsOf(recent);
        assertThat(context.getValue().observations()).containsExactlyElementsOf(recent);
        assertThat(context.getValue().tasks())
                .containsExactlyElementsOf(tasks.subList(Math.max(0, count - 30), count));
        assertThat(previous.observations()).hasSize(count);
        assertThat(previous.tasks()).hasSize(count);
        items.clear();
        tasks.clear();
        assertThat(context.getValue().observations()).hasSize(Math.min(20, count));
        assertThat(context.getValue().tasks()).hasSize(Math.min(30, count));
    }

    @Test
    void absentHistoryAndMissingCollectionsRemainValid() {
        NlpWorkerClient worker = mock(NlpWorkerClient.class);
        var service = new LiveAnalysisService(worker, mock(UsageRecorder.class));
        when(worker.analyzeLive(any(), any(), any()))
                .thenReturn(
                        new WorkerDtos.LiveAnalyzeResponse(
                                List.of(), List.of(), List.of(), List.of(), null));
        service.analyze(UUID.randomUUID(), "Synthetic transcript chunk", "pt-BR", null);
        verify(worker).analyzeLive("Synthetic transcript chunk", "pt-BR", null);
        service.analyze(
                UUID.randomUUID(),
                "Another synthetic transcript",
                "pt-BR",
                new WorkerDtos.LiveHighlights(null, null, null, null));
        verify(worker)
                .analyzeLive(
                        "Another synthetic transcript",
                        "pt-BR",
                        new WorkerDtos.LiveHighlights(List.of(), List.of(), List.of(), List.of()));
    }
}
