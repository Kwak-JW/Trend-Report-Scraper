@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Trend Report Auto-Scraper 실행기

echo ========================================================
echo     Trend Report Auto-Scraper 자동 실행기 (Windows)
echo ========================================================
echo.
echo [1/3] Node.js 엔진 점검 중...
where node >nul 2>nul
if errorlevel 1 goto NoNode
echo - Node.js 엔진 확인 완료.

echo.
echo [2/3] 프로그램 부품(패키지)을 자동 점검 및 설치합니다...
echo (이 과정은 화면에 출력되며 인터넷 속도에 따라 수 분 소요될 수 있습니다)
call npm install

echo.
echo [3/3] 대시보드 서버를 가동합니다.
echo ========================================================
echo       서버가 구동 중일 때는 이 검은 창을 닫지 마세요!
echo           (종료하려면 이 창의 X 버튼을 클릭하세요)
echo ========================================================

:: timeout 대신 안정적인 ping 딜레이 기법을 사용하여 브라우저 자동 오픈 실행
start "" cmd /c "ping 127.0.0.1 -n 4 >nul && start http://localhost:3000"

:: 서버 실행
call npm run dev
exit /b

:NoNode
echo [! 오류 !] 구동 엔진인 Node.js가 설치되어 있지 않습니다.
echo https://nodejs.org 에 접속하여 LTS 버전을 다운로드 및 설치하신 후,
echo 이 파일을 다시 실행해 주세요.
echo.
pause
exit /b
