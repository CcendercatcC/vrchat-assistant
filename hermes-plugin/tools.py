"""Agent-facing tools for the vrc-monitor plugin.

Tools:
  vrc_status   — report process liveness + health check
  vrc_start    — spawn the vrc-monitor Node process (idempotent)
  vrc_stop     — terminate the vrc-monitor process (idempotent)
  vrc_restart  — stop + start
"""

from __future__ import annotations

from typing import Any, Dict

from . import process_manager as pm
from tools.registry import tool_error, tool_result

# ── schemas ────────────────────────────────────────────────────────────

VRC_STATUS_SCHEMA: Dict[str, Any] = {
    "name": "vrc_status",
    "description": (
        "Check whether the VRChat friend monitor service is running. "
        "Returns process liveness (pid/alive) and the current health "
        "status from the monitor's /health endpoint, including OTP "
        "authentication state, WebSocket connection status, and the "
        "number of online friends."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

VRC_START_SCHEMA: Dict[str, Any] = {
    "name": "vrc_start",
    "description": (
        "Start the VRChat friend monitor Node.js service as a detached "
        "background process. The service listens on http://127.0.0.1:8799 "
        "and auto-authenticates via OTP. Idempotent — returns current "
        "status without restarting if already running."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

VRC_STOP_SCHEMA: Dict[str, Any] = {
    "name": "vrc_stop",
    "description": (
        "Stop the VRChat friend monitor service. Terminates the Node.js "
        "process and clears tracking state. Idempotent — safe to call "
        "when nothing is running."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

VRC_RESTART_SCHEMA: Dict[str, Any] = {
    "name": "vrc_restart",
    "description": (
        "Restart the VRChat friend monitor service. Equivalent to stop "
        "followed by start."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}


# ── handlers ───────────────────────────────────────────────────────────


def handle_vrc_status(_args: Dict[str, Any], **_kw) -> str:
    """Return the current monitor status as a JSON tool result."""
    try:
        res = pm.status()
        return tool_result(res)
    except Exception as e:
        return tool_error(f"vrc_status failed: {e}")


def handle_vrc_start(_args: Dict[str, Any], **_kw) -> str:
    """Spawn the monitor process and return the outcome."""
    try:
        res = pm.start()
        return tool_result(res)
    except Exception as e:
        return tool_error(f"vrc_start failed: {e}")


def handle_vrc_stop(_args: Dict[str, Any], **_kw) -> str:
    """Stop the monitor process and return the outcome."""
    try:
        res = pm.stop()
        return tool_result(res)
    except Exception as e:
        return tool_error(f"vrc_stop failed: {e}")


def handle_vrc_restart(_args: Dict[str, Any], **_kw) -> str:
    """Restart the monitor process and return the outcome."""
    try:
        res = pm.restart()
        return tool_result(res)
    except Exception as e:
        return tool_error(f"vrc_restart failed: {e}")
