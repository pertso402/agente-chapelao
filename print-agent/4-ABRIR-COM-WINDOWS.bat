@echo off
chcp 65001 >nul
title Chapelao - Abrir a impressao junto com o Windows
cd /d "%~dp0"

echo.
echo ==========================================
echo   ABRIR SOZINHO COM O WINDOWS
echo ==========================================
echo.
echo   Isto cria um atalho na pasta de inicializacao.
echo   Toda vez que o notebook ligar, a impressao abre
echo   sozinha e ninguem precisa lembrar de nada.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$destino = [Environment]::GetFolderPath('Startup') + '\Chapelao - Impressao.lnk';" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut($destino);" ^
  "$lnk.TargetPath = '%~dp03-INICIAR.bat';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.Description = 'Impressao automatica de pedidos do Chapelao';" ^
  "$lnk.Save();" ^
  "Write-Host '';" ^
  "Write-Host '[OK] Atalho criado em:' -ForegroundColor Green;" ^
  "Write-Host ('     ' + $destino)"

if errorlevel 1 (
  echo.
  echo [X] Nao consegui criar o atalho.
  echo     Da pra fazer na mao: tecla Windows + R, digite  shell:startup
  echo     e arraste o 3-INICIAR.bat pra dentro da pasta segurando ALT.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo   PRONTO
echo ==========================================
echo.
echo   Da proxima vez que ligar o notebook, a janela
echo   da impressao abre sozinha. Nao feche ela.
echo.
echo   Pra desfazer: tecla Windows + R, digite  shell:startup
echo   e apague o atalho "Chapelao - Impressao".
echo.
pause
