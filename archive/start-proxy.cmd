@echo off
title VRCX-MCP-Proxy
cd /d D:\workspace\vrcx-mcp-actions
if %errorlevel% neq 0 (
    echo [ERROR] 找不到目录 D:\workspace\vrcx-mcp-actions
    pause
    exit /b 1
)

:: 绕过Windows系统代理(7892)，防止 httpx 走代理导致 502 Bad Gateway
set NO_PROXY=127.0.0.1,localhost,*.local

echo [INFO] Starting MCP Actions proxy on port 8799...
echo [INFO] NO_PROXY=%NO_PROXY%
echo [INFO] Log file: proxy.log
echo.
node index.js > proxy.log 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 代理启动失败，错误码: %errorlevel%
    echo [INFO] 请查看 proxy.log
    pause
)
