"""Google uses its own credential and preserves structured output and token accounting."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from nora_nlp.clients.llm import LlmClient
from nora_nlp.settings import Settings

GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"


def config(**overrides):
    values = {
        "_env_file": None,
        "llm_provider": "google",
        "llm_base_url": GOOGLE_URL,
        "llm_model": "gemini-3.8-flash",
        "llm_api_key": "test-openai-key",
        "llm_key_google": "test-google-key",
    }
    return Settings(**(values | overrides))


def test_google_never_falls_back_to_openai_key(monkeypatch):
    constructor = MagicMock()
    monkeypatch.setattr("nora_nlp.clients.llm.OpenAI", constructor)
    with pytest.raises(ValueError, match="LLM_KEY_GOOGLE"):
        LlmClient(config(llm_key_google=""))
    constructor.assert_not_called()


@pytest.mark.parametrize(
    "host", ["generativelanguage.googleapis.com", "generativelanguage.googleapis.com."]
)
def test_openai_key_cannot_be_sent_to_google(host, monkeypatch):
    constructor = MagicMock()
    monkeypatch.setattr("nora_nlp.clients.llm.OpenAI", constructor)
    with pytest.raises(ValueError, match="own provider and credential"):
        LlmClient(config(llm_provider="openai", llm_base_url=f"https://{host}/v1beta/openai"))
    constructor.assert_not_called()


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1",
        "http://generativelanguage.googleapis.com/v1beta/openai/",
        GOOGLE_URL + "?key=unexpected",
        GOOGLE_URL + "#unexpected",
    ],
)
def test_google_rejects_another_endpoint_before_using_its_key(url, monkeypatch):
    constructor = MagicMock()
    monkeypatch.setattr("nora_nlp.clients.llm.OpenAI", constructor)
    with pytest.raises(ValueError, match="documented HTTPS"):
        LlmClient(config(llm_base_url=url))
    constructor.assert_not_called()


@pytest.mark.parametrize(
    "model,effort", [("gemini-3.8-flash", "low"), ("gemini-2.5-flash", "none")]
)
def test_google_returns_json_without_an_unsupported_provider_schema(model, effort, monkeypatch):
    transport = MagicMock()
    transport.chat.completions.create.return_value = SimpleNamespace(
        choices=[
            SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content='{"value":1}'))
        ],
        usage=SimpleNamespace(prompt_tokens=120, completion_tokens=35),
    )
    constructor = MagicMock(return_value=transport)
    monkeypatch.setattr("nora_nlp.clients.llm.OpenAI", constructor)
    client = LlmClient(config(llm_model=model))
    result = client.chat_structured(
        system_prompt="Extract using the supplied schema.",
        user_prompt="Value 1",
        json_schema={"type": "object"},
    )
    assert constructor.call_args.kwargs["api_key"] == "test-google-key"
    request = transport.chat.completions.create.call_args.kwargs
    assert request["response_format"] == {"type": "json_object"}
    assert request["reasoning_effort"] == effort
    assert result == ('{"value":1}', 120, 35)


def test_openai_does_not_receive_google_options_or_key(monkeypatch):
    transport = MagicMock()
    transport.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content="{}"))],
        usage=None,
    )
    constructor = MagicMock(return_value=transport)
    monkeypatch.setattr("nora_nlp.clients.llm.OpenAI", constructor)
    client = LlmClient(config(llm_provider="openai", llm_base_url="https://api.openai.com/v1"))
    client.chat_json(system_prompt="Extract.", user_prompt="Value 1")
    assert constructor.call_args.kwargs["api_key"] == "test-openai-key"
    assert "reasoning_effort" not in transport.chat.completions.create.call_args.kwargs
