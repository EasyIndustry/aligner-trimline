# aligner-trimline

Editor de **líneas de recorte de alineadores dentales**. Sobre el modelo 3D de una arcada, el
usuario define la curva por donde se corta el alineador termoformado, y el programa la exporta
para la máquina que hace el corte.

> Estado: en definición. Todavía no hay código; este README describe lo acordado.

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

- **Motor**: Python, solo mallas. Es el dueño de la curva: la genera, la suaviza y la exporta.
  Corre como servidor local en una PC o en un servidor aparte.
- **Interfaz**: el navegador, con three.js. Se ocupa de mostrar el modelo y de la interacción
  (rayo del mouse, arrastre de controladores, línea de tiempo de movimientos).
- **Exportación**: modular. El primer formato es `.pts`, con los puntos de cada curva por maxilar
  y movimiento.

## Datos

Los modelos dentales son datos de pacientes y **no van en este repositorio**. El `.gitignore`
excluye mallas y exportaciones.
