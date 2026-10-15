# Presentation control

A private phone controller and Windows agent for the fixed Web presentation in
[script.json](script.json). It does not automate NORA Desktop or accept remote shell
commands. The agent uses a dedicated Edge profile and moves the real mouse.

## Local setup

Requires Windows, Python, Node.js, Microsoft Edge and the Playwright dependency
installed under `apps/web/node_modules`.

Private configuration lives under `.run/presentation-control/`, outside Git.
`prepare-local.py` creates controller credentials and agent configuration using the
existing private director access note and presentation batch. Review the generated
file paths before starting; this setup is specific to the presentation workstation.
Never publish these files or include credentials in command arguments.

From the repository root:

```powershell
python tools/presentation-control/launch.pyw
python tools/presentation-control/launch.pyw --stop
```

The launcher prevents duplicate agents and records private logs in `agent.log`.
`--rehearsal` selects a separate rehearsal account and browser profile.

Open `/presentation-control/` on the phone and sign in. The controller advances
one step per request. Changing speed affects the next dispatched step. Previous
executes the previous step; selecting a step in the list only displays its notes
until explicitly executed. Read mode does not send commands.

Keep the presentation browser visible and avoid other mouse or keyboard input
while a step runs. Stop from the phone or press F8 locally before taking over.
Stopping does not cancel an analysis or message already accepted by NORA. Failed
or interrupted imports and chat requests require inspection before a retry.
The authenticated guide can be downloaded for manual use without the controller.

## Host deployment

[compose.yml](compose.yml) runs the controller independently on `nora_internal`.
It needs a private directory supplied as `CONTROL_PRIVATE_DIR` containing:

- `server-config.private.json`: `username`, `passwordHash`, HTTPS `origin` and optional `sessionTtlSeconds`.
- `server.private.env`: `AGENT_TOKEN`, shared only with the Windows agent.
- `script.json`: the same fixed script used by the controller.
- `data/`: SQLite storage writable by container UID 65534.

Mount the source read-only, retain private database backups, and route
`/presentation-control` plus `/presentation-control/*` through Caddy to
`nora-presentation-control:17841`. Do not publish the container port directly.
The health endpoint is `/presentation-control/health`.

The controller uses a bounded session cookie, exact-origin write checks, a
single-command queue and request IDs. Restarting an agent or controller does not
replay a dispatched command. These controls do not make this a general remote
administration service.

## Verification

```powershell
python -m unittest discover -s tools/presentation-control -p test_server.py -v
node --test tools/presentation-control/test_agent.cjs
```

The automated tests cover controller authentication, queue transitions, stop,
speed, restart behavior and delayed-action cancellation. A full presentation
still requires an actual Windows/browser rehearsal and review of the AI results.
