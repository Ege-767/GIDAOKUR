@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Node.js 24.15 veya daha yeni bir surum kur.
  pause
  exit /b 1
)
echo GIDAOKUR yerel sunucusu baslatiliyor...
echo Tarayicida http://127.0.0.1:3000 adresini ac.
echo Bu pencereyi acik tut. Durdurmak icin Ctrl+C.
node server.js
pause

