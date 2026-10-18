# Manos a la Obra

Gestión de cuadrillas de misiones: materiales, herramientas, personas y lista de compra, con inventario y búsqueda de alumnos.

## Ejecutar localmente

Requiere un Postgres accesible:

    DATABASE_URL=postgres://usuario:clave@localhost:5432/db npm start

Abrir http://localhost:3000. La tabla `jobs` se crea sola al iniciar.

## Despliegue en Railway

1. New Project → Deploy from GitHub repo → este repositorio.
2. En el proyecto: New → Database → Add PostgreSQL.
3. En el servicio de la app → Variables (todas en el servicio `app`, no en Postgres):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_PASSWORD` = contraseña del administrador
   - `APP_PASSWORD` = contraseña del equipo (rol usuario)
4. Settings → Networking → Generate Domain.

## Roles

| Rol | Cómo entra | Qué puede hacer |
|---|---|---|
| Administrador | `ADMIN_PASSWORD` | Todo, incluido cambiar la bodega central (inventario). |
| Usuario | `APP_PASSWORD` | Editar cuadrillas (usando solo lo que ya está en la bodega) y pedir compras. No puede agregar ni quitar personas. |
| Solo lectura | “Entrar sin contraseña” | Ver todo, no cambiar nada. |

Sin `ADMIN_PASSWORD` nadie puede cambiar la bodega. Si no se define ninguna contraseña (por ejemplo en local), la app queda abierta y todos son administradores.

## Cómo funciona el inventario

- **Bodega central**: todo el inventario (herramientas y materiales con su total). Se carga en la sección Inventario, solo el administrador.
- **Cuadrillas**: usan elementos de la bodega, elegidos de una lista que se acota al escribir. No pueden pedir más de lo que sobra.
- **Parroquia**: lo que sobra = total de la bodega menos lo asignado a cuadrillas. Se calcula, no se carga.
- Un elemento es o material o herramienta, nunca los dos. Singular y plural son el mismo elemento (taladro / taladros, pincel / pinceles).

Los datos se comparten entre todos los usuarios (tablas `catalog`, `cuadrillas` y `avisos`). Al iniciar, el servidor convierte automáticamente los datos de la versión anterior (materiales escritos a mano) a este formato.

## Lista de compra

- Cualquier usuario pide algo indicando su nombre, su cuadrilla, qué necesita y cuánto. Al escribir (y al enviar) la app avisa si ya hay disponible en la parroquia, o quién lo tiene.
- El administrador aprueba (puede aprobar una cantidad menor) o rechaza con motivo, y cierra la etapa. Lo aprobado queda como lista de compra de esa etapa, agrupada por elemento; las pendientes pasan a la etapa siguiente.
- Después, el administrador marca como comprado cada línea o toda la etapa. Las etapas cerradas quedan como registro.
- Cada persona puede anular sus propias solicitudes mientras estén pendientes (se reconoce por el navegador).
- Al marcar como comprado, la cantidad aprobada se suma sola a la bodega central. Si el elemento todavía no existe, la app pregunta si es material o herramienta. Deshacer resta lo mismo (no si las cuadrillas ya lo tienen asignado). Si la unidad pedida no coincide con la de la bodega, no suma y hay que ajustarlo a mano en Inventario.

## Quién es cada persona

- Las personas (equipo motor y alumnos) solo las agrega o quita el administrador.
- La primera vez que entra un usuario, elige su nombre de la lista del equipo motor. Desde entonces sus pedidos se firman solos con su nombre y su cuadrilla; puede cambiarlo con “Cambiar” en la barra superior. Si el administrador lo saca del equipo motor, vuelve a pedírsele.
- El administrador, si no eligió identidad, firma como “Administrador” y elige la cuadrilla al pedir.
- Eliminar un elemento de la bodega pide doble confirmación: primero “¿seguro?” y luego escribir su nombre. El servidor también exige el nombre.
- En la vista Parroquia, quien ya eligió su nombre del equipo motor ve un botón + verde a la derecha de cada elemento: añade una unidad a su cuadrilla y muestra a pantalla completa, unos dos segundos, “… se ha añadido correctamente a la …”. El servidor sigue verificando que haya saldo.
