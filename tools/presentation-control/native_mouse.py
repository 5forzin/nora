"""Bounded Windows cursor control for the presentation runner."""

import ctypes
import json
import math
import os
import sys
import threading
import time
from ctypes import wintypes


def curve(start, end, progress):
    eased = progress * progress * (3 - 2 * progress)
    bend = math.sin(math.pi * progress) * min(16, math.dist(start, end) * 0.035)
    return round(start[0] + (end[0] - start[0]) * eased + bend), round(start[1] + (end[1] - start[1]) * eased)


def main():
    if os.name != "nt":
        raise RuntimeError("This runner requires Windows")
    user = ctypes.WinDLL("user32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    try:
        user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except (AttributeError, OSError):
        user.SetProcessDPIAware()
    user.GetForegroundWindow.restype = wintypes.HWND
    user.SetForegroundWindow.argtypes = [wintypes.HWND]
    user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsIconic.argtypes = [wintypes.HWND]
    user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user.WindowFromPoint.argtypes = [wintypes.POINT]
    user.WindowFromPoint.restype = wintypes.HWND
    user.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    user.GetAncestor.restype = wintypes.HWND
    user.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user.GetWindow.restype = wintypes.HWND
    user.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user.GetWindowLongW.restype = wintypes.LONG
    user.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
    user.SendMessageTimeoutW.restype = wintypes.LPARAM
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    stop_event = threading.Event()
    hotkey_ready = threading.Event()
    hotkey_registered = [False]

    def watch_hotkey():
        hotkey_registered[0] = bool(user.RegisterHotKey(None, 1, 0x4000, 0x77))
        hotkey_ready.set()
        if not hotkey_registered[0]:
            return
        message = wintypes.MSG()
        try:
            while user.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                if message.message == 0x0312:
                    stop_event.set()
        finally:
            user.UnregisterHotKey(None, 1)

    threading.Thread(target=watch_hotkey, daemon=True).start()
    hotkey_ready.wait(2)

    def stopped():
        return stop_event.is_set() or bool(user.GetAsyncKeyState(0x77) & 0x8000)

    def windows(pid=None, executable=None, title=None):
        result = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        @callback_type
        def visit(handle, _):
            if not user.IsWindowVisible(handle) and not pid:
                return True
            process_id = wintypes.DWORD()
            user.GetWindowThreadProcessId(handle, ctypes.byref(process_id))
            if pid and process_id.value != pid:
                return True
            if pid and not title and user.GetWindow(handle, 4):
                return True
            caption = ctypes.create_unicode_buffer(1024)
            user.GetWindowTextW(handle, caption, len(caption))
            if not caption.value:
                return True
            if title and caption.value != title:
                return True
            if executable:
                process = kernel.OpenProcess(0x1000, False, process_id.value)
                if not process:
                    return True
                try:
                    name = ctypes.create_unicode_buffer(32768)
                    size = wintypes.DWORD(len(name))
                    if not kernel.QueryFullProcessImageNameW(process, 0, name, ctypes.byref(size)) or os.path.basename(name.value).lower() != executable.lower():
                        return True
                finally:
                    kernel.CloseHandle(process)
            rect = wintypes.RECT()
            user.GetWindowRect(handle, ctypes.byref(rect))
            if rect.right - rect.left > (100 if title else 300) and rect.bottom - rect.top > (30 if title else 200):
                result.append({"handle": int(handle), "pid": process_id.value, "title": caption.value, "rect": {"left": rect.left, "top": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top}})
            return True

        user.EnumWindows(visit, 0)
        return result

    for line in sys.stdin:
        try:
            request = json.loads(line)
            action = request["action"]
            if action == "state":
                point = wintypes.POINT()
                user.GetCursorPos(ctypes.byref(point))
                result = {"x": point.x, "y": point.y, "stopped": stopped(), "hotkeyRegistered": hotkey_registered[0]}
                stop_event.clear()
            elif action == "windows":
                result = windows(request.get("pid"), request.get("executable"), request.get("title"))
            elif action == "focus":
                if stopped():
                    raise RuntimeError("Stopped with F8")
                candidates = windows(request.get("pid"), request.get("executable"), request.get("title"))
                if len(candidates) != 1:
                    raise RuntimeError("The target window is not unique: " + json.dumps(candidates))
                window = candidates[0]
                user.ShowWindow(window["handle"], 9 if user.IsIconic(window["handle"]) else 5)
                user.SetForegroundWindow(window["handle"])
                time.sleep(0.12)
                if int(user.GetForegroundWindow() or 0) != window["handle"]:
                    # A controller click can leave another application in the foreground.
                    # Activate our own browser with a bounded title-bar click instead of
                    # attaching input queues or changing Windows foreground policies.
                    flags = 0x0001 | 0x0002 | 0x0010
                    was_topmost = bool(user.GetWindowLongW(window["handle"], -20) & 0x0008)
                    user.SetWindowPos(window["handle"], wintypes.HWND(-1), 0, 0, 0, 0, flags)
                    try:
                        rect = wintypes.RECT()
                        user.GetWindowRect(window["handle"], ctypes.byref(rect))
                        target = None
                        for offset in (180, 240, 320, 420, 540, 660):
                            candidate = wintypes.POINT(rect.right - offset, max(8, rect.top + 16))
                            hit_result = ctypes.c_size_t()
                            coordinates = (candidate.x & 0xFFFF) | ((candidate.y & 0xFFFF) << 16)
                            answered = user.SendMessageTimeoutW(window["handle"], 0x0084, 0, coordinates, 2, 200, ctypes.byref(hit_result))
                            if answered and hit_result.value == 2:
                                target = candidate
                                break
                        if target is None:
                            raise RuntimeError("The presentation title bar is unavailable")
                        hit = user.WindowFromPoint(target)
                        if not hit or int(user.GetAncestor(hit, 2) or 0) != window["handle"]:
                            raise RuntimeError("The presentation title bar is covered")
                        if stopped():
                            raise RuntimeError("Stopped with F8")
                        point = wintypes.POINT()
                        user.GetCursorPos(ctypes.byref(point))
                        for frame in range(1, 19):
                            if stopped():
                                raise RuntimeError("Stopped with F8")
                            px, py = curve((point.x, point.y), (target.x, target.y), frame / 18)
                            user.SetCursorPos(px, py)
                            time.sleep(0.01)
                        hit = user.WindowFromPoint(target)
                        if not hit or int(user.GetAncestor(hit, 2) or 0) != window["handle"]:
                            raise RuntimeError("The presentation title bar moved")
                        if stopped():
                            raise RuntimeError("Stopped with F8")
                        user.mouse_event(0x0002, 0, 0, 0, 0)
                        user.mouse_event(0x0004, 0, 0, 0, 0)
                        time.sleep(0.12)
                    finally:
                        user.SetWindowPos(window["handle"], wintypes.HWND(-1 if was_topmost else -2), 0, 0, 0, 0, flags)
                    if int(user.GetForegroundWindow() or 0) != window["handle"]:
                        raise RuntimeError("The target window could not be activated")
                result = window
            elif action in ("move", "click", "scroll"):
                pid = request.get("pid")
                if not pid:
                    raise RuntimeError("An explicit target process is required")
                current_pid = wintypes.DWORD()
                user.GetWindowThreadProcessId(user.GetForegroundWindow(), ctypes.byref(current_pid))
                if current_pid.value != pid:
                    raise RuntimeError("The presentation window is not in the foreground")
                if stopped():
                    raise RuntimeError("Stopped with F8")
                x, y = int(request["x"]), int(request["y"])
                if action == "move":
                    point = wintypes.POINT()
                    user.GetCursorPos(ctypes.byref(point))
                    duration = max(0.1, min(1.4, float(request.get("duration", 0.4))))
                    frames = max(8, round(duration * 90))
                    for frame in range(1, frames + 1):
                        if stopped():
                            raise RuntimeError("Stopped with F8")
                        px, py = curve((point.x, point.y), (x, y), frame / frames)
                        user.SetCursorPos(px, py)
                        time.sleep(duration / frames)
                    result = {"x": x, "y": y}
                elif action == "click":
                    user.SetCursorPos(x, y)
                    user.mouse_event(0x0002, 0, 0, 0, 0)
                    user.mouse_event(0x0004, 0, 0, 0, 0)
                    result = {"clicked": True}
                else:
                    user.SetCursorPos(x, y)
                    user.mouse_event(0x0800, 0, 0, int(request.get("delta", -120)), 0)
                    result = {"scrolled": True}
            else:
                raise RuntimeError("Unsupported native action")
            print(json.dumps({"ok": True, "result": result}), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
