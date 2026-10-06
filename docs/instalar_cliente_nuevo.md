# Instalar el Sistema de Reservas en la cuenta de Supabase de un cliente

> Archivos que se usan: `database/instalar_base_cliente.sql`, `supabase/functions/alta-empleado/index.ts` y la carpeta `app/frontend`.

## 1. Crear el proyecto

- Entrar a [supabase.com](https://supabase.com) con la cuenta del cliente.
- **New project** → nombre del complejo → región **São Paulo** → guardar la contraseña de la base.

## 2. Instalar la base

- **SQL Editor** → **New query**.
- Pegar **todo** el archivo `database/instalar_base_cliente.sql` → **Run**.
- Debe decir **Success**. Si da error no se crea nada: no seguir y revisar el error.

## 3. Cerrar el registro público

- **Authentication → Sign In / Providers** → desactivar **"Allow new users to sign up"**.

## 4. Crear el primer Admin

- **Authentication → Users → Add user** → email y contraseña → marcar **"Auto confirm"**.
- **SQL Editor** → correr con los datos reales:

```sql
insert into public.empleados (email, nombre, rol)
values (lower('email@del-admin.com'), 'Nombre', 'jefe');
```

- El resto del equipo lo da de alta el Admin desde el panel (**Equipo**).

## 5. Instalar la función de alta de personas

- **Edge Functions → Deploy a new function → Via Editor**.
- Nombre: `alta-empleado` (exacto).
- Pegar el contenido de `supabase/functions/alta-empleado/index.ts` → **Deploy**.
- Entrar a la función → **Details** → desactivar **"Verify JWT"** → guardar.

## 6. Conectar el panel

- Hacer una copia de la carpeta `app/frontend` para el cliente.
- Supabase → **Project Settings → API** → copiar **Project URL** y **anon public key**.
- Pegarlas en `app/frontend/js/supabase-config.js` (`url` y `anonKey`).
- ⚠️ **Nunca** poner ahí la `service_role key`.
- Subir la carpeta a Netlify (o donde se aloje).

## 7. Probar

- [ ] Abrir `panel.html` y entrar con el Admin del paso 4.
- [ ] **Equipo** → cargar las canchas con sus precios y ajustar los horarios.
- [ ] **Equipo** → dar de alta a un Staff y probar que pueda entrar.
- [ ] Hacer una reserva de prueba y después cancelarla.

---

**Importante:** si la base cambia más adelante, hay que regenerar `instalar_base_cliente.sql` antes de usarlo con un cliente nuevo.
