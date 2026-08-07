@echo off
REM VRChat 好友监控系统 — 一键启动
REM Node.js + SQLite + WebSocket
cd /d D:\workspace\vrcx-mcp-actions
echo ══════════════════════════════════════════════
echo   VRChat 好友监控系统  
echo   启动中... (端口 8799)
echo ══════════════════════════════════════════════
echo.
node start-monitor.js
pause
