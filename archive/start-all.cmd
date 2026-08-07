@echo off
title VRCX-0 + MCP Actions

:: 绕过Windows系统代理(7892)，防止 httpx 走代理导致 502 Bad Gateway
set NO_PROXY=127.0.0.1,localhost,*.local

echo ============================================
echo  VRCX-0 + MCP Actions Launcher
echo  NO_PROXY=%NO_PROXY%
echo ============================================
echo.

:: ===== Step 1: Check if VRCX-0 is already running =====
tasklist /fi "imagename eq vrcx-0.exe" 2>nul | find /i "vrcx-0.exe" >nul
if %errorlevel% equ 0 (
    echo [OK] VRCX-0 is already running.
    set VRCX_STARTED=0
) else (
    echo [STARTING] Launching VRCX-0...
    start "" "D:\app\VRCX-0\vrcx-0.exe"
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to start VRCX-0!
        pause
        exit /b 1
    )
    echo [OK] VRCX-0 launched. Waiting 8 seconds for it to start...
    set VRCX_STARTED=1
    timeout /t 8 /nobreak >nul
)

:: ===== Step 2: Start MCP Actions Proxy =====
echo.
echo [STARTING] MCP Actions proxy on port 8799...
echo.

cd /d D:\workspace\vrcx-mcp-actions
if %errorlevel% neq 0 (
    echo [ERROR] Cannot find D:\workspace\vrcx-mcp-actions
    pause
    exit /b 1
)

echo [INFO] Proxy will forward queries to VRCX-0 ^(port 8798^)
echo [INFO] Custom tools: send_boop, send_invite, request_invite
echo.
echo --- Proxy Log ---
node index.js

echo.
echo [INFO] Proxy exited.
if "%VRCX_STARTED%"=="1" (
    echo [INFO] VRCX-0 was started by this script and will keep running.
)

pause
