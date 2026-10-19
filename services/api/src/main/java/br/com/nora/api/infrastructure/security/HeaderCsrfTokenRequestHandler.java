package br.com.nora.api.infrastructure.security;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;

/** Form and URL parameters must not substitute for the browser's custom request header. */
final class HeaderCsrfTokenRequestHandler extends CsrfTokenRequestAttributeHandler {
    @Override
    public String resolveCsrfTokenValue(HttpServletRequest request, CsrfToken token) {
        return request.getHeader(token.getHeaderName());
    }
}
