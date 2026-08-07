@echo off
title MCP-Proxy-Debug
cd /d D:\workspace\vrcx-mcp-actions
echo Starting MCP Actions proxy...
echo.
echo 如果下面出现错误，截图发给 AI
echo ========================================
"C:\Users\MECHREVO\AppData\Local\hermes\node\node.exe" index.js
echo.
echo ========================================
echo 代理已退出，错误码: %errorlevel%
pause
