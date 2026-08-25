!include "LogicLib.nsh"
!include "FileFunc.nsh"

; Keep the lightweight bootstrap and the complete offline installer on one
; shared install root. This covers users who switch editions during an update.
!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/D=" $R1
  ${If} ${Errors}
    ReadRegStr $R1 HKCU "Software\DeepBlue\DeepSeekHarnessLauncher" "InstallRoot"
    ${If} $R1 != ""
      ${If} ${FileExists} "$R1\*.*"
        StrCpy $INSTDIR $R1
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\DeepBlue\DeepSeekHarnessLauncher" "InstallRoot" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\DeepBlue\DeepSeekHarnessLauncher"
!macroend
