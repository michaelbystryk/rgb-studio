@echo off
rem Builds RGBStudioPlayer.exe and RGBStudio.exe with the C# compiler that ships with Windows (C# 5, nothing to install).
rem Usage: build.cmd [outdir]   (default: this folder). Version.cs holds the shared version info.
setlocal
set "OUT=%~dp0"
if not "%~1"=="" set "OUT=%~f1"
cd /d "%~dp0"
if not exist "%OUT%" mkdir "%OUT%"
if "%OUT:~-1%"=="\" set "OUT=%OUT:~0,-1%"
set CSC="%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
%CSC% /nologo /target:winexe /optimize+ /codepage:65001 /win32manifest:app.manifest /win32icon:..\public\favicon.ico /out:"%OUT%\RGBStudioPlayer.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll Player.cs Version.cs || exit /b 1
%CSC% /nologo /target:winexe /optimize+ /codepage:65001 /win32manifest:app.manifest /win32icon:..\public\favicon.ico /out:"%OUT%\RGBStudio.exe" /r:System.Windows.Forms.dll Launcher.cs Version.cs || exit /b 1
