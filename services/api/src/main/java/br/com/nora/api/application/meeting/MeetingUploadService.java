package br.com.nora.api.application.meeting;

import br.com.nora.api.application.meeting.MeetingService.UploadCommand;
import br.com.nora.api.application.ports.MeetingRepository;
import br.com.nora.api.application.ports.MeetingUploadRepository;
import br.com.nora.api.domain.meeting.Meeting;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectWriter;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Reserves a key and creates its meeting in one transaction, so retries never dispatch twice. */
@Service
public class MeetingUploadService {
    private final MeetingService meetings;
    private final MeetingRepository repository;
    private final MeetingUploadRepository uploads;
    private final ObjectWriter canonicalJson;

    public MeetingUploadService(
            MeetingService meetings,
            MeetingRepository repository,
            MeetingUploadRepository uploads,
            ObjectMapper mapper) {
        this.meetings = meetings;
        this.repository = repository;
        this.uploads = uploads;
        this.canonicalJson = mapper.writer().with(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    }

    @Transactional
    public Meeting upload(UploadCommand command, String key) {
        if (key == null) {
            return meetings.upload(command);
        }
        if (!key.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Idempotency-Key");
        }
        String fingerprint = fingerprint(command);
        if (!uploads.reserve(command.tenantId(), command.ownerUserId(), key, fingerprint)) {
            var existing = uploads.find(command.tenantId(), command.ownerUserId(), key);
            if (!existing.fingerprint().equals(fingerprint)) {
                throw new MeetingException.UploadConflict();
            }
            if (existing.meetingId() == null) {
                throw new MeetingException.UploadRemoved();
            }
            return repository
                    .findByIdAndTenant(existing.meetingId(), command.tenantId())
                    .orElseThrow(MeetingException.UploadRemoved::new);
        }
        Meeting saved = meetings.upload(command);
        uploads.complete(command.tenantId(), command.ownerUserId(), key, saved.id());
        return saved;
    }

    private String fingerprint(UploadCommand command) {
        try {
            byte[] bytes = canonicalJson.writeValueAsBytes(command);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (JsonProcessingException | NoSuchAlgorithmException ex) {
            throw new IllegalStateException("Cannot fingerprint meeting upload", ex);
        }
    }
}
