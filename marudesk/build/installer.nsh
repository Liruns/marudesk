!include FileFunc.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var MarudeskDesktopShortcutCheckbox
  Var MarudeskDesktopShortcutState

  !macro customInit
    StrCpy $MarudeskDesktopShortcutState ${BST_CHECKED}

    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--no-desktop-shortcut" $R1
    ${IfNot} ${Errors}
      StrCpy $MarudeskDesktopShortcutState ${BST_UNCHECKED}
    ${Else}
      ClearErrors
      ${GetOptions} $R0 "/noDesktopShortcut" $R1
      ${IfNot} ${Errors}
        StrCpy $MarudeskDesktopShortcutState ${BST_UNCHECKED}
      ${EndIf}
    ${EndIf}

    ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcutCreated
    ${If} $R2 == "false"
      StrCpy $MarudeskDesktopShortcutState ${BST_UNCHECKED}
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    Page custom MarudeskDesktopShortcutPage MarudeskDesktopShortcutPageLeave
  !macroend

  Function MarudeskDesktopShortcutPage
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--updated" $R1
    ${IfNot} ${Errors}
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $0

    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 18u "Choose whether marudesk should add a desktop shortcut."
    Pop $0

    ${NSD_CreateCheckbox} 0 28u 100% 12u "Create a desktop shortcut"
    Pop $MarudeskDesktopShortcutCheckbox

    ${if} $MarudeskDesktopShortcutState == ${BST_CHECKED}
      ${NSD_Check} $MarudeskDesktopShortcutCheckbox
    ${else}
      ${NSD_Uncheck} $MarudeskDesktopShortcutCheckbox
    ${endif}

    nsDialogs::Show
  FunctionEnd

  Function MarudeskDesktopShortcutPageLeave
    ${NSD_GetState} $MarudeskDesktopShortcutCheckbox $MarudeskDesktopShortcutState
  FunctionEnd

  !macro customInstall
    StrCpy $R2 "false"

    ${if} $MarudeskDesktopShortcutState == ${BST_CHECKED}
      ${if} $keepShortcuts == "false"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
        StrCpy $R2 "true"
      ${elseif} $oldDesktopLink != $newDesktopLink
      ${andIf} ${FileExists} "$oldDesktopLink"
        Rename $oldDesktopLink $newDesktopLink
        WinShell::UninstShortcut "$oldDesktopLink"
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
        StrCpy $R2 "true"
      ${elseif} ${FileExists} "$newDesktopLink"
        StrCpy $R2 "true"
      ${endIf}

      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endif}

    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcutCreated "$R2"
  !macroend
!endif

!macro customUnInstall
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--keep-shortcuts" $R1

  ${If} ${Errors}
    ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcutCreated

    ${If} $R1 == "true"
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    ${EndIf}
  ${EndIf}
!macroend
