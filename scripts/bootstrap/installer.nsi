Unicode true
ManifestDPIAware true
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!include "${RELEASE_INCLUDE}"
!addplugindir "${PLUGIN_ROOT}"

Name "深蓝DeepSeekHarness启动器"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\DeepBlueDeepSeekHarness"
InstallDirRegKey HKCU "Software\DeepBlue\DeepSeekHarnessLauncher" "InstallRoot"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\shells\${SHELL_VERSION}\${SHELL_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "打开深蓝DeepSeekHarness启动器"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var LocalShell
Var QaMode
Var DownloadStatus
Var FinalShell
Var StagingShell

!macro DownloadMirror URL LABEL
  ${If} $DownloadStatus != "OK"
    DetailPrint "正在尝试 ${LABEL}…"
    inetc::get /USERAGENT "DeepBlue-DeepSeek-Harness-Bootstrap/${SHELL_VERSION}" /CONNECTTIMEOUT 8 /RECEIVETIMEOUT 15 "${URL}" "$PLUGINSDIR\launcher-shell.7z" /END
    Pop $DownloadStatus
  ${EndIf}
!macroend

Function .onInit
  ${GetParameters} $0
  ${GetOptions} $0 "/LOCAL_SHELL=" $LocalShell
  StrCpy $QaMode "0"
  ClearErrors
  ${GetOptions} $0 "/QA" $1
  ${IfNot} ${Errors}
    StrCpy $QaMode "1"
  ${EndIf}
FunctionEnd

Section "安装启动器" SEC_MAIN
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=HashVerifier.exe "${HASH_VERIFIER_EXE}"
  File /oname=7za.exe "${SEVEN_ZIP_EXE}"

  ${If} $LocalShell != ""
    DetailPrint "使用本机验收制品"
    CopyFiles /SILENT "$LocalShell" "$PLUGINSDIR\launcher-shell.7z"
    StrCpy $DownloadStatus "OK"
  ${Else}
    StrCpy $DownloadStatus "PENDING"
    DetailPrint "资源 1/1 · 启动器 UI 壳 ${SHELL_VERSION}"
    DetailPrint "正在检测 Gitee 国内镜像；不可用或持续无进度时切换 OSS，最后尝试 GitHub"
    !insertmacro DownloadMirror "${SHELL_URL_GITEE}" "Gitee 国内镜像"
    !insertmacro DownloadMirror "${SHELL_URL_OSS}" "OSS 国内镜像"
    !insertmacro DownloadMirror "${SHELL_URL_GITHUB}" "GitHub Releases"
  ${EndIf}

  ${If} $DownloadStatus != "OK"
    MessageBox MB_ICONSTOP "Gitee、OSS 与 GitHub 三条 UI 壳线路均下载失败（$DownloadStatus）。请检查网络后重试，或使用百度网盘完整离线包。"
    Abort
  ${EndIf}

  DetailPrint "正在校验下载内容…"
  ExecWait '"$PLUGINSDIR\HashVerifier.exe" "$PLUGINSDIR\launcher-shell.7z" "${SHELL_SHA256}" "${SHELL_SIZE}"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "UI 壳完整性校验失败（代码 $0），文件未安装。"
    Abort
  ${EndIf}

  StrCpy $FinalShell "$INSTDIR\shells\${SHELL_VERSION}"
  StrCpy $StagingShell "$INSTDIR\shells\.installing-${SHELL_VERSION}"
  CreateDirectory "$INSTDIR\shells"
  RMDir /r "$StagingShell"
  CreateDirectory "$StagingShell"
  DetailPrint "正在解压启动器 UI 壳…"
  nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x -y -o"$StagingShell" "$PLUGINSDIR\launcher-shell.7z"'
  Pop $0
  ${If} $0 != 0
    RMDir /r "$StagingShell"
    MessageBox MB_ICONSTOP "UI 壳解压失败（代码 $0），旧版本未改动。"
    Abort
  ${EndIf}
  ${IfNot} ${FileExists} "$StagingShell\${SHELL_EXECUTABLE}"
    RMDir /r "$StagingShell"
    MessageBox MB_ICONSTOP "UI 壳缺少启动文件，旧版本未改动。"
    Abort
  ${EndIf}

  ${If} ${FileExists} "$FinalShell\${SHELL_EXECUTABLE}"
    RMDir /r "$INSTDIR\shells\.previous-${SHELL_VERSION}"
    Rename "$FinalShell" "$INSTDIR\shells\.previous-${SHELL_VERSION}"
  ${EndIf}
  Rename "$StagingShell" "$FinalShell"
  ${IfNot} ${FileExists} "$FinalShell\${SHELL_EXECUTABLE}"
    Rename "$INSTDIR\shells\.previous-${SHELL_VERSION}" "$FinalShell"
    MessageBox MB_ICONSTOP "UI 壳切换失败，已恢复旧版本。"
    Abort
  ${EndIf}
  RMDir /r "$INSTDIR\shells\.previous-${SHELL_VERSION}"

  ${If} $QaMode != "1"
    WriteUninstaller "$INSTDIR\卸载深蓝DeepSeekHarness启动器.exe"
    WriteRegStr HKCU "Software\DeepBlue\DeepSeekHarnessLauncher" "InstallRoot" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher" "DisplayName" "深蓝DeepSeekHarness启动器"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher" "DisplayVersion" "${SHELL_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher" "Publisher" "DeepBlue / AI历史书"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher" "UninstallString" '"$INSTDIR\卸载深蓝DeepSeekHarness启动器.exe"'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher" "NoRepair" 1
    CreateDirectory "$SMPROGRAMS\深蓝DeepSeekHarness启动器"
    CreateShortcut "$SMPROGRAMS\深蓝DeepSeekHarness启动器\深蓝DeepSeekHarness启动器.lnk" "$FinalShell\${SHELL_EXECUTABLE}"
    CreateShortcut "$DESKTOP\深蓝DeepSeekHarness启动器.lnk" "$FinalShell\${SHELL_EXECUTABLE}"
  ${EndIf}
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\深蓝DeepSeekHarness启动器.lnk"
  RMDir /r "$SMPROGRAMS\深蓝DeepSeekHarness启动器"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher"
  DeleteRegKey HKCU "Software\DeepBlue\DeepSeekHarnessLauncher"
  RMDir /r "$INSTDIR"
SectionEnd
