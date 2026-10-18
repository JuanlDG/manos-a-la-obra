# Manos a la Obra

Gestión de trabajos solidarios de construcción: materiales, herramientas y voluntarios.

## Ejecutar localmente

Requiere un Postgres accesible:

    DATABASE_URL=postgres://usuario:clave@localhost:5432/db npm start

Abrir http://localhost:3000. La tabla `jobs` se crea sola al iniciar.

## Despliegue en Railway

1. New Project → Deploy from GitHub repo → este repositorio.
2. En el proyecto: New → Database → Add PostgreSQL.
3. En el servicio de la app → Variables → New Variable → `DATABASE_URL` con valor `${{Postgres.DATABASE_URL}}`.
4. Settings → Networking → Generate Domain.

Los datos se comparten entre todos los usuarios (cada trabajo es una fila JSONB en `jobs`). No hay login: cualquiera con la URL puede editar.
