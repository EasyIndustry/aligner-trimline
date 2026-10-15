; Instalador de aligner-trimline. Lo arma packaging/build_win.sh:
;   makensis -DVERSION=0.1.0 -DCARGA=<carpeta armada> -DSALIDA=<setup.exe> trimline.nsi
Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"

!define NOMBRE "Aligner Trimline"
!define CLAVE_REG "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlignerTrimline"
; el ícono sale de tools/icono.py y viaja con la app
!define MUI_ICON "${CARGA}\app\web\icono.ico"
!define MUI_UNICON "${CARGA}\app\web\icono.ico"

Name "${NOMBRE} ${VERSION}"
OutFile "${SALIDA}"
; por usuario, sin pedir permisos de administrador
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\AlignerTrimline"
; reinstalar va a la misma carpeta que la vez anterior (si se eligió otra)
InstallDirRegKey HKCU "${CLAVE_REG}" "InstallLocation"

!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Abrir ${NOMBRE} ahora"
!define MUI_FINISHPAGE_RUN_FUNCTION Lanzar
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Crear un acceso directo en el escritorio"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION AccesoEscritorio

; si ya está instalado no se pregunta dónde: se actualiza esa carpeta (InstallDirRegKey)
!define MUI_PAGE_CUSTOMFUNCTION_PRE SiYaEstaNoPreguntar
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

Function SiYaEstaNoPreguntar
  ReadRegStr $0 HKCU "${CLAVE_REG}" "InstallLocation"
  StrCmp $0 "" +3
  IfFileExists "$0\app\lanzador.py" 0 +2
  Abort
FunctionEnd

Function Lanzar
  SetOutPath "$INSTDIR"
  Exec '"$INSTDIR\runtime\AlignerTrimline.exe" "$INSTDIR\app\lanzador.py"'
FunctionEnd

Function AccesoEscritorio
  SetOutPath "$INSTDIR"
  CreateShortCut "$DESKTOP\${NOMBRE}.lnk" "$INSTDIR\runtime\AlignerTrimline.exe" '"$INSTDIR\app\lanzador.py"' "$INSTDIR\app\web\icono.ico" 0
FunctionEnd

Section "Programa"
  ; si está abierto no se pueden reemplazar los archivos
  nsExec::Exec 'taskkill /F /IM AlignerTrimline.exe'
  Sleep 1500                      ; que Windows suelte los archivos del proceso cerrado
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  ; lo que pudo dejar una actualización a medias
  RMDir /r "$INSTDIR\app.nueva"
  RMDir /r "$INSTDIR\app.anterior"
  RMDir /r "$INSTDIR\app.cambio"
  RMDir /r "$INSTDIR\app.bajando"
  Delete "$INSTDIR\cambio.py"
  SetOutPath "$INSTDIR"
  File /r "${CARGA}\*.*"

  CreateDirectory "$SMPROGRAMS\${NOMBRE}"
  CreateShortCut "$SMPROGRAMS\${NOMBRE}\${NOMBRE}.lnk" "$INSTDIR\runtime\AlignerTrimline.exe" '"$INSTDIR\app\lanzador.py"' "$INSTDIR\app\web\icono.ico" 0
  CreateShortCut "$SMPROGRAMS\${NOMBRE}\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"

  WriteRegStr HKCU "${CLAVE_REG}" "DisplayName" "${NOMBRE}"
  WriteRegStr HKCU "${CLAVE_REG}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${CLAVE_REG}" "DisplayIcon" "$INSTDIR\app\web\icono.ico"
  WriteRegStr HKCU "${CLAVE_REG}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${CLAVE_REG}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKCU "${CLAVE_REG}" "NoModify" 1
  WriteRegDWORD HKCU "${CLAVE_REG}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM AlignerTrimline.exe'
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\app.anterior"
  RMDir /r "$INSTDIR\app.nueva"
  RMDir /r "$INSTDIR\app.cambio"
  Delete "$INSTDIR\cambio.py"
  Delete "$INSTDIR\app-release.json"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\${NOMBRE}.lnk"
  RMDir /r "$SMPROGRAMS\${NOMBRE}"
  DeleteRegKey HKCU "${CLAVE_REG}"
  ; los registros en %LOCALAPPDATA%\AlignerTrimline no se tocan
SectionEnd
