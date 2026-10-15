"""Generate private presentation credentials without putting secrets in arguments."""

import json
import re
import secrets
import sys
from pathlib import Path

from server import hash_password


def main():
    root = Path(__file__).resolve().parents[2]
    private = root / ".run" / "presentation-control"
    private.mkdir(parents=True, exist_ok=True)
    secrets_file = private / "credentials.private.json"
    if secrets_file.exists():
        values = json.loads(secrets_file.read_text(encoding="utf-8"))
    else:
        values = {"username": "apresentador", "password": secrets.token_urlsafe(10), "agentToken": secrets.token_urlsafe(32)}
        secrets_file.write_text(json.dumps(values), encoding="utf-8")
    config = {"username": values["username"], "passwordHash": hash_password(values["password"]), "origin": "https://nora.systems", "sessionTtlSeconds": 14400}
    (private / "server-config.private.json").write_text(json.dumps(config), encoding="utf-8")
    (private / "server.private.env").write_text("AGENT_TOKEN=" + values["agentToken"] + "\n", encoding="utf-8")
    live_access = root.parent / "presentation" / "NORA-diretor-acesso-privado.txt"
    text = live_access.read_text(encoding="utf-8-sig")
    email = re.search(r"E-mail:\s*(\S+)", text)
    password = re.search(r"Senha:\s*(.+)", text)
    if not email or not password:
        raise ValueError("The existing director credential file is incomplete")
    (private / "live-account.private.json").write_text(json.dumps({"email": email[1], "password": password[1].strip()}), encoding="utf-8")
    for mode in ("rehearsal", "live"):
        agent = {
            "controlUrl": "https://nora.systems/presentation-control",
            "agentToken": values["agentToken"],
            "accountFile": str(root / ".run" / "presentation-computer-e2e" / "session.private.json") if mode == "rehearsal" else str(private / "live-account.private.json"),
            "batchFile": str(root / ".run" / "presentation-computer-e2e" / "three-meetings.json") if mode == "rehearsal" else str(root.parent / "presentation" / "NORA-cenario-ao-vivo.json"),
            "profileDir": str(private / (mode + "-browser")),
            "stateFile": str(private / (mode + "-state.private.json")),
            "prepareCompany": True,
            "python": sys.executable,
        }
        (private / (mode + "-agent.private.json")).write_text(json.dumps(agent, indent=2), encoding="utf-8")
    access = root.parent / "presentation" / "NORA-controle-acesso-privado.txt"
    access.write_text("Painel: https://nora.systems/presentation-control/\nUsuário: " + values["username"] + "\nSenha: " + values["password"] + "\n\nParada local: F8 durante uma etapa.\nMantenha o agente e o navegador da apresentação abertos.\n", encoding="utf-8")
    print("Private configuration and access file prepared.")


if __name__ == "__main__":
    main()
