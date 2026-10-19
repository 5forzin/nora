package br.com.nora.api.infrastructure.security;

import br.com.nora.api.api.security.AuthCookies;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;

/** Cookie credentials need CSRF protection even when an Authorization header is also present. */
final class CookieCsrfProtectionMatcher implements RequestMatcher {

    private final RequestMatcher search =
            PathPatternRequestMatcher.withDefaults().matcher("/meetings/search");

    @Override
    public boolean matches(HttpServletRequest request) {
        boolean billedSearch =
                search.matches(request)
                        && ("GET".equals(request.getMethod())
                                || "HEAD".equals(request.getMethod()));
        if (!CsrfFilter.DEFAULT_CSRF_MATCHER.matches(request) && !billedSearch) {
            return false;
        }
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return false;
        }
        for (Cookie cookie : cookies) {
            if (AuthCookies.ACCESS_COOKIE.equals(cookie.getName())
                    || AuthCookies.REFRESH_COOKIE.equals(cookie.getName())) {
                return true;
            }
        }
        return false;
    }
}
