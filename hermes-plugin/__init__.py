"""vrc-monitor plugin — manage the VRChat friend monitor Node.js service.

Spawns a detached Node.js subprocess on Windows that listens on
http://127.0.0.1:8799 (MCP + health).  Auto-starts on each Hermes
session via ``on_session_start`` and exposes four manual tools:
vrc_status / vrc_start / vrc_stop / vrc_restart.
"""

from __future__ import annotations

import logging

from . import process_manager as pm
from .tools import (
    VRC_RESTART_SCHEMA,
    VRC_START_SCHEMA,
    VRC_STATUS_SCHEMA,
    VRC_STOP_SCHEMA,
    handle_vrc_restart,
    handle_vrc_start,
    handle_vrc_status,
    handle_vrc_stop,
)

logger = logging.getLogger(__name__)

_TOOLS = (
    ("vrc_status",  VRC_STATUS_SCHEMA,  handle_vrc_status,  "🟢"),
    ("vrc_start",   VRC_START_SCHEMA,   handle_vrc_start,   "▶️"),
    ("vrc_stop",    VRC_STOP_SCHEMA,    handle_vrc_stop,    "⏹️"),
    ("vrc_restart", VRC_RESTART_SCHEMA, handle_vrc_restart, "🔄"),
)


def _on_session_start(**kwargs) -> None:
    """Best-effort auto-launch: probe health, spawn if not running.

    Swallows all exceptions — session start must never be blocked by
    a plugin hook.
    """
    try:
        res = pm.status()
    except Exception as e:
        logger.info("vrc-monitor: pre-start status check failed: %s", e)
        return

    if res.get("running"):
        logger.info("vrc-monitor: already running (pid=%s)", res.get("pid"))
        return

    logger.info("vrc-monitor: not running — attempting auto-start")
    try:
        start_res = pm.start()
        if start_res.get("ok"):
            logger.info(
                "vrc-monitor: auto-started (pid=%s, log=%s)",
                start_res.get("pid"),
                start_res.get("log_file"),
            )
        else:
            logger.info(
                "vrc-monitor: auto-start failed: %s",
                start_res.get("error", "unknown"),
            )
    except Exception as e:
        logger.info("vrc-monitor: auto-start exception: %s", e)


def register(ctx) -> None:
    """Register tools and lifecycle hooks.

    Called once by the plugin loader when the plugin is enabled via
    ``plugins.enabled`` in config.yaml.
    """
    for name, schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=name,
            toolset="vrc_monitor",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )

    ctx.register_hook("on_session_start", _on_session_start)
