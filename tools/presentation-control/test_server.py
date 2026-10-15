"""Local HTTP and persistence tests; no desktop, external service or paid provider."""

import http.client
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path

from server import (
    PREFIX,
    Config,
    Control,
    ControlError,
    hash_password,
    make_handler,
)


class ControllerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = hash_password("local-test-password", iterations=100_000)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        (root / "static").mkdir()
        (root / "static" / "index.html").write_text("<h1>Private control</h1>")
        (root / "static" / "control.js").write_text("console.log('control');")
        (root / "static" / "control.css").write_text("body { color: black; }")
        (root / "static" / "guide.html").write_text("<h1>Private rehearsal guide</h1>")
        self.now = [1000.0]
        self.config = Config(
            "operator",
            self.password_hash,
            "local-test-agent-token-" + "a" * 32,
            "https://nora.test",
            root / "data",
            root / "static",
            [
                {
                    "id": "overview",
                    "title": "Overview",
                    "notes": "Fixed step",
                    "action": "open-overview",
                },
                {
                    "id": "meeting",
                    "title": "Meeting",
                    "notes": "",
                    "action": "open-meeting",
                },
            ],
            60,
        )
        self.control = Control(self.config, clock=lambda: self.now[0])
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.control))
        self.server.daemon_threads = True
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        self.thread.start()
        self.cookie = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.control.close()
        self.directory.cleanup()

    def request(
        self,
        method,
        path,
        body=None,
        *,
        csrf=True,
        agent=False,
        cookie=True,
        headers=None,
        raw=None,
    ):
        values = {}
        if csrf:
            values.update(Origin=self.config.origin, **{"X-Presentation-Control": "1"})
        if cookie and self.cookie:
            values["Cookie"] = self.cookie
        if agent:
            values["Authorization"] = "Bearer " + self.config.agent_token
            if isinstance(body, dict):
                body = {"agentId": "windows", "runId": "boot-1", **body}
        data = (
            raw
            if raw is not None
            else json.dumps(body).encode()
            if body is not None
            else None
        )
        if data is not None:
            values["Content-Type"] = "application/json"
        values.update(headers or {})
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=3
        )
        connection.request(method, PREFIX + path, body=data, headers=values)
        response = connection.getresponse()
        text = response.read()
        content_type = response.getheader("Content-Type", "")
        result = (
            json.loads(text) if "application/json" in content_type else text.decode()
        )
        returned_headers = dict(response.getheaders())
        status = response.status
        connection.close()
        return status, result, returned_headers

    def login(self):
        status, result, headers = self.request(
            "POST",
            "/api/login",
            {"username": "operator", "password": "local-test-password"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(result["authenticated"])
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        return headers["Set-Cookie"]

    def poll(self, run="boot-1"):
        return self.request(
            "POST",
            "/api/agent/poll",
            {"agentId": "windows", "runId": run},
            agent=True,
            csrf=False,
            cookie=False,
        )

    def command(self, action="next", request_id="request-1", **fields):
        return self.request(
            "POST",
            "/api/command",
            {"action": action, "requestId": request_id, **fields},
        )

    def test_authentication_cookie_expiration_and_logout(self):
        self.assertEqual(self.request("GET", "/api/state")[0], 401)
        cookie = self.login()
        for flag in (
            "HttpOnly",
            "Secure",
            "SameSite=Strict",
            "Path=/presentation-control",
            "Max-Age=60",
        ):
            self.assertIn(flag, cookie)
        self.assertEqual(self.request("GET", "/api/state")[1]["currentIndex"], -1)
        self.assertNotIn(
            self.cookie.split("=", 1)[1],
            repr(self.control.db.execute("SELECT * FROM sessions").fetchall()),
        )
        self.assertEqual(self.request("POST", "/api/logout", {})[0], 200)
        self.assertEqual(self.request("GET", "/api/state")[0], 401)
        self.login()
        self.now[0] += 61
        self.assertEqual(self.request("GET", "/api/state")[0], 401)

    def test_csrf_and_authentication_scopes(self):
        self.assertEqual(
            self.request(
                "POST",
                "/api/login",
                {"username": "operator", "password": "local-test-password"},
                csrf=False,
            )[0],
            403,
        )
        self.login()
        self.assertEqual(
            self.request(
                "POST",
                "/api/command",
                {"action": "stop", "requestId": "csrf"},
                headers={"Origin": "https://evil.test"},
            )[0],
            403,
        )
        self.assertEqual(
            self.request(
                "POST", "/api/logout", {}, headers={"X-Presentation-Control": "0"}
            )[0],
            403,
        )
        self.assertEqual(
            self.request(
                "POST", "/api/agent/poll", {"agentId": "windows", "runId": "boot-1"}
            )[0],
            401,
        )
        self.assertEqual(
            self.request("GET", "/api/state", cookie=False, agent=True)[0], 401
        )

    def test_login_rate_limit(self):
        for _ in range(8):
            self.assertEqual(
                self.request(
                    "POST", "/api/login", {"username": "operator", "password": "wrong"}
                )[0],
                401,
            )
        self.assertEqual(
            self.request(
                "POST",
                "/api/login",
                {"username": "operator", "password": "local-test-password"},
            )[0],
            429,
        )
        self.now[0] += 301
        self.login()

    def test_command_idempotency_payload_binding_and_busy(self):
        self.login()
        self.assertEqual(self.command()[1]["error"], "AGENT_OFFLINE")
        self.poll()
        status, first, _ = self.command(request_id="accepted-1")
        self.assertEqual(status, 202)
        self.assertEqual(self.command(request_id="accepted-1")[1], first)
        self.assertEqual(self.command("run", "accepted-1", stepId="meeting")[0], 409)
        self.assertEqual(self.command(request_id="busy-1")[1]["error"], "BUSY")
        delivered = self.poll()[1]["command"]
        self.assertEqual(delivered["id"], first["commandId"])
        self.assertEqual(delivered["type"], "run")
        self.assertEqual(delivered["stepId"], "overview")
        self.assertIsNone(self.poll()[1]["command"])
        self.assertEqual(
            self.request(
                "POST",
                "/api/agent/result",
                {
                    "commandId": delivered["id"],
                    "status": "completed",
                    "message": "Done",
                },
                agent=True,
                csrf=False,
            )[0],
            200,
        )
        self.assertEqual(self.command(request_id="busy-1")[1]["error"], "BUSY")
        self.assertEqual(self.command(request_id="next-2")[1]["stepId"], "meeting")

    def test_concurrent_polls_dispatch_only_once(self):
        self.login()
        self.poll()
        self.command()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(
                pool.map(
                    lambda _: self.control.agent_poll(
                        {"agentId": "windows", "runId": "boot-1"}
                    ),
                    range(8),
                )
            )
        self.assertEqual(sum(result["command"] is not None for result in results), 1)

    def test_stop_priority_stays_latched_until_result(self):
        self.login()
        self.poll()
        self.command()
        command = self.poll()[1]["command"]
        self.request(
            "POST",
            "/api/agent/result",
            {"commandId": command["id"], "status": "running", "message": "Running"},
            agent=True,
            csrf=False,
        )
        self.assertEqual(self.command("stop", "stop-1")[0], 202)
        for _ in range(2):
            self.assertEqual(
                self.poll()[1], {"command": None, "stopRequested": True, "speed": 1}
            )
        self.assertTrue(
            self.request(
                "POST",
                "/api/agent/heartbeat",
                {"agentId": "windows", "runId": "boot-1"},
                agent=True,
                csrf=False,
            )[1]["stopRequested"]
        )
        self.assertEqual(
            self.command("run", "too-early", stepId="overview")[1]["error"], "BUSY"
        )
        self.request(
            "POST",
            "/api/agent/result",
            {"commandId": command["id"], "status": "stopped", "message": "Stopped"},
            agent=True,
            csrf=False,
        )
        self.assertFalse(self.poll()[1]["stopRequested"])
        self.assertTrue(self.request("GET", "/api/state")[1]["paused"])
        self.assertEqual(self.command("run", "manual-rerun", stepId="overview")[0], 202)

    def test_stop_cancels_undispatched_command(self):
        self.login()
        self.poll()
        self.command()
        self.command("stop", "stop-queued")
        self.assertIsNone(self.poll()[1]["command"])
        self.assertEqual(
            self.request("GET", "/api/state")[1]["execution"]["status"], "stopped"
        )

    def test_agent_restart_fails_dispatched_command_and_retires_old_boot(self):
        self.login()
        self.poll()
        self.command()
        old = self.poll()[1]["command"]
        self.assertIsNone(self.poll("boot-2")[1]["command"])
        state = self.request("GET", "/api/state")[1]
        self.assertEqual(state["execution"]["status"], "failed")
        self.assertIn("manually", state["execution"]["message"])
        self.assertEqual(self.poll("boot-1")[0], 409)
        self.assertEqual(
            self.request(
                "POST",
                "/api/agent/result",
                {"commandId": old["id"], "status": "completed"},
                agent=True,
                csrf=False,
            )[0],
            409,
        )
        self.command("run", "manual-rerun", stepId="overview")
        self.assertNotEqual(self.poll("boot-2")[1]["command"]["id"], old["id"])

    def test_controller_restart_never_replays_dispatched_command(self):
        self.control.agent_poll({"agentId": "windows", "runId": "boot-1"})
        self.control.command({"action": "next", "requestId": "request-1"})
        old = self.control.agent_poll({"agentId": "windows", "runId": "boot-1"})[
            "command"
        ]
        self.control.close()
        self.control = Control(self.config, clock=lambda: self.now[0])
        self.assertEqual(self.control.state()["execution"]["status"], "stopping")
        self.assertEqual(
            self.control.agent_poll({"agentId": "windows", "runId": "boot-1"}),
            {"command": None, "stopRequested": True, "speed": 1},
        )
        self.assertTrue(
            self.control.agent_heartbeat(
                {"agentId": "windows", "runId": "boot-1", "commandId": old["id"]}
            )["stopRequested"]
        )
        self.assertEqual(
            self.control.command({"action": "next", "requestId": "new-before-stop"})[1][
                "error"
            ],
            "BUSY",
        )
        self.assertEqual(
            self.control.command({"action": "next", "requestId": "request-1"})[1][
                "commandId"
            ],
            old["id"],
        )
        self.control.agent_result(
            {
                "agentId": "windows",
                "runId": "boot-1",
                "commandId": old["id"],
                "status": "stopped",
            }
        )
        self.assertEqual(
            self.control.command(
                {
                    "action": "run",
                    "stepId": "overview",
                    "requestId": "manual-after-stop",
                }
            )[0],
            202,
        )

    def test_heartbeat_requires_boot_and_stops_unknown_command(self):
        with self.assertRaises(ControlError):
            self.control.agent_heartbeat({"agentId": "windows"})
        self.assertTrue(
            self.control.agent_heartbeat(
                {"agentId": "windows", "runId": "boot-1", "commandId": "unknown"}
            )["stopRequested"]
        )
        self.control.command({"action": "next", "requestId": "queued"})
        command = self.control.agent_poll({"agentId": "windows", "runId": "boot-1"})[
            "command"
        ]
        self.assertFalse(
            self.control.agent_heartbeat(
                {"agentId": "windows", "runId": "boot-1", "commandId": command["id"]}
            )["stopRequested"]
        )
        with self.assertRaises(ControlError):
            self.control.agent_result(
                {
                    "agentId": "windows",
                    "commandId": command["id"],
                    "status": "completed",
                }
            )

    def test_stop_remains_available_when_request_history_is_full(self):
        self.control.agent_poll({"agentId": "windows", "runId": "boot-1"})
        self.control.command({"action": "next", "requestId": "first"})
        self.control.agent_poll({"agentId": "windows", "runId": "boot-1"})
        with self.control.transaction():
            self.control.db.executemany(
                "INSERT INTO requests VALUES(?,?,?,?)",
                [(f"history-{index}", "unused", 409, "{}") for index in range(9999)],
            )
        self.assertEqual(
            self.control.command({"action": "stop", "requestId": "emergency"})[0], 202
        )
        self.assertTrue(
            self.control.agent_poll({"agentId": "windows", "runId": "boot-1"})[
                "stopRequested"
            ]
        )
        self.assertEqual(
            self.control.command({"action": "stop", "requestId": "emergency-again"})[0],
            202,
        )
        self.assertEqual(
            self.control.db.execute("SELECT count(*) FROM requests").fetchone()[0],
            10000,
        )

    def test_speed_authentication_validation_and_persistence(self):
        self.assertEqual(self.request("POST", "/api/speed", {"speed": 2})[0], 401)
        self.login()
        self.assertEqual(self.request("GET", "/api/state")[1]["speed"], 1)
        self.assertEqual(
            self.request("POST", "/api/speed", {"speed": 2}, csrf=False)[0], 403
        )
        for body in (
            {},
            {"speed": True},
            {"speed": "2"},
            {"speed": 0},
            {"speed": 3},
            {"speed": 1, "extra": 1},
            {"speed": []},
        ):
            self.assertEqual(self.request("POST", "/api/speed", body)[0], 400)
        for speed in (0.5, 1, 1.5, 2):
            self.assertEqual(
                self.request("POST", "/api/speed", {"speed": speed})[:2],
                (200, {"speed": speed}),
            )
        self.control.close()
        self.control = Control(self.config, clock=lambda: self.now[0])
        self.assertEqual(self.control.state()["speed"], 2)

    def test_speed_change_only_affects_next_dispatched_step(self):
        self.login()
        self.poll()
        self.command(request_id="speed-first")
        first = self.poll()[1]
        self.assertEqual(first["speed"], 1)
        self.assertEqual(first["command"]["speed"], 1)
        self.assertEqual(self.request("POST", "/api/speed", {"speed": 2})[0], 200)
        self.assertEqual(first["command"]["speed"], 1)
        self.assertEqual(
            self.poll()[1], {"command": None, "stopRequested": False, "speed": 2}
        )
        self.request(
            "POST",
            "/api/agent/result",
            {"commandId": first["command"]["id"], "status": "completed"},
            agent=True,
            csrf=False,
        )
        self.command(request_id="speed-next")
        second = self.poll()[1]
        self.assertEqual(second["command"]["speed"], 2)
        self.assertEqual(second["command"]["stepId"], "meeting")

    def test_manual_guide_requires_session_and_disallows_indexing(self):
        status, _, headers = self.request("GET", "/guide.html")
        self.assertEqual(status, 401)
        self.assertEqual(headers["X-Robots-Tag"], "noindex, nofollow")
        self.login()
        status, body, headers = self.request("GET", "/guide.html")
        self.assertEqual(status, 200)
        self.assertEqual(body, "<h1>Private rehearsal guide</h1>")
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        self.assertEqual(headers["X-Robots-Tag"], "noindex, nofollow")

    def test_fixed_script_only_and_bounded_http(self):
        self.login()
        self.poll()
        for body in (
            {"action": "shell", "requestId": "x"},
            {"action": "run", "stepId": "unknown", "requestId": "x"},
            {"action": "run", "stepId": "overview", "requestId": "x", "shell": "cmd"},
            {"action": [], "requestId": "x"},
            {"action": "run", "stepId": [], "requestId": "x"},
        ):
            self.assertEqual(self.request("POST", "/api/command", body)[0], 400)
        self.assertEqual(self.request("POST", "/api/login", raw=b"x" * 16_385)[0], 413)
        self.assertEqual(self.request("POST", "/api/login", raw=b"not-json")[0], 400)
        self.assertEqual(
            self.request("POST", "/api/login", ["not", "an", "object"])[0], 400
        )
        self.assertEqual(self.request("GET", "/health")[0], 200)
        self.assertEqual(self.request("GET", "/")[0], 200)
        bare_status, _, bare_headers = self.request("GET", "")
        self.assertEqual(bare_status, 308)
        self.assertEqual(bare_headers["Location"], PREFIX + "/")
        self.assertEqual(self.request("GET", "/control.js")[0], 200)
        self.assertEqual(self.request("GET", "/control.css")[0], 200)
        self.assertEqual(self.request("GET", "/app.js")[0], 404)
        self.assertEqual(self.request("GET", "/server.py")[0], 404)
        self.assertEqual(self.request("GET", "/../config.json")[0], 404)
        self.assertEqual(self.request("GET", "/%2e%2e/config.json")[0], 404)


if __name__ == "__main__":
    unittest.main()
