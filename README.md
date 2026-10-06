# Sistema de reserva para complejos deportivos

Repo: https://github.com/pereyra19group-svg/sistema-reserva-complejos-deportivos (privado)

## Estado actual

Lo que ya funciona, dentro de `app/frontend/panel.html` (panel interno para empleados):

- **Login** con Supabase Auth. Solo entra quien esté en la tabla `empleados` con `activo = true`.
- **Dashboard (home)**: resumen del día — reservas, ingresos, cobrado por transferencia/efectivo.
- **Canchas**: grilla de disponibilidad por día para las canchas cargadas en la tabla `canchas`, con:
  - crear reserva rápida haciendo click en un turno libre, con autocompletado de clientes ya cargados;
  - ver detalle de una reserva, editarla o eliminarla;
  - marcar seña recibida (y pedir comprobante por WhatsApp si fue por transferencia);
  - confirmar asistencia y forma de pago del resto (transferencia/efectivo);
  - **cancelar** o marcar **"No vino"** (la reserva no se borra: libera la cancha y queda registrada; si tenía seña se elige si se retiene —sigue en la caja— o se devuelve). Eliminar queda solo para jefes.
- **Turnos fijos**: clientes que juegan todas las semanas. Se crean tildando "Turno fijo" en Nueva reserva y quedan reservados **todos los meses hasta que se den de baja**: al abrir el panel se cargan este mes y los 2 siguientes, y si navegás a un mes más adelante (grilla o control mensual) se cargan en ese momento (hasta 1 año adelante). Sección propia para verlos, **editarlos** (día, hora, cancha, duración, cliente, notas, desde qué fecha aplica) y darlos de baja.
- **Quién hizo qué**: la base registra automáticamente quién creó cada reserva, quién cobró la seña, quién confirmó la asistencia y quién canceló (se ve en el detalle de la reserva y en la Caja del día). Sección **Actividad** (solo jefes) con el historial completo del día.
- **En línea**: arriba a la derecha se ve quién tiene el panel abierto y en qué sección está (Supabase Realtime). En Equipo, la última conexión de cada persona.
- **Caja del día** (empleados y jefes): lo cobrado en la fecha elegida, separado en efectivo y transferencias, con detalle por turno, para el cierre de caja.
- **Control mensual** (solo jefes): estadísticas de ingresos del mes y carga/listado de egresos.
- **Equipo** (solo jefes): alta de personas **con usuario de login incluido** (contraseña temporal), roles, bajas, nueva contraseña temporal, y **precios y horarios** editables. Cada persona cambia su contraseña tocando su nombre abajo a la izquierda.
- **Buffet**: ítem de navegación creado pero sin implementar todavía (sección vacía).

Todo esto habla directo con Supabase desde el navegador (`app/frontend/js/supabase-api.js`, capa `SheetsAPI`), protegido por RLS — no hay backend propio corriendo todavía.

## Estructura del proyecto

```
├── app/
│   ├── frontend/          panel de administración (login + dashboard + canchas + control mensual)
│   │   ├── panel.html
│   │   ├── css/styles.css
│   │   └── js/
│   │       ├── script.js          lógica del panel
│   │       ├── supabase-config.js URL + anon key del proyecto Supabase
│   │       └── supabase-api.js    capa de datos (objeto global SheetsAPI) contra Supabase
│   ├── backend/            (placeholder) API/servidor Node.js — todavía sin implementar
│   └── components/         (placeholder) componentes reutilizables
│
├── public/
│   ├── images/              logo.png (pendiente de agregar)
│   ├── icons/
│   └── fonts/
│
├── database/
│   └── migrations/
│       ├── 001_esquema_inicial.sql              tablas, RLS, restricción anti-superposición
│       ├── 002_permisos_y_habilitar_empleados.sql  grants + alta de empleados desde auth.users
│       ├── 003_roles_jefe_empleado.sql          roles jefe / empleado
│       ├── 004_gestion_equipo.sql               los jefes gestionan el equipo desde el panel
│       ├── 005_cancelaciones_auditoria_turnos_fijos.sql  cancelar/no vino, quién hizo qué,
│       │                                        turnos fijos, precios/horarios, último acceso
│       ├── 006_turnos_fijos_todos_los_meses_y_edicion.sql  turnos fijos sin límite de meses + editar
│       ├── 007_pago_restante_mixto.sql          pago del resto mitad efectivo / mitad transferencia
│       └── 008_gestion_canchas.sql              alta, edición, baja de canchas desde el panel
│
├── supabase/
│   └── functions/alta-empleado/index.ts  Edge Function: crea el usuario de login de un empleado
│
├── docs/                    (placeholder)
├── _respaldo_pre_supabase/  copia de panel.html/script.js previa al login con Supabase
│
├── .env                     valores locales reales (no se sube al repo)
├── .env.example             plantilla de variables de entorno
├── .gitignore
├── README.md
└── package.json
```

## Base de datos: Supabase

Tablas: `canchas` (con precio por hora), `clientes` (identificados por WhatsApp), `reservas`, `egresos` y `empleados` (lista blanca de quién puede entrar al panel).

- La base impide reservas superpuestas en la misma cancha (restricción `reservas_sin_superposicion`), incluso si dos empleados reservan a la vez.
- El precio de cada reserva lo calcula la base: `precio_hora` de la cancha × duración. Para cambiar precios, editar la tabla `canchas`.
- Seguridad: RLS activado en todas las tablas. Solo usuarios logueados cuyo email esté en `empleados` (con `activo = true`) pueden leer o escribir.

### Puesta en marcha

1. Crear un proyecto en supabase.com (región São Paulo, la más cercana).
2. SQL Editor → pegar y correr, en orden, `database/migrations/001` → `002` → … → `008`.
3. Authentication → Sign In / Providers → desactivar "Allow new users to sign up".
4. Authentication → Users → Add user → crear el usuario de cada empleado (email + contraseña, marcar "Auto confirm").
5. Volver a correr `002_permisos_y_habilitar_empleados.sql` (da de alta como empleado a los usuarios nuevos) o insertar manualmente: `insert into empleados (email, nombre) values ('email@del-empleado.com', 'Nombre');` (email en minúsculas).
6. Project Settings → API → copiar Project URL y anon public key en `app/frontend/js/supabase-config.js`.
7. Abrir `app/frontend/panel.html` e ingresar con el email y contraseña del paso 4.
8. Instalar la Edge Function para dar de alta personas desde el panel (ver abajo).

### Instalar para un cliente nuevo (otra cuenta de Supabase)

`database/instalar_base_cliente.sql` crea la base completa en un solo paso (equivale a correr 001 → 010), vacía y lista para usar. Verificado contra la base original: mismas tablas, columnas, restricciones, índices, triggers, políticas y funciones.

1. En la cuenta del cliente: crear proyecto nuevo (región São Paulo).
2. SQL Editor → pegar todo `instalar_base_cliente.sql` → Run.
3. Seguir los "PASOS DESPUÉS DEL INSTALADOR" que están al final del archivo (desactivar registro público, primer Admin, Edge Function, `supabase-config.js`).

Si se cambia la base más adelante, regenerar este archivo para que los clientes nuevos reciban la versión actual.

### Edge Function `alta-empleado` (alta de personas desde Equipo)

Crear un usuario de login necesita la service_role key, que nunca puede estar en el navegador. Por eso lo hace una función que corre en Supabase:

- **Desde la web**: Supabase → Edge Functions → *Deploy a new function* → *Via Editor* → nombre `alta-empleado` → pegar el contenido de `supabase/functions/alta-empleado/index.ts` → *Deploy*. Desactivar "Verify JWT" (ver abajo).
- **O con la CLI**: `npx supabase functions deploy alta-empleado --project-ref <id-del-proyecto>`.
- **Importante:** desactivar "Verify JWT" (o desplegar con `--no-verify-jwt`). El proyecto firma las sesiones con claves nuevas (ES256) y la verificación vieja del gateway las rechaza con 401. Es seguro: la función valida la sesión por su cuenta (`es_jefe()` con el token de quien llama).

No hace falta cargar claves: Supabase ya le pasa `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. La función verifica que quien la llama sea jefe.

### Ya tenía el sistema andando (actualización)

Correr las migraciones que falten (003, 004, 005, 006, en ese orden), instalar la Edge Function y recargar el panel con Ctrl+F5. **El panel nuevo necesita la 005 y la 006**: sin la 005 no carga las reservas y sin la 006 los turnos fijos no se cargan más allá de 8 semanas ni se pueden editar.

Para dar de baja a un empleado: desde Equipo, o `update empleados set activo = false where email = '...';`

## Roles: jefe / empleado

En el panel se muestran como **Admin** (`jefe`) y **Staff** (`empleado`). En la base y en el código siguen siendo `jefe` / `empleado` (migración 010 solo cambió los mensajes de error).

Columna `rol` en `empleados` (migración `003_roles_jefe_empleado.sql`).

- **empleado**: Dashboard, Canchas, Buffet y Caja del día. No ve Control mensual ni egresos.
- **jefe**: todo lo anterior + Control mensual y egresos.

Los egresos están bloqueados por RLS para empleados (no es solo ocultar el menú). Asignar rol:
`update empleados set rol = 'empleado' where email = '...';` (la migración deja a todos los ya cargados como `jefe`).

## Reglas que cumple la base (no se pueden saltear desde el navegador)

- Quién hizo cada cosa (`creada_por`, `sena_por`, `asistencia_por`, `cancelada_por`, `creado_por` en egresos) lo completa un trigger con el usuario logueado; lo que mande el navegador en esos campos se ignora.
- Solo los jefes pueden eliminar reservas; los empleados cancelan.
- Las reservas canceladas o "No vino" liberan la cancha.
- Dos turnos fijos activos no pueden pisarse (misma cancha, día y horario).
- Editar un turno fijo mueve sus próximas fechas al horario nuevo (con la seña que ya tuvieran). Si alguna semana el horario nuevo está ocupado, esa fecha queda como estaba y el panel la avisa. Las fechas jugadas, canceladas o movidas a mano no se tocan.
- Editar una reserva vieja no le cambia el precio, salvo que cambies la cancha o la duración.
- Tabla `actividad`: historial de reservas, egresos, turnos fijos, equipo, precios y horarios. Solo la leen los jefes.

## Pendientes conocidos

- Los empleados siguen pudiendo leer las reservas (las necesitan para la grilla), así que técnicamente podrían consultar montos de otros días vía API; el control mensual y los egresos sí están protegidos.

- **Buffet**: falta implementar la sección (hoy es un ítem de menú vacío en el panel).
- `public/images/logo.png`: el archivo del logo no existe todavía; agregarlo con ese nombre.
- "En línea" usa Supabase Realtime (Presence). Si no aparece nadie, revisar en Supabase → Realtime → Settings que no esté activado "solo canales privados".
- Las reservas que cruzan la medianoche (ej. 23:00 por 2 h) se guardan bien en la base, pero la grilla del día siguiente no muestra la parte de después de las 00:00.
- `index.html` (sitio público de reservas para clientes) no existe todavía. Cuando se haga, conviene que cree reservas vía una Edge Function con la service_role key, no directo desde el navegador.
- Integración WhatsApp/n8n: usar la API REST de Supabase con la service_role key (solo del lado servidor).
- `app/backend/`, `app/components/`, `docs/`: placeholders sin contenido.
- `_respaldo_pre_supabase/`: copia de `panel.html` y `script.js` previa al cambio de login; se puede borrar cuando todo funcione.

## Trabajar en equipo

Repo privado en GitHub. Para sumar a alguien: `gh repo add-collaborator pereyra19group-svg/sistema-reserva-complejos-deportivos <usuario>` (o Settings → Collaborators en la web). Al clonar, copiar `.env.example` a `.env` y completar las credenciales de Supabase (se comparten por un canal seguro, nunca por el repo — `.env` está en `.gitignore`).

## Multi-complejo (descartado)

El 05/10/2026 se probó una versión multi-complejo (migración 009 + `admin.html`) y se volvió a **un solo complejo**. Lo que se armó quedó guardado en `_respaldo_multi_complejo/` (incluye `revertir_009.sql`, el script que dejó la base como en 008).
