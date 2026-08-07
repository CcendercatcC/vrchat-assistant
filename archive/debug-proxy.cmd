@echo off
title VRCX-MCP-Proxy-Debug
set NODE=C:\Users\MECHREVO\AppData\Local\hermes\node\node.exe
set WORK=D:\workspace\vrcx-mcp-actions

D:
cd %WORK%

echo Starting MCP Actions proxy...
echo.
echo If you see errors below, send a screenshot.
echo ========================================
"%NODE%" "%WORK%\index.js"
echo.
echo ========================================
echo Proxy exited with code: %errorlevel%
pause
