@echo off
chcp 65001 >nul
title Chapelao - Instalar agente de impressao
cd /d "%~dp0"

echo.
echo ==========================================
echo   CHAPELAO - INSTALACAO DA IMPRESSAO
echo ==========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [X] O Node.js nao esta instalado neste computador.
  echo.
  echo     Baixe em:  https://nodejs.org
  echo     Escolha a versao "LTS", instale clicando Avancar em tudo,
  echo     reinicie o computador e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

echo [OK] Node.js encontrado.
node --version
echo.

echo [1/3] Baixando o que o programa precisa (demora 1-2 minutos)...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [X] Falhou ao baixar. Confira se o notebook esta na internet.
  pause
  exit /b 1
)

echo.
echo [2/3] Preparando o arquivo de configuracao...
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo      Criado o arquivo .env
) else (
  echo      Ja existia um .env, mantive o seu.
)

echo.
echo [3/3] Procurando as impressoras instaladas...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-Printer | Select-Object -ExpandProperty Name } catch { (Get-WmiObject Win32_Printer).Name }"

echo.
echo ==========================================
echo   FALTA SO UM PASSO
echo ==========================================
echo.
echo   Vou abrir o arquivo de configuracao no Bloco de Notas.
echo.
echo   Ache a linha que comeca com PRINTER_INTERFACE
echo   e deixe ela assim, com o nome da SUA impressora
echo   (copie da lista que apareceu acima):
echo.
echo       PRINTER_INTERFACE=windows:NOME DA IMPRESSORA
echo.
echo   Preencha tambem SUPA_URL e SUPA_SERVICE_KEY.
echo   Depois salve (Ctrl+S) e feche o Bloco de Notas.
echo.
pause

notepad .env

echo.
echo Pronto! Agora rode o arquivo:  2-IMPRIMIR-TESTE.bat
echo.
pause
