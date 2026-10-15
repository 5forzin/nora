"""Start one private Windows presentation agent without a console window."""

import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from ctypes import wintypes
import hashlib
import uuid

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / ".run" / "presentation-control"
RECORD = DATA / "agent-process.private.json"
STOP = DATA / "stop.request"
LOG = DATA / "agent.log"
AGENT = ROOT / "tools" / "presentation-control" / "windows-agent.cjs"


class Windows:
    def __init__(self):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.security = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
        self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID), wintypes.LPVOID]
        self.security.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.LPVOID]
        self.kernel.LocalFree.argtypes = [wintypes.LPVOID]
        self.kernel.LocalFree.restype = wintypes.LPVOID

    def lock(self):
        name = "Local\\NoraPresentationLauncher_" + hashlib.sha256(str(ROOT).casefold().encode()).hexdigest()[:24]
        handle = self.kernel.CreateMutexW(None, False, name)
        if not handle:
            raise OSError("Launcher lock unavailable")
        result = self.kernel.WaitForSingleObject(handle, 0)
        if result in (0, 0x80):
            return handle
        self.kernel.CloseHandle(handle)
        if result != 0x102:
            raise OSError("Launcher lock failed")
        return None

    def private(self, path):
        descriptor = wintypes.LPVOID()
        # Protected ACL: file owner, SYSTEM and Administrators only.
        sddl = "D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;BA)"
        if not self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise OSError("Private file permissions unavailable")
        try:
            if not self.security.SetFileSecurityW(str(path), 0x80000004, descriptor):
                raise OSError("Private file permissions failed")
        finally:
            self.kernel.LocalFree(descriptor)

    def creation_time(self, pid):
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            return None
        handle = self.kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            if ctypes.get_last_error() == 87:
                return None
            raise OSError("Recorded process cannot be verified")
        try:
            exit_code = wintypes.DWORD()
            if not self.kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                raise OSError("Recorded process status unavailable")
            if exit_code.value != 259:
                return None
            created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
            if not self.kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
                raise OSError("Recorded process creation time unavailable")
            return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
        finally:
            self.kernel.CloseHandle(handle)


def write_private(windows, path, value):
    temporary = DATA / (".launcher-" + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            windows.private(temporary)
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def active_record(windows):
    if not RECORD.exists():
        return None
    try:
        value = json.loads(RECORD.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        raise OSError("Recorded agent metadata is unreadable") from None
    if value.get("repoRoot") != str(ROOT) or value.get("mode") not in {"live", "rehearsal"}:
        raise OSError("Recorded agent belongs to another launcher")
    created = windows.creation_time(value.get("pid"))
    return value if created is not None and created == value.get("creationTime") else None


def find_node(config):
    configured = config.get("nodePath")
    candidates = []
    if isinstance(configured, str) and configured:
        configured_path = Path(configured)
        candidates.append(configured_path if configured_path.is_absolute() else ROOT / configured_path)
    found = shutil.which("node")
    if found:
        candidates.append(Path(found))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        packages = Path(local) / "Microsoft" / "WinGet" / "Packages"
        candidates.extend(sorted(packages.glob("OpenJS.NodeJS.LTS_*/node-v*-win-x64/node.exe"), reverse=True))
    for candidate in candidates:
        if candidate.is_file() and candidate.suffix.casefold() == ".exe":
            return candidate.resolve()
    raise OSError("Node.js executable unavailable")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rehearsal", action="store_true")
    parser.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    if os.name != "nt":
        raise OSError("This launcher requires Windows")
    windows = Windows()
    mutex = windows.lock()
    if mutex is None:
        return
    try:
        existing = active_record(windows)
        if args.stop:
            if existing:
                write_private(windows, STOP, {"pid": existing["pid"], "creationTime": existing["creationTime"], "mode": existing["mode"], "requestedAt": time.time()})
            return
        if existing:
            return
        mode = "rehearsal" if args.rehearsal else "live"
        config_path = DATA / (mode + "-agent.private.json")
        config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        if not AGENT.is_file():
            raise OSError("The fixed agent script is unavailable")
        node = find_node(config)
        DATA.mkdir(parents=True, exist_ok=True)
        STOP.unlink(missing_ok=True)
        descriptor = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "ab", buffering=0) as output:
            windows.private(LOG)
            child = subprocess.Popen([str(node), str(AGENT), str(config_path)], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, close_fds=True, creationflags=subprocess.CREATE_NO_WINDOW)
        created = windows.creation_time(child.pid)
        if created is None:
            raise OSError("The agent exited before startup; inspect its private log")
        write_private(windows, RECORD, {"pid": child.pid, "creationTime": created, "mode": mode, "repoRoot": str(ROOT), "startedAt": time.time()})
    finally:
        windows.kernel.ReleaseMutex(mutex)
        windows.kernel.CloseHandle(mutex)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        if os.name == "nt":
            ctypes.windll.user32.MessageBoxW(None, "Não foi possível iniciar ou parar o agente. Confira os arquivos privados do controle e o agent.log.", "Controle da apresentação", 0x10)
