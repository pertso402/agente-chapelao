@echo off
chcp 65001 >nul
title Chapelao - Impressao automatica de pedidos
cd /d "%~dp0"

echo.
echo ==========================================
echo   CHAPELAO - IMPRESSAO AUTOMATICA
echo ==========================================
echo.
echo   Deixe esta janela ABERTA e minimizada.
echo   Enquanto ela estiver aberta, todo pedido
echo   novo sai sozinho na impressora.
echo.
echo   Para parar: feche a janela.
echo.
echo ==========================================
echo.

:loop
node index.js
echo.
echo [!] O programa parou. Reiniciando em 10 segundos...
echo     (feche esta janela se quiser parar de vez)
timeout /t 10 /nobreak >nul
goto loop
