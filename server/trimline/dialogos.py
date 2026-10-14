"""Diálogos nativos que abre el servidor, para lo que el navegador no deja hacer.

Chrome y Edge no dejan elegir con su selector carpetas que consideran del sistema (la del
usuario, el Escritorio, Descargas, algunas unidades de red), y el navegador no dice la ruta de lo
que se elige. Elegir la carpeta acá y leer o escribir desde el servidor no tiene esas trabas.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

# El selector de Windows (el mismo del Explorador, con barra de direcciones para pegar una ruta),
# en modo carpeta: IFileOpenDialog con FOS_PICKFOLDERS. No hay forma de pedirlo desde .NET puro,
# así que va la interfaz COM declarada en C#.
#
# El servidor corre en segundo plano y Windows no deja que un proceso así se ponga adelante: el
# diálogo quedaría detrás del navegador. Se cuelga de una ventanita invisible "siempre encima" a la
# que se le da el foco enganchándose a la entrada del navegador (AttachThreadInput).
# La carpeta inicial y el título llegan por variables de entorno (sin problemas de comillas).
_CSHARP = r"""
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class SelectorCarpeta {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialog {}

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr padre);
        void SetFileTypes();
        void SetFileTypeIndex();
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
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint forma, [MarshalAs(UnmanagedType.LPWStr)] out string nombre);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHCreateItemFromParsingName(string ruta, IntPtr ctx, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr ventana, IntPtr proceso);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint de, uint a, bool enganchar);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr ventana);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr ventana);

    const uint FOS_NOCHANGEDIR = 0x8, FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
    const uint SIGDN_FILESYSPATH = 0x80058000;

    static void Adelante(IntPtr ventana) {
        IntPtr delante = GetForegroundWindow();
        uint suyo = GetWindowThreadProcessId(delante, IntPtr.Zero), mio = GetCurrentThreadId();
        bool enganchado = suyo != 0 && suyo != mio && AttachThreadInput(mio, suyo, true);
        BringWindowToTop(ventana);
        SetForegroundWindow(ventana);
        if (enganchado) AttachThreadInput(mio, suyo, false);
    }

    public static string Elegir(string titulo, string inicial) {
        Form dueno = new Form();
        dueno.TopMost = true;
        dueno.ShowInTaskbar = false;
        dueno.FormBorderStyle = FormBorderStyle.None;
        dueno.StartPosition = FormStartPosition.CenterScreen;
        dueno.Size = new System.Drawing.Size(1, 1);
        dueno.Opacity = 0;
        dueno.Show();
        Adelante(dueno.Handle);
        try {
            IFileDialog d = (IFileDialog)new FileOpenDialog();
            uint opciones;
            d.GetOptions(out opciones);
            d.SetOptions(opciones | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
            if (!string.IsNullOrEmpty(titulo)) d.SetTitle(titulo);
            d.SetOkButtonLabel("Elegir carpeta");
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
$r = [SelectorCarpeta]::Elegir($env:TRIMLINE_TITULO, $env:TRIMLINE_INICIAL)
if ($r) { Write-Output $r }
"""


class SinDialogo(RuntimeError):
    """No hay cómo mostrar un diálogo en este sistema."""


def elegir_carpeta(inicial: str | None = None, titulo: str = "Elegí la carpeta") -> str | None:
    """Muestra el diálogo y devuelve la carpeta elegida, o None si se canceló."""
    if sys.platform == "win32":
        entorno = {**os.environ, "TRIMLINE_INICIAL": inicial or "", "TRIMLINE_TITULO": titulo, "TRIMLINE_CSHARP": _CSHARP}
        r = subprocess.run(  # noqa: S603
            ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", _POWERSHELL],
            capture_output=True, env=entorno, creationflags=subprocess.CREATE_NO_WINDOW, check=False,
        )
        salida = r.stdout.decode("utf-8", errors="replace").strip()
        if r.returncode != 0 and not salida:
            error = r.stderr.decode("utf-8", errors="replace").strip().splitlines()
            raise SinDialogo(f"no se pudo abrir el selector de carpetas: {error[0] if error else r.returncode}")
    elif shutil.which("zenity"):
        orden = ["zenity", "--file-selection", "--directory", f"--title={titulo}"]
        if inicial:
            orden.append(f"--filename={inicial.rstrip('/')}/")
        r = subprocess.run(orden, capture_output=True, text=True, check=False)  # noqa: S603
        salida = r.stdout.strip()
    elif shutil.which("kdialog"):
        r = subprocess.run(["kdialog", "--title", titulo, "--getexistingdirectory", inicial or os.path.expanduser("~")],  # noqa: S603
                           capture_output=True, text=True, check=False)
        salida = r.stdout.strip()
    else:
        raise SinDialogo("no hay un diálogo de carpetas en este sistema: escribí la ruta a mano")
    return salida or None
