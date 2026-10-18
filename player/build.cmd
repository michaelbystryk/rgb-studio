@echo off
rem Builds RGBStudioPlayer.exe with the C# compiler that ships with Windows (C# 5, nothing to install).
setlocal
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /codepage:65001 /win32manifest:app.manifest /out:RGBStudioPlayer.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll Player.cs
