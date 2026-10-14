use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    pub user_id: String,
    pub tenant_id: String,
}

/// Identifies the local queue owner only. The API still verifies the JWT signature and permissions.
pub fn session_identity(jwt: &str) -> Result<SessionIdentity, String> {
    let invalid =
        || "SESSION_UNAVAILABLE: Entre novamente na janela principal do NORA.".to_string();
    let parts: Vec<_> = jwt.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(invalid());
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| invalid())?;
    let claims: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| invalid())?;
    let uuid_claim = |name: &str| -> Result<String, String> {
        let value = claims
            .get(name)
            .and_then(|value| value.as_str())
            .ok_or_else(invalid)?;
        uuid::Uuid::parse_str(value)
            .map(|id| id.to_string())
            .map_err(|_| invalid())
    };
    Ok(SessionIdentity {
        user_id: uuid_claim("sub")?,
        tenant_id: uuid_claim("tenantId")?,
    })
}

pub fn ensure_session_owner(jwt: &str, expected: &SessionIdentity) -> Result<(), String> {
    if session_identity(jwt)? == *expected {
        Ok(())
    } else {
        Err("ACCOUNT_MISMATCH: Entre na conta original para enviar esta reunião.".to_string())
    }
}

/// Reads the session JWT (nora_access cookie) from the main webview (loads nora.systems).
/// The backend accepts this JWT via Bearer (JwtAuthenticationFilter), so it works as a token.
pub fn web_session_jwt(app: &AppHandle) -> Result<String, String> {
    let win = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let url = "https://nora.systems"
        .parse()
        .map_err(|_| "invalid url".to_string())?;
    let cookies = win
        .cookies_for_url(url)
        .map_err(|e| format!("failed to read cookies: {}", e))?;
    cookies
        .iter()
        .find(|c| c.name() == "nora_access")
        .map(|c| c.value().to_string())
        .ok_or_else(|| "Session not found — please log in in the Nora main window.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(user: &str, tenant: &str) -> String {
        let claims =
            serde_json::json!({ "sub": user, "tenantId": tenant, "email": "ignored@example.test" });
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }

    fn owner() -> SessionIdentity {
        SessionIdentity {
            user_id: "11111111-1111-4111-8111-111111111111".into(),
            tenant_id: "22222222-2222-4222-8222-222222222222".into(),
        }
    }

    #[test]
    fn exposes_only_canonical_owner_ids() {
        let expected = owner();
        let identity = session_identity(&token(&expected.user_id, &expected.tenant_id)).unwrap();
        assert_eq!(identity, expected);
        let value = serde_json::to_value(identity).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert!(value.get("userId").is_some());
        assert!(value.get("tenantId").is_some());
    }

    #[test]
    fn refuses_missing_malformed_or_non_uuid_identity() {
        for jwt in [
            "".into(),
            "not-a-jwt".into(),
            "header.!.signature".into(),
            token("alice", &owner().tenant_id),
            token(&owner().user_id, "tenant"),
        ] {
            assert!(session_identity(&jwt)
                .unwrap_err()
                .starts_with("SESSION_UNAVAILABLE"));
        }
    }

    #[test]
    fn requires_both_the_original_user_and_tenant() {
        let expected = owner();
        assert!(
            ensure_session_owner(&token(&expected.user_id, &expected.tenant_id), &expected).is_ok()
        );
        let different = "33333333-3333-4333-8333-333333333333";
        for jwt in [
            token(different, &expected.tenant_id),
            token(&expected.user_id, different),
        ] {
            assert!(ensure_session_owner(&jwt, &expected)
                .unwrap_err()
                .starts_with("ACCOUNT_MISMATCH"));
        }
    }
}
