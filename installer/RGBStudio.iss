; RGB Studio installer (Inno Setup 6). Built by tools/build-release.js:
;   ISCC /DAppVersion=X.Y.Z /DSourceDir=<staging folder> /O<output folder> RGBStudio.iss
; It installs for the current user only, with no admin rights, and adds no startup entry.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\RGB Studio"
#endif

#define AppName "RGB Studio"
#define RepoURL "https://github.com/michaelbystryk/rgb-studio"

[Setup]
AppId={{42586588-53AB-41F0-A1A0-DB55FA4555EB}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Michael Bystryk
AppPublisherURL={#RepoURL}
AppSupportURL={#RepoURL}/issues
AppUpdatesURL={#RepoURL}/releases
VersionInfoVersion={#AppVersion}
PrivilegesRequired=lowest
DefaultDirName={userpf}\RGB Studio
DisableProgramGroupPage=yes
DisableDirPage=auto
SetupIconFile={#SourceDir}\public\favicon.ico
UninstallDisplayIcon={app}\player\RGBStudio.exe
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/ultra
SolidCompression=yes
AppMutex=RGBStudioPlayer
CloseApplications=yes
RestartApplications=no
OutputBaseFilename=RGBStudioSetup-{#AppVersion}
LicenseFile={#SourceDir}\LICENSE
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\RGB Studio"; Filename: "{app}\player\RGBStudio.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\RGB Studio"; Filename: "{app}\player\RGBStudio.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\player\RGBStudio.exe"; Description: "Launch RGB Studio"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
var
  OpenRgbPage: TOutputMsgWizardPage;

// Asks a running editor and player (from this or an older install) to stop. Missing exes are fine.
procedure StopRunningApp;
var
  Exe: String;
  Code: Integer;
begin
  Exe := ExpandConstant('{app}\player\RGBStudio.exe');
  if FileExists(Exe) then
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exe := ExpandConstant('{app}\player\RGBStudioPlayer.exe');
  if FileExists(Exe) then
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function OpenRgbFound: Boolean;
var
  Names: TArrayOfString;
  SubKey, Name: String;
  J, R: Integer;
begin
  Result := FileExists(ExpandConstant('{autopf}\OpenRGB\OpenRGB.exe'))
    or DirExists(ExpandConstant('{commonpf64}\OpenRGB'));
  if Result then Exit;
  // Look through the uninstall list for an entry named OpenRGB.
  for R := 0 to 2 do
  begin
    SetArrayLength(Names, 0);
    case R of
      0: RegGetSubkeyNames(HKLM64, 'Software\Microsoft\Windows\CurrentVersion\Uninstall', Names);
      1: RegGetSubkeyNames(HKLM32, 'Software\Microsoft\Windows\CurrentVersion\Uninstall', Names);
      2: RegGetSubkeyNames(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall', Names);
    end;
    for J := 0 to GetArrayLength(Names) - 1 do
    begin
      SubKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + Names[J];
      Name := '';
      case R of
        0: RegQueryStringValue(HKLM64, SubKey, 'DisplayName', Name);
        1: RegQueryStringValue(HKLM32, SubKey, 'DisplayName', Name);
        2: RegQueryStringValue(HKCU, SubKey, 'DisplayName', Name);
      end;
      if Pos('openrgb', Lowercase(Name)) > 0 then
      begin
        Result := True;
        Exit;
      end;
    end;
  end;
end;

procedure InitializeWizard;
begin
  if not OpenRgbFound then
  begin
    OpenRgbPage := CreateOutputMsgPage(wpInstalling, 'OpenRGB',
      'RGB Studio needs OpenRGB to reach your lights.',
      'OpenRGB was not found on this PC. RGB Studio talks to your lights through it, so you will need to set it up:' + #13#10#13#10 +
      '1. Install PawnIO from https://pawnio.eu' + #13#10 +
      '2. Install OpenRGB (0.9 or newer) from https://openrgb.org/releases.html with the Windows installer (.msi), and keep the option to install it as a background service. The service runs as administrator and listens on port 6742, which is where RGB Studio connects.' + #13#10#13#10 +
      'You can do this now or later. RGB Studio is installed either way.');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningApp;
  Result := '';
end;

function IsPathInApp(const Value: String): Boolean;
var
  AppDir: String;
begin
  AppDir := Lowercase(ExpandConstant('{app}')) + '\';
  Result := (Pos(AppDir, Lowercase(Value)) > 0);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  RunValue: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunningApp;
    // Remove "Start with Windows" only if it points at this install.
    if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'RGB Studio Player', RunValue) then
      if IsPathInApp(RunValue) then
        RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'RGB Studio Player');
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    // Default is No; a silent uninstall keeps your looks.
    if not UninstallSilent then
      if MsgBox('Also delete your saved looks and settings?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(ExpandConstant('{userappdata}\RGB Studio'), True, True, True);
        RegDeleteKeyIncludingSubkeys(HKCU, 'Software\RGB Studio');
      end;
  end;
end;
