@echo off
cd /d "%~dp0"
echo Automoney 관리자 서버 + 자동화 스케줄러를 시작합니다...
echo 이 창을 닫으면 자동화가 멈춥니다. 종료하려면 Ctrl+C를 누르세요.
echo.
npm run admin
pause
