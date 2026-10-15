"""Private fixed-script presentation controller. No application or shell execution."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict, deque
from contextlib import contextmanager
from dataclasses import dataclass
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PREFIX = "/presentation-control"
COOKIE = "presentation_control_session"
MAX_BODY = 16_384
ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
TERMINAL = {"completed", "failed", "stopped"}


class ControlError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def decoded(value: str) -> bytes:
    return base64.b64decode(
        value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
    )


def hash_password(password: str, iterations: int = 600_000) -> str:
    """Call with a password read from private stdin, never a command-line argument."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${encoded(salt)}${encoded(digest)}"


def parse_password_hash(value: str) -> tuple:
    fields = value.split("$")
    try:
        if fields[0] == "pbkdf2_sha256" and len(fields) == 4:
            iterations = int(fields[1])
            salt, digest = decoded(fields[2]), decoded(fields[3])
            if (
                100_000 <= iterations <= 2_000_000
                and 16 <= len(salt) <= 64
                and len(digest) == 32
            ):
                return fields[0], iterations, salt, digest
        if fields[0] == "scrypt" and len(fields) == 6:
            n, r, p = map(int, fields[1:4])
            salt, digest = decoded(fields[4]), decoded(fields[5])
            if (
                n in {16384, 32768}
                and r == 8
                and p == 1
                and 16 <= len(salt) <= 64
                and len(digest) == 32
            ):
                return fields[0], n, r, p, salt, digest
    except (ValueError, TypeError):
        pass
    raise ValueError("Invalid configured password hash")


def password_matches(password: str, parsed: tuple) -> bool:
    if parsed[0] == "pbkdf2_sha256":
        _, iterations, salt, expected = parsed
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    else:
        _, n, r, p, salt, expected = parsed
        actual = hashlib.scrypt(
            password.encode(),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=32,
            maxmem=64 * 1024 * 1024,
        )
    return hmac.compare_digest(actual, expected)


@dataclass(frozen=True)
class Config:
    username: str
    password_hash: str
    agent_token: str
    origin: str
    data_dir: Path
    static_dir: Path
    steps: list[dict]
    session_ttl: int = 14_400

    def __post_init__(self):
        if not isinstance(self.username, str) or not 1 <= len(self.username) <= 128:
            raise ValueError("Invalid configured username")
        parse_password_hash(self.password_hash)
        if (
            not isinstance(self.agent_token, str)
            or not 32 <= len(self.agent_token) <= 512
        ):
            raise ValueError(
                "A private agent token of at least 32 characters is required"
            )
        origin = urlsplit(self.origin)
        if (
            origin.scheme != "https"
            or not origin.netloc
            or origin.username
            or origin.password
            or origin.path
            or origin.query
            or origin.fragment
        ):
            raise ValueError("An exact HTTPS browser origin is required")
        if not 60 <= self.session_ttl <= 14_400:
            raise ValueError("Session lifetime must not exceed four hours")
        if not isinstance(self.steps, list) or not 1 <= len(self.steps) <= 100:
            raise ValueError("One fixed script with 1 to 100 steps is required")
        seen = set()
        for step in self.steps:
            if not isinstance(step, dict) or set(step) != {
                "id",
                "title",
                "notes",
                "action",
            }:
                raise ValueError("Invalid fixed step metadata")
            if (
                not isinstance(step["id"], str)
                or not ID.fullmatch(step["id"])
                or step["id"] in seen
            ):
                raise ValueError("Invalid or duplicate step ID")
            for field, limit in (("title", 200), ("notes", 2000), ("action", 128)):
                if (
                    not isinstance(step[field], str)
                    or len(step[field]) > limit
                    or field != "notes"
                    and not step[field]
                ):
                    raise ValueError("Invalid step metadata text")
            seen.add(step["id"])

    @classmethod
    def from_env(cls):
        path = Path(os.environ["CONTROL_CONFIG"]).resolve()
        values = json.loads(path.read_text(encoding="utf-8"))
        script = json.loads(
            Path(os.environ["CONTROL_SCRIPT"]).read_text(encoding="utf-8")
        )
        return cls(
            username=values["username"],
            password_hash=values["passwordHash"],
            agent_token=os.environ["AGENT_TOKEN"],
            origin=values.get("origin", "https://nora.systems"),
            session_ttl=values.get("sessionTtlSeconds", 14_400),
            steps=script["steps"],
            data_dir=Path(
                os.environ.get("CONTROL_DATA_DIR", str(path.parent / "data"))
            ).resolve(),
            static_dir=Path(
                os.environ.get("CONTROL_STATIC_DIR", str(Path(__file__).parent))
            ).resolve(),
        )


class Control:
    def __init__(self, config: Config, clock=time.time):
        self.config = config
        self.clock = clock
        self.password = parse_password_hash(config.password_hash)
        self.lock = threading.RLock()
        self.login_attempts = OrderedDict()
        self.global_attempts = deque()
        config.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt":
            os.chmod(config.data_dir, 0o700)
        database = config.data_dir / "control.sqlite3"
        self.db = sqlite3.connect(
            database, check_same_thread=False, isolation_level=None
        )
        self.db.row_factory = sqlite3.Row
        if os.name != "nt":
            os.chmod(database, 0o600)
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires REAL NOT NULL,created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS commands(
            id TEXT PRIMARY KEY,step_id TEXT NOT NULL,status TEXT NOT NULL,created REAL NOT NULL,
            agent_id TEXT,run_id TEXT,stop_requested INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '');
          CREATE UNIQUE INDEX IF NOT EXISTS one_inflight ON commands((1))
            WHERE status IN ('queued','dispatched','running');
          CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,status INTEGER NOT NULL,response TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS retired_runs(id TEXT PRIMARY KEY);
        """)
        with self.transaction():
            self.set_default("sessionId", str(uuid.uuid4()))
            self.set_default("currentIndex", -1)
            self.set_default("paused", True)
            self.set_default("speed", 1)
            self.set_default(
                "execution", {"status": "idle", "stepId": None, "message": ""}
            )
            self.set_default("agent", {"agentId": None, "runId": None, "lastSeen": 0})
            signature = hashlib.sha256(
                json.dumps(config.steps, sort_keys=True).encode()
            ).hexdigest()
            stored = self.get("scriptHash")
            if stored is not None and stored != signature:
                raise ValueError(
                    "The persisted script differs; use a new private data directory"
                )
            self.set("scriptHash", signature)
            for command in self.db.execute(
                "SELECT * FROM commands WHERE status IN ('dispatched','running')"
            ).fetchall():
                self.db.execute(
                    "UPDATE commands SET stop_requested=1 WHERE id=?", (command["id"],)
                )
                self.set("paused", True)
                self.set(
                    "execution",
                    {
                        "status": "stopping",
                        "stepId": command["step_id"],
                        "message": "Controller restarted; stop must be acknowledged before a manual rerun",
                    },
                )
            agent = self.get("agent")
            agent["lastSeen"] = 0
            self.set("agent", agent)

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def close(self):
        with self.lock:
            self.db.close()

    def get(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def set(self, key, value):
        self.db.execute(
            "INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value))
        )

    def set_default(self, key, value):
        if self.get(key) is None:
            self.set(key, value)

    def login(self, body, address):
        username, password = body.get("username"), body.get("password")
        if (
            not isinstance(username, str)
            or not isinstance(password, str)
            or len(username) > 128
            or len(password) > 1024
        ):
            raise ControlError(400, "INVALID_LOGIN")
        now = self.clock()
        with self.lock:
            while self.global_attempts and self.global_attempts[0] <= now - 60:
                self.global_attempts.popleft()
            attempts = self.login_attempts.setdefault(address, deque())
            self.login_attempts.move_to_end(address)
            while attempts and attempts[0] <= now - 300:
                attempts.popleft()
            if len(attempts) >= 8 or len(self.global_attempts) >= 30:
                raise ControlError(429, "LOGIN_RATE_LIMITED")
            attempts.append(now)
            self.global_attempts.append(now)
            while len(self.login_attempts) > 1024:
                self.login_attempts.popitem(last=False)
        matches = password_matches(password, self.password)
        identity = hmac.compare_digest(username.encode(), self.config.username.encode())
        if not (matches and identity):
            raise ControlError(401, "INVALID_CREDENTIALS")
        token = secrets.token_urlsafe(32)
        with self.transaction():
            self.db.execute("DELETE FROM sessions WHERE expires<=?", (now,))
            self.db.execute(
                "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY created DESC LIMIT -1 OFFSET 19)"
            )
            self.db.execute(
                "INSERT INTO sessions VALUES(?,?,?)",
                (
                    hashlib.sha256(token.encode()).hexdigest(),
                    now + self.config.session_ttl,
                    now,
                ),
            )
        return token

    def authenticate(self, cookie):
        try:
            jar = SimpleCookie()
            jar.load(cookie or "")
            token = jar[COOKIE].value
        except (KeyError, ValueError, CookieError):
            raise ControlError(401, "LOGIN_REQUIRED") from None
        if not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
            raise ControlError(401, "LOGIN_REQUIRED")
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.lock:
            row = self.db.execute(
                "SELECT expires FROM sessions WHERE token_hash=?", (digest,)
            ).fetchone()
            if not row or row[0] <= self.clock():
                raise ControlError(401, "SESSION_EXPIRED")
        return digest

    def logout(self, token_hash):
        with self.transaction():
            self.db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))

    def active(self):
        return self.db.execute(
            "SELECT * FROM commands WHERE status IN ('queued','dispatched','running')"
        ).fetchone()

    def finish(self, command, status, message):
        self.db.execute(
            "UPDATE commands SET status=?,message=?,stop_requested=0 WHERE id=?",
            (status, message, command["id"]),
        )
        self.set(
            "execution",
            {"status": status, "stepId": command["step_id"], "message": message},
        )
        if status in {"failed", "stopped"}:
            self.set("paused", True)

    def state(self):
        with self.lock:
            agent = self.get("agent")
            steps = [dict(value) for value in self.config.steps]
            for step in steps:
                latest = self.db.execute(
                    "SELECT status FROM commands WHERE step_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
                    (step["id"],),
                ).fetchone()
                step["status"] = latest[0] if latest else "pending"
            return {
                "sessionId": self.get("sessionId"),
                "steps": steps,
                "currentIndex": self.get("currentIndex"),
                "agent": {
                    "connected": agent["lastSeen"] > self.clock() - 10,
                    "lastSeen": agent["lastSeen"] or None,
                },
                "execution": self.get("execution"),
                "paused": self.get("paused"),
                "speed": self.get("speed"),
            }

    def set_speed(self, body):
        speed = body.get("speed")
        if (
            set(body) != {"speed"}
            or type(speed) not in (int, float)
            or speed not in {0.5, 1, 1.5, 2}
        ):
            raise ControlError(400, "INVALID_SPEED")
        with self.transaction():
            self.set("speed", speed)
            return {"speed": speed}

    def command(self, body):
        if set(body) - {"action", "stepId", "requestId"}:
            raise ControlError(400, "UNKNOWN_COMMAND_FIELD")
        action, request_id = body.get("action"), body.get("requestId")
        if (
            not isinstance(action, str)
            or action not in {"next", "previous", "stop", "run"}
            or not isinstance(request_id, str)
            or not ID.fullmatch(request_id)
        ):
            raise ControlError(400, "INVALID_COMMAND")
        if action == "run":
            if not isinstance(body.get("stepId"), str) or body["stepId"] not in {
                step["id"] for step in self.config.steps
            }:
                raise ControlError(400, "UNKNOWN_STEP")
        elif "stepId" in body:
            raise ControlError(400, "UNEXPECTED_STEP")
        signature = hashlib.sha256(
            json.dumps(body, sort_keys=True).encode()
        ).hexdigest()
        with self.transaction():
            prior = self.db.execute(
                "SELECT * FROM requests WHERE id=?", (request_id,)
            ).fetchone()
            if prior:
                if not hmac.compare_digest(prior["payload_hash"], signature):
                    raise ControlError(409, "IDEMPOTENCY_CONFLICT")
                return prior["status"], json.loads(prior["response"])
            history_full = (
                self.db.execute("SELECT count(*) FROM requests").fetchone()[0] >= 10_000
            )
            if history_full and action != "stop":
                raise ControlError(429, "CONTROL_HISTORY_LIMIT")
            active = self.active()
            status, response = 202, {"accepted": True, "requestId": request_id}
            if action == "stop":
                self.set("paused", True)
                if active and active["status"] == "queued":
                    self.finish(active, "stopped", "Stopped before dispatch")
                elif active:
                    self.db.execute(
                        "UPDATE commands SET stop_requested=1 WHERE id=?",
                        (active["id"],),
                    )
                    self.set(
                        "execution",
                        {
                            "status": "stopping",
                            "stepId": active["step_id"],
                            "message": "Stop requested",
                        },
                    )
                else:
                    self.set(
                        "execution",
                        {"status": "stopped", "stepId": None, "message": "Stopped"},
                    )
                response.update(
                    commandId=active["id"] if active else None,
                    status="stopping"
                    if active and active["status"] != "queued"
                    else "stopped",
                )
            elif active:
                status, response = 409, {"error": "BUSY"}
            elif self.get("agent")["lastSeen"] <= self.clock() - 10:
                status, response = 409, {"error": "AGENT_OFFLINE"}
            else:
                index = self.get("currentIndex")
                if action == "next":
                    index += 1
                elif action == "previous":
                    index -= 1
                else:
                    index = next(
                        index
                        for index, step in enumerate(self.config.steps)
                        if step["id"] == body["stepId"]
                    )
                if not 0 <= index < len(self.config.steps):
                    status, response = 409, {"error": "SCRIPT_BOUNDARY"}
                else:
                    step_id = self.config.steps[index]["id"]
                    command_id = str(uuid.uuid4())
                    self.db.execute(
                        "INSERT INTO commands(id,step_id,status,created) VALUES(?,?,?,?)",
                        (command_id, step_id, "queued", self.clock()),
                    )
                    self.set("currentIndex", index)
                    self.set("paused", False)
                    self.set(
                        "execution",
                        {"status": "queued", "stepId": step_id, "message": ""},
                    )
                    response.update(
                        commandId=command_id, status="queued", stepId=step_id
                    )
            # Stop is intrinsically repeatable and must remain available even when
            # the bounded request history is full; it never creates an execution.
            if not history_full:
                self.db.execute(
                    "INSERT INTO requests VALUES(?,?,?,?)",
                    (request_id, signature, status, json.dumps(response)),
                )
            return status, response

    def register_agent(self, body):
        agent_id, run_id = body.get("agentId"), body.get("runId")
        if not isinstance(agent_id, str) or not ID.fullmatch(agent_id):
            raise ControlError(400, "INVALID_AGENT_ID")
        current = self.get("agent")
        if not isinstance(run_id, str) or not ID.fullmatch(run_id):
            raise ControlError(400, "AGENT_RUN_ID_REQUIRED")
        identity = agent_id + ":" + run_id
        if self.db.execute(
            "SELECT 1 FROM retired_runs WHERE id=?", (identity,)
        ).fetchone():
            raise ControlError(409, "STALE_AGENT_RUN")
        if (current["agentId"], current["runId"]) != (agent_id, run_id):
            if current["runId"]:
                self.db.execute(
                    "INSERT OR IGNORE INTO retired_runs VALUES(?)",
                    (current["agentId"] + ":" + current["runId"],),
                )
            active = self.active()
            if active and active["status"] != "queued":
                self.finish(
                    active, "failed", "Agent restarted; rerun this step manually"
                )
        self.set(
            "agent", {"agentId": agent_id, "runId": run_id, "lastSeen": self.clock()}
        )
        return agent_id, run_id

    def agent_poll(self, body):
        with self.transaction():
            agent_id, run_id = self.register_agent(body)
            active = self.active()
            if active and active["stop_requested"]:
                return {
                    "command": None,
                    "stopRequested": True,
                    "speed": self.get("speed"),
                }
            command = None
            if active and active["status"] == "queued":
                self.db.execute(
                    "UPDATE commands SET status='dispatched',agent_id=?,run_id=? WHERE id=? AND status='queued'",
                    (agent_id, run_id, active["id"]),
                )
                self.set(
                    "execution",
                    {
                        "status": "dispatched",
                        "stepId": active["step_id"],
                        "message": "",
                    },
                )
                command = {
                    "id": active["id"],
                    "type": "run",
                    "stepId": active["step_id"],
                    "runId": run_id,
                    "speed": self.get("speed"),
                }
            return {
                "command": command,
                "stopRequested": False,
                "speed": self.get("speed"),
            }

    def agent_heartbeat(self, body):
        with self.transaction():
            agent_id, run_id = self.register_agent(body)
            active = self.active()
            reported = body.get("commandId")
            if reported is not None and (
                not active
                or active["id"] != reported
                or (active["agent_id"], active["run_id"]) != (agent_id, run_id)
            ):
                return {"stopRequested": True, "speed": self.get("speed")}
            return {
                "stopRequested": bool(active and active["stop_requested"]),
                "speed": self.get("speed"),
            }

    def agent_result(self, body):
        command_id, status, message = (
            body.get("commandId"),
            body.get("status"),
            body.get("message", ""),
        )
        if (
            not isinstance(command_id, str)
            or not isinstance(status, str)
            or status not in {"running", *TERMINAL}
            or not isinstance(message, str)
            or len(message) > 2000
        ):
            raise ControlError(400, "INVALID_RESULT")
        with self.transaction():
            command = self.db.execute(
                "SELECT * FROM commands WHERE id=?", (command_id,)
            ).fetchone()
            current = self.get("agent")
            if (
                not command
                or (command["agent_id"], command["run_id"])
                != (
                    current["agentId"],
                    current["runId"],
                )
                or body.get("agentId") != current["agentId"]
            ):
                raise ControlError(409, "RESULT_AGENT_MISMATCH")
            if body.get("runId") != command["run_id"]:
                raise ControlError(409, "STALE_AGENT_RUN")
            if command["status"] in TERMINAL:
                if command["status"] == status and command["message"] == message:
                    return {"accepted": True, "stopRequested": False}
                raise ControlError(409, "RESULT_ALREADY_FINAL")
            if command["status"] not in {"dispatched", "running"}:
                raise ControlError(409, "RESULT_NOT_DISPATCHED")
            if status in TERMINAL:
                self.finish(command, status, message)
            else:
                self.db.execute(
                    "UPDATE commands SET status='running',message=? WHERE id=?",
                    (message, command_id),
                )
                self.set(
                    "execution",
                    {
                        "status": "stopping"
                        if command["stop_requested"]
                        else "running",
                        "stepId": command["step_id"],
                        "message": message,
                    },
                )
            return {
                "accepted": True,
                "stopRequested": bool(
                    status == "running" and command["stop_requested"]
                ),
            }


def make_handler(control: Control):
    class Handler(BaseHTTPRequestHandler):
        server_version = "PresentationControl"

        def log_message(self, *_args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def respond(
            self,
            status,
            value,
            cookie=None,
            content_type="application/json; charset=utf-8",
            location=None,
        ):
            raw = (
                value
                if isinstance(value, bytes)
                else json.dumps(value, ensure_ascii=False).encode()
            )
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Robots-Tag", "noindex, nofollow")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            )
            if cookie:
                self.send_header("Set-Cookie", cookie)
            if location:
                self.send_header("Location", location)
            self.end_headers()
            self.wfile.write(raw)

        def csrf(self):
            if (
                self.headers.get("Origin") != control.config.origin
                or self.headers.get("X-Presentation-Control") != "1"
            ):
                raise ControlError(403, "ORIGIN_OR_CONTROL_HEADER_REQUIRED")

        def agent_auth(self):
            expected = ("Bearer " + control.config.agent_token).encode()
            supplied = self.headers.get("Authorization", "").encode()
            if not hmac.compare_digest(expected, supplied):
                raise ControlError(401, "AGENT_AUTH_REQUIRED")

        def body(self):
            if self.headers.get("Transfer-Encoding"):
                raise ControlError(400, "TRANSFER_ENCODING_NOT_ALLOWED")
            raw_length = self.headers.get("Content-Length", "")
            if not re.fullmatch(r"[0-9]{1,6}", raw_length):
                raise ControlError(411, "CONTENT_LENGTH_REQUIRED")
            length = int(raw_length)
            if length > MAX_BODY:
                raise ControlError(413, "BODY_TOO_LARGE")
            if self.headers.get_content_type() != "application/json":
                raise ControlError(415, "JSON_REQUIRED")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ControlError(400, "INCOMPLETE_BODY")
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                raise ControlError(400, "INVALID_JSON") from None
            if not isinstance(value, dict):
                raise ControlError(400, "JSON_OBJECT_REQUIRED")
            return value

        def cookie(self, token, clear=False):
            return f"{COOKIE}={token}; Path={PREFIX}; Max-Age={0 if clear else control.config.session_ttl}; HttpOnly; Secure; SameSite=Strict"

        def do_GET(self):
            try:
                route = urlsplit(self.path).path
                if route == PREFIX + "/health":
                    return self.respond(200, {"status": "ok"})
                if route == PREFIX + "/api/state":
                    control.authenticate(self.headers.get("Cookie"))
                    return self.respond(200, control.state())
                if route == PREFIX:
                    return self.respond(
                        308,
                        b"",
                        content_type="text/plain; charset=utf-8",
                        location=PREFIX + "/",
                    )
                files = {
                    PREFIX + "/": ("index.html", "text/html; charset=utf-8"),
                    PREFIX + "/index.html": ("index.html", "text/html; charset=utf-8"),
                    PREFIX + "/control.js": (
                        "control.js",
                        "text/javascript; charset=utf-8",
                    ),
                    PREFIX + "/control.css": ("control.css", "text/css; charset=utf-8"),
                    PREFIX + "/guide.html": ("guide.html", "text/html; charset=utf-8"),
                }
                if route not in files:
                    raise ControlError(404, "NOT_FOUND")
                if route == PREFIX + "/guide.html":
                    control.authenticate(self.headers.get("Cookie"))
                name, content_type = files[route]
                target = (control.config.static_dir / name).resolve()
                if (
                    target.parent != control.config.static_dir.resolve()
                    or not target.is_file()
                ):
                    raise ControlError(404, "NOT_FOUND")
                return self.respond(200, target.read_bytes(), content_type=content_type)
            except ControlError as error:
                self.respond(error.status, {"error": error.code})
            except Exception:  # noqa: BLE001 - Never expose private configuration in HTTP errors.
                self.respond(500, {"error": "CONTROL_ERROR"})

        def do_POST(self):
            try:
                route = urlsplit(self.path).path
                agent_routes = {
                    PREFIX + "/api/agent/poll": control.agent_poll,
                    PREFIX + "/api/agent/heartbeat": control.agent_heartbeat,
                    PREFIX + "/api/agent/result": control.agent_result,
                }
                if route not in agent_routes and route not in {
                    PREFIX + "/api/login",
                    PREFIX + "/api/logout",
                    PREFIX + "/api/command",
                    PREFIX + "/api/speed",
                }:
                    raise ControlError(404, "NOT_FOUND")
                # Consume the bounded body before rejecting authentication: closing with
                # unread TCP data can reset the connection instead of delivering the 401/403.
                body = self.body()
                if route in agent_routes:
                    self.agent_auth()
                    return self.respond(200, agent_routes[route](body))
                self.csrf()
                if route == PREFIX + "/api/login":
                    token = control.login(body, self.client_address[0])
                    return self.respond(
                        200, {"authenticated": True}, self.cookie(token)
                    )
                session = control.authenticate(self.headers.get("Cookie"))
                if route == PREFIX + "/api/logout":
                    control.logout(session)
                    return self.respond(
                        200, {"authenticated": False}, self.cookie("", clear=True)
                    )
                if route == PREFIX + "/api/speed":
                    return self.respond(200, control.set_speed(body))
                status, result = control.command(body)
                return self.respond(status, result)
            except ControlError as error:
                self.respond(error.status, {"error": error.code})
            except Exception:  # noqa: BLE001 - Never expose private configuration in HTTP errors.
                self.respond(500, {"error": "CONTROL_ERROR"})

    return Handler


def main():
    os.umask(0o077)
    config = Config.from_env()
    host = os.environ.get("CONTROL_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "0.0.0.0"}:
        raise ValueError("Use loopback or an explicit private Docker network binding")
    port = int(os.environ.get("CONTROL_PORT", "17841"))
    control = Control(config)
    server = ThreadingHTTPServer((host, port), make_handler(control))
    server.daemon_threads = True
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        control.close()


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError):
        raise SystemExit("Presentation control configuration failed") from None
