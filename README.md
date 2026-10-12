# aligner-trimline

Editor de **líneas de recorte de alineadores dentales**. Sobre el modelo 3D de una arcada, el
usuario define la curva por donde se corta el alineador termoformado, y el programa la exporta
para la máquina que hace el corte.

> Estado: primera etapa funcionando. Falta probar el instalador en un Windows real.

## Usarlo

En Linux, desde una copia del repo:

```
./trimline.sh
```

Arma el entorno la primera vez, levanta el servidor local y abre el navegador. En Windows se
instala con `AlignerTrimlineSetup-<versión>.exe`, que sale de cada release.

1. **Modelos.** Arrastrá los STL. El nombre dice el maxilar y el movimiento
   (`0044 Apellido Nombre 1.0 sup 01.stl`); lo que no se reconoce se corrige en la tabla.
   Destildá los movimientos que no se usan: el primero tildado de cada maxilar es la base.
2. **Maxilar.** Se trabaja de a uno.
3. **Puntos.** En el movimiento base: modo vestibular y un clic en la encía debajo de cada
   diente; modo lingual y lo mismo del otro lado; modo extremos y un clic en cada punta.
4. **Ajuste.** Los deslizadores del visor mueven el offset, el festoneado y el ancho de los
   festones. Con un punto elegido aparecen sus dos manijas: arrastrarlas ajusta ese festón.
5. **Movimientos.** Arrastrá el cursor de la línea de tiempo. Si en un movimiento la curva
   quedó corrida, mové el punto: queda un keyframe ahí y la curva avanza de a poco entre
   keyframes.
6. **Exportar.** `<ID>.pts` con todas las curvas, `<ID> PC.pts` con los puntos de control y
   `<ID>.curva` con los datos del caso (un JSON), igual que los que ya consume el generador del KUKA.
   El navegador pregunta en qué carpeta dejarlos.
7. **Guardar.** `<ID>.trimline` es una foto entera del trabajo: puntos, keyframes, ajustes, la
   vista y las mallas ya procesadas. Abrirlo deja todo como estaba, sin volver a arrastrar
   los STL. Los `.trimline.json` de antes también se abren (las mallas sí hay que arrastrarlas).

Ctrl+Z deshace y Ctrl+Y (o Ctrl+Shift+Z) rehace; Ctrl+S guarda.

Mouse: clic izquierdo marca y mueve; clic derecho orbita; shift + clic derecho desplaza; la
rueda hace zoom.

## La idea

La curva no se dibuja punto por punto: se **genera**.

- **Controladores por diente.** Un clic en la encía debajo de cada pieza, del lado vestibular y
  del lingual, más uno en cada extremo de la arcada. Cada uno marca una cresta de la curva.
- **Crestas inversas.** El punto medio entre dos controladores vecinos se calcula solo, y sube o
  baja para que el festoneado sea más o menos pronunciado.
- **Offset global.** Toda la curva se desplaza junta, siempre apoyada sobre la malla.
- **Keyframes por movimiento.** La curva se define en el primer movimiento del tratamiento. Al
  avanzar, mover un controlador guarda un keyframe; entre keyframes la posición se interpola, y
  así la curva acompaña al diente a lo largo de todos los movimientos.

Se trabaja de a un maxilar por vez, y antes de empezar se elige qué movimientos entran.

## Arquitectura

- **Motor** (`server/trimline/`): Python con FastAPI y trimesh, solo mallas. Es el dueño de la
  curva: la genera (`curva.py`), resuelve los keyframes (`proyecto.py`) y la exporta
  (`exportar/`). La malla se suelda una vez y el navegador recibe los mismos vértices e
  índices; durante la edición solo viaja la curva.
- **Interfaz** (`web/`): three.js sin build. Hace lo liviano: el rayo del mouse, el arrastre y
  el dibujo. La línea de tiempo y los deslizadores (`src/hud.js`) están dibujados en el visor,
  fijos a la pantalla.
- **Motores vendorizados** (`web/vendor/`): threejs-render-engine, threejs-material-engine y
  threejs-cad-sdk, más three y three-mesh-bvh para que ande sin internet. No se editan: se
  traen con `tools/vendorizar.sh <render|sdk|materiales> <etiqueta>`.
- **Exportación**: cada formato es un módulo en `server/trimline/exportar/` que se registra
  con `@exportador`. Hoy: `pts` (un archivo con todo) y `pts-por-curva`.
- **Lanzador** (`lanzador.py`): levanta el servidor y abre el navegador; si ya está abierto,
  solo abre la pestaña. El servidor se apaga solo cuando la pestaña lleva un rato cerrada.
- **Instalador y actualizaciones** (`packaging/`, `.github/workflows/release.yml`): publicar un
  release arma el `.exe` de Windows y lo cuelga del release. Desde el programa se puede ver qué
  releases hay, instalar uno y volver al anterior.

Pruebas: `.venv/bin/python -m pytest`.

## Datos

Los modelos dentales son datos de pacientes y **no van en este repositorio**. El `.gitignore`
excluye mallas y exportaciones.
