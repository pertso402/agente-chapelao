@echo off
chcp 65001 >nul
title Chapelao - Teste de impressao
cd /d "%~dp0"
node teste-impressora.js
echo.
pause
