# Sistema de reserva para complejos deportivos

Repo: https://github.com/pereyra19group-svg/sistema-reserva-complejos-deportivos (privado)

## Estado actual

Lo que ya funciona, dentro de `app/frontend/panel.html` (panel interno para empleados):

- **Login** con Supabase Auth. Solo entra quien esté en la tabla `empleados` con `activo = true`.
- **Dashboard (home)**: resumen del día — reservas, ingresos, cobrado por transferencia/efectivo.
- **Canchas**: grilla de disponibilidad por día para las 6 canchas (`F5-1..4`, `F7-1..2`), con:
  - crear reserva rápida haciendo click en un turno libre, con autocompletado de clientes ya cargados;
  - ver detalle de una reserva, editarla o eliminarla;
  - marcar seña recibida (y pedir comprobante por WhatsApp si fue por transferencia);
  - confirmar asistencia y forma de pago del resto (transferencia/efectivo).
- **Control mensual**: estadísticas de ingresos del mes y carga/listado de egresos.
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
│       └── 002_permisos_y_habilitar_empleados.sql  grants + alta de empleados desde auth.users
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
2. SQL Editor → pegar y correr `database/migrations/001_esquema_inicial.sql` y luego `002_permisos_y_habilitar_empleados.sql`.
3. Authentication → Sign In / Providers → desactivar "Allow new users to sign up".
4. Authentication → Users → Add user → crear el usuario de cada empleado (email + contraseña, marcar "Auto confirm").
5. Volver a correr `002_permisos_y_habilitar_empleados.sql` (da de alta como empleado a los usuarios nuevos) o insertar manualmente: `insert into empleados (email, nombre) values ('email@del-empleado.com', 'Nombre');` (email en minúsculas).
6. Project Settings → API → copiar Project URL y anon public key en `app/frontend/js/supabase-config.js`.
7. Abrir `app/frontend/panel.html` e ingresar con el email y contraseña del paso 4.

Para dar de baja a un empleado: `update empleados set activo = false where email = '...';`

## Pendientes conocidos

- **Buffet**: falta implementar la sección (hoy es un ítem de menú vacío en el panel).
- `public/images/logo.png`: el archivo del logo no existe todavía; agregarlo con ese nombre.
- `index.html` (sitio público de reservas para clientes) no existe todavía. Cuando se haga, conviene que cree reservas vía n8n o una Edge Function con la service_role key, no directo desde el navegador.
- Integración WhatsApp/n8n: usar la API REST de Supabase con la service_role key (solo del lado servidor).
- `app/backend/`, `app/components/`, `docs/`: placeholders sin contenido.
- `_respaldo_pre_supabase/`: copia de `panel.html` y `script.js` previa al cambio de login; se puede borrar cuando todo funcione.

## Trabajar en equipo

Repo privado en GitHub. Para sumar a alguien: `gh repo add-collaborator pereyra19group-svg/sistema-reserva-complejos-deportivos <usuario>` (o Settings → Collaborators en la web). Al clonar, copiar `.env.example` a `.env` y completar las credenciales de Supabase (se comparten por un canal seguro, nunca por el repo — `.env` está en `.gitignore`).
