package br.com.nora.api.api.controllers;

import br.com.nora.api.api.security.AuthorizationNotRequired;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CsrfController {

    @GetMapping("/auth/csrf")
    @AuthorizationNotRequired(reason = "Public: initializes the browser's CSRF cookie and header.")
    public ResponseEntity<TokenResponse> token(CsrfToken token) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(new TokenResponse(token.getToken(), token.getHeaderName()));
    }

    public record TokenResponse(String token, String headerName) {}
}
