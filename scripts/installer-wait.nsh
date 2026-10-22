!ifndef DEEPBLUE_INSTALLER_WAIT_INCLUDED
!define DEEPBLUE_INSTALLER_WAIT_INCLUDED

; Wait without terminating the previous launcher. A failed or cancelled quit
; leaves its installation intact; the user can retry from the verified cache.
!macro WaitForLauncherExit PARAMETERS
  Push $0
  Push $1
  Push $2
  ClearErrors
  ${GetOptions} "${PARAMETERS}" "/WAITPID=" $0
  ${IfNot} ${Errors}
    ${If} $0 != ""
      System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i $0) p .r1'
      System::Call 'kernel32::GetLastError() i .r2'
      ${If} $1 != 0
        System::Call 'kernel32::WaitForSingleObject(p $1, i 60000) i .r2'
        System::Call 'kernel32::CloseHandle(p $1)'
        ${If} $2 != 0
          MessageBox MB_ICONEXCLAMATION|MB_OK "启动器尚未退出，本次未开始安装。请结束任务后重新更新。" /SD IDOK
          Abort
        ${EndIf}
      ${ElseIf} $2 != 87
        ; ERROR_INVALID_PARAMETER means the previous PID has already exited.
        ; Access denied or another failure cannot prove that it is safe to write.
        MessageBox MB_ICONEXCLAMATION|MB_OK "无法确认旧启动器已退出，本次未开始安装。请退出启动器后重试。" /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend
!endif
