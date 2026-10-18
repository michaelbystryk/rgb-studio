@echo off
rem Builds RGBStudioPlayer.exe and RGBStudio.exe with the C# compiler that ships with Windows (C# 5, nothing to install).
setlocal
cd /d "%~dp0"
set CSC="%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
%CSC% /nologo /target:winexe /optimize+ /codepage:65001 /win32manifest:app.manifest /win32icon:..\public\favicon.ico /out:RGBStudioPlayer.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll Player.cs || exit /b 1
%CSC% /nologo /target:winexe /optimize+ /codepage:65001 /win32manifest:app.manifest /win32icon:..\public\favicon.ico /out:RGBStudio.exe /r:System.Windows.Forms.dll Launcher.cs || exit /b 1
