"""Diálogos nativos que abre el servidor, para lo que el navegador no deja hacer.

Chrome y Edge no dejan elegir con su selector carpetas que consideran del sistema (la del
usuario, el Escritorio, Descargas, algunas unidades de red), y el navegador no dice la ruta de lo
que se elige o se arrastra. Elegir acá y leer o escribir desde el servidor no tiene esas trabas.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

# El selector de Windows (el mismo del Explorador, con barra de direcciones para pegar una ruta):
# IFileOpenDialog (con FOS_PICKFOLDERS para carpetas) o IFileSaveDialog. No hay forma de pedirlos
# desde .NET puro, así que va la interfaz COM declarada en C#.
#
# El servidor corre en segundo plano y Windows no deja que un proceso así tome el foco: el diálogo
# quedaría detrás del navegador. Se cuelga de una ventanita invisible "siempre encima": lo que
# cuelga de una ventana así también queda encima de todo, y se ve. NO se toca la entrada de otros
# procesos (AttachThreadInput): si el diálogo se colgaba enganchado a la barra de tareas, la PC
# quedaba sin poder abrir el menú Inicio ni hacer clic.
# Los datos llegan por variables de entorno (sin problemas de comillas).
_CSHARP = r"""
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class SelectorArchivos {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialog {}

    [ComImport, Guid("C0B4E2F3-BA21-4773-8DBA-335EC946EB8B")]
    class FileSaveDialog {}

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Filtro {
        [MarshalAs(UnmanagedType.LPWStr)] public string Nombre;
        [MarshalAs(UnmanagedType.LPWStr)] public string Patron;
    }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr padre);
        void SetFileTypes(uint cantidad, [MarshalAs(UnmanagedType.LPArray)] Filtro[] filtros);
        void SetFileTypeIndex(uint indice);
        void GetFileTypeIndex();
        void Advise();
        void Unadvise();
        void SetOptions(uint opciones);
        void GetOptions(out uint opciones);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder();
        void GetCurrentSelection();
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string nombre);
        void GetFileName();
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string titulo);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string texto);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string texto);
        void GetResult(out IShellItem item);
        void AddPlace();
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint forma, [MarshalAs(UnmanagedType.LPWStr)] out string nombre);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHCreateItemFromParsingName(string ruta, IntPtr ctx, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
    const uint FOS_OVERWRITEPROMPT = 0x2, FOS_NOCHANGEDIR = 0x8, FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40;
    const uint FOS_PATHMUSTEXIST = 0x800, FOS_FILEMUSTEXIST = 0x1000;
    const uint SIGDN_FILESYSPATH = 0x80058000;

    // modo: "carpeta", "abrir" o "guardar". filtro: "Descripción|*.ext" (solo para archivos).
    public static string Elegir(string modo, string titulo, string inicial, string nombre, string filtro) {
        Form dueno = new Form();
        dueno.TopMost = true;
        dueno.ShowInTaskbar = false;
        dueno.FormBorderStyle = FormBorderStyle.None;
        dueno.StartPosition = FormStartPosition.CenterScreen;
        dueno.Size = new System.Drawing.Size(1, 1);
        dueno.Opacity = 0;
        dueno.Show();
        dueno.Activate();                                   // si Windows lo deja; si no, igual queda encima
        try {
            bool guardar = modo == "guardar";
            IFileDialog d = guardar ? (IFileDialog)new FileSaveDialog() : (IFileDialog)new FileOpenDialog();
            uint opciones;
            d.GetOptions(out opciones);
            opciones |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR;
            if (modo == "carpeta") opciones |= FOS_PICKFOLDERS;
            else if (guardar) opciones |= FOS_OVERWRITEPROMPT;
            else opciones |= FOS_FILEMUSTEXIST;
            d.SetOptions(opciones);
            if (!string.IsNullOrEmpty(titulo)) d.SetTitle(titulo);
            if (modo == "carpeta") d.SetOkButtonLabel("Elegir carpeta");
            if (modo != "carpeta" && !string.IsNullOrEmpty(filtro) && filtro.Contains("|")) {
                string[] partes = filtro.Split('|');
                Filtro f = new Filtro();
                f.Nombre = partes[0];
                f.Patron = partes[1];
                d.SetFileTypes(1, new Filtro[] { f });
                d.SetFileTypeIndex(1);
                if (guardar) d.SetDefaultExtension(partes[1].Replace("*.", ""));
            }
            if (!string.IsNullOrEmpty(nombre)) d.SetFileName(nombre);
            if (!string.IsNullOrEmpty(inicial) && System.IO.Directory.Exists(inicial)) {
                IShellItem carpeta;
                if (SHCreateItemFromParsingName(inicial, IntPtr.Zero, typeof(IShellItem).GUID, out carpeta) == 0) d.SetFolder(carpeta);
            }
            if (d.Show(dueno.Handle) != 0) return null;          // cancelado
            IShellItem item;
            d.GetResult(out item);
            string ruta;
            item.GetDisplayName(SIGDN_FILESYSPATH, out ruta);
            return ruta;
        } finally {
            dueno.Close();
            dueno.Dispose();
        }
    }
}
"""

_POWERSHELL = r"""
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $env:TRIMLINE_CSHARP
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$r = [SelectorArchivos]::Elegir($env:TRIMLINE_MODO, $env:TRIMLINE_TITULO, $env:TRIMLINE_INICIAL, $env:TRIMLINE_NOMBRE, $env:TRIMLINE_FILTRO)
if ($r) { Write-Output $r }
"""


class SinDialogo(RuntimeError):
    """No hay cómo mostrar un diálogo en este sistema."""


def elegir_carpeta(inicial: str | None = None, titulo: str = "Elegí la carpeta") -> str | None:
    """Muestra el diálogo y devuelve la carpeta elegida, o None si se canceló."""
    return _elegir("carpeta", titulo, inicial)


def abrir_archivo(inicial: str | None, titulo: str, filtro: tuple[str, str]) -> str | None:
    """Elegir un archivo existente. `filtro` = ("Descripción", "*.ext"), varios patrones con ";"."""
    return _elegir("abrir", titulo, inicial, filtro=filtro)


def guardar_archivo(inicial: str | None, nombre: str, titulo: str, filtro: tuple[str, str]) -> str | None:
    """Elegir dónde guardar (pregunta antes de pisar). Devuelve la ruta con la extensión puesta."""
    ruta = _elegir("guardar", titulo, inicial, nombre=nombre, filtro=filtro)
    ext = filtro[1].lstrip("*")
    if ruta and not ruta.lower().endswith(ext.lower()):
        ruta += ext
    return ruta


def _elegir(modo: str, titulo: str, inicial: str | None, nombre: str = "",
            filtro: tuple[str, str] | None = None) -> str | None:
    if sys.platform == "win32":
        entorno = {**os.environ, "TRIMLINE_MODO": modo, "TRIMLINE_TITULO": titulo, "TRIMLINE_INICIAL": inicial or "",
                   "TRIMLINE_NOMBRE": nombre, "TRIMLINE_FILTRO": "|".join(filtro) if filtro else "",
                   "TRIMLINE_CSHARP": _CSHARP}
        r = subprocess.run(  # noqa: S603
            ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", _POWERSHELL],
            capture_output=True, env=entorno, creationflags=subprocess.CREATE_NO_WINDOW, check=False,
        )
        salida = r.stdout.decode("utf-8", errors="replace").strip()
        if r.returncode != 0 and not salida:
            error = r.stderr.decode("utf-8", errors="replace").strip().splitlines()
            raise SinDialogo(f"no se pudo abrir el selector: {error[0] if error else r.returncode}")
    elif shutil.which("zenity"):
        orden = ["zenity", "--file-selection", f"--title={titulo}"]
        if modo == "carpeta":
            orden.append("--directory")
        if modo == "guardar":
            orden += ["--save", "--confirm-overwrite"]
        if filtro:
            orden.append(f"--file-filter={filtro[0]} | {filtro[1].replace(';', ' ')}")
        if inicial or nombre:
            orden.append(f"--filename={(inicial or '').rstrip('/')}/{nombre}")
        r = subprocess.run(orden, capture_output=True, text=True, check=False)  # noqa: S603
        salida = r.stdout.strip()
    elif shutil.which("kdialog"):
        base = inicial or os.path.expanduser("~")
        if modo == "carpeta":
            orden = ["kdialog", "--title", titulo, "--getexistingdirectory", base]
        else:
            accion = "--getsavefilename" if modo == "guardar" else "--getopenfilename"
            orden = ["kdialog", "--title", titulo, accion, os.path.join(base, nombre), filtro[1].replace(";", " ") if filtro else ""]
        r = subprocess.run(orden, capture_output=True, text=True, check=False)  # noqa: S603
        salida = r.stdout.strip()
    else:
        raise SinDialogo("no hay un diálogo de archivos en este sistema")
    return salida or None
