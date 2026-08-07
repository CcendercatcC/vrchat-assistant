@echo off
REM VRChat 好友监控系统 — Windows 一键启动脚本
REM 保存为 UTF-8 编码，双击运行

cd /d D:\workspace\vrcx-mcp-actions
echo ══════════════════════════════════════════════
echo   VRChat 好友监控系统  
echo   启动中...
echo ══════════════════════════════════════════════
echo.
node start-monitor.js
pause
