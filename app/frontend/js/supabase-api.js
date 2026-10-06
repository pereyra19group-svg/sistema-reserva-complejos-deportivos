// ─────────────────────────────────────────────────────────
//  CAPA DE DATOS — Supabase
//  Expone el mismo objeto global `SheetsAPI` que usaba el panel con
//  Sheets/Airtable, así script.js funciona sin cambiar sus llamadas.
//  Requiere cargar antes: supabase-js (CDN) y supabase-config.js
// ─────────────────────────────────────────────────────────
(function () {
  const cfg = window.SUPABASE_CONFIG || {};
  if (!window.supabase || !cfg.url || !cfg.anonKey) {
    console.error('[SheetsAPI] Falta supabase-js o SUPABASE_CONFIG (url / anonKey).');
  }
  const db = window.supabase.createClient(cfg.url, cfg.anonKey);

  // ── helpers ─────────────────────────────────────────────
  const pad     = n => String(n).padStart(2, '0');
  const hhmm    = t => (t || '').slice(0, 5);                 // '20:00:00' → '20:00'
  const num     = v => Number(v) || 0;
  const normTel = t => String(t || '').replace(/[^\d+]/g, ''); // deja solo dígitos y '+'
  const hoyStr  = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  function monthRange(year, month) {
    const y2 = month === 12 ? year + 1 : year;
    const m2 = month === 12 ? 1 : month + 1;
    return { desde: `${year}-${pad(month)}-01`, hasta: `${y2}-${pad(m2)}-01` };
  }

  function mensajeError(error) {
    if (!error) return 'Error desconocido.';
    const msg = error.message || String(error);
    if (error.code === '23P01') return 'Ese horario se superpone con otra reserva en esa cancha.';
    if (error.code === '42501' || /row-level security/i.test(msg)) return 'Sin permiso. Volvé a iniciar sesión.';
    if (/JWT|token/i.test(msg)) return 'La sesión expiró. Volvé a iniciar sesión.';
    if (/Failed to fetch|NetworkError/i.test(msg)) return 'Sin conexión con la base de datos.';
    return msg;
  }

  const ok   = (extra = {}) => ({ success: true, ...extra });
  const fail = error => {
    console.error('[SheetsAPI]', error);
    return { success: false, error: mensajeError(error) };
  };

  // Supabase devuelve máximo 1000 filas por consulta: paginamos.
  async function traerTodo(buildQuery) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await buildQuery().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  // ── reservas: formato que espera script.js ──────────────
  const SELECT_RESERVA =
    'id, cancha_id, fecha, hora_inicio, duracion, precio, sena, tipo_sena, estado_sena, ' +
    'estado, pago_restante, tipo_pago_restante, pago_restante_transf, notas, origen, created_at, updated_at, ' +
    'creada_por, modificada_por, sena_por, sena_at, asistencia_por, asistencia_at, ' +
    'cancelada_por, cancelada_at, motivo_cancelacion, turno_fijo_id, ' +
    'cliente:clientes(nombre, telefono)';

  // Estados que ocupan la cancha. "Cancelada" y "No vino" la liberan.
  const ACTIVOS = ['Confirmada', 'Asistida'];
  const esActiva = r => ACTIVOS.includes(r.status);

  function mapReserva(r) {
    const hora = hhmm(r.hora_inicio);
    return {
      recordId:         r.id,
      court:            r.cancha_id,
      date:             r.fecha,
      time:             hora,
      startTime:        hora,
      duration:         r.duracion,
      price:            num(r.precio),
      name:             r.cliente?.nombre   || '',
      phone:            r.cliente?.telefono || '',
      sena:             num(r.sena),
      tipoSena:         r.tipo_sena,
      estadoSena:       r.estado_sena,
      status:           r.estado,
      pagoRestante:     num(r.pago_restante),
      tipoPagoRestante: r.tipo_pago_restante || '',
      pagoRestanteTransf: num(r.pago_restante_transf),
      notas:           r.notas || '',
      origen:           r.origen,
      creadaPor:        r.creada_por || '',
      creadaAt:         r.created_at || '',
      modificadaPor:    r.modificada_por || '',
      modificadaAt:     r.updated_at || '',
      senaPor:          r.sena_por || '',
      senaAt:           r.sena_at || '',
      asistenciaPor:    r.asistencia_por || '',
      asistenciaAt:     r.asistencia_at || '',
      canceladaPor:     r.cancelada_por || '',
      canceladaAt:      r.cancelada_at || '',
      motivoCancelacion: r.motivo_cancelacion || '',
      turnoFijoId:      r.turno_fijo_id || '',
    };
  }

  // Día (hora local) en que se cobró la seña. La plata cuenta en ese día, no en el del turno.
  // Si no hay registro de cuándo se recibió (reservas viejas), cuenta en la fecha del turno.
  function diaSena(r) {
    if (!r.senaAt) return r.date;
    const d = new Date(r.senaAt);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Lo cobrado en [desde, hasta) = señas recibidas en ese rango + resto pagado al confirmar
  // asistencia de turnos de ese rango. Una reserva cancelada con la seña retenida sigue sumando la seña.
  function calcularCobros(reservas, desde, hasta) {
    const enRango = f => f >= desde && f < hasta;
    const s = { totalBookings: reservas.filter(r => esActiva(r) && enRango(r.date)).length, ingresos: 0, transferencias: 0, efectivo: 0 };
    const sumar = (monto, medio, transf = 0) => {
      if (monto <= 0) return;
      s.ingresos += monto;
      if (medio === 'Transferencia') s.transferencias += monto;
      else if (medio === 'Efectivo') s.efectivo += monto;
      else if (medio === 'Mixto') { s.transferencias += transf; s.efectivo += monto - transf; }
    };
    reservas.forEach(r => {
      if (r.estadoSena === 'Recibida' && enRango(diaSena(r))) sumar(r.sena, r.tipoSena);
      if (r.status === 'Asistida' && enRango(r.date))         sumar(r.pagoRestante, r.tipoPagoRestante, r.pagoRestanteTransf);
    });
    return s;
  }

  // getAvailability() se llama una vez por cancha (6 veces seguidas):
  // compartimos una sola consulta por fecha durante 2 segundos.
  let cacheDia = { fecha: null, t: 0, promise: null };
  function reservasDelDia(fecha) {
    const now = Date.now();
    if (cacheDia.fecha === fecha && cacheDia.promise && now - cacheDia.t < 2000) return cacheDia.promise;
    const promise = traerTodo(() =>
      db.from('reservas').select(SELECT_RESERVA).eq('fecha', fecha).order('hora_inicio')
    ).then(rows => rows.map(mapReserva));
    cacheDia = { fecha, t: now, promise };
    promise.catch(() => { if (cacheDia.promise === promise) cacheDia.promise = null; });
    return promise;
  }
  const invalidarCache = () => { cacheDia.promise = null; };

  async function upsertCliente(nombre, telefono) {
    const { data, error } = await db
      .from('clientes')
      .upsert({ nombre: String(nombre).trim(), telefono: normTel(telefono) }, { onConflict: 'telefono' })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  function camposSena({ sena, tipoSena, estadoSena }) {
    const sinSena = !tipoSena || tipoSena === 'Sin seña';
    return {
      sena:        sinSena ? 0 : num(sena),
      tipo_sena:   sinSena ? 'Sin seña' : tipoSena,
      estado_sena: sinSena ? 'Pendiente' : (estadoSena || 'Pendiente'),
    };
  }

  let profile = { email: '', nombre: '', rol: 'empleado' };

  // Errores de la Edge Function: el mensaje viene en el cuerpo de la respuesta
  async function errorDeFuncion(error) {
    const res = error && error.context;
    let body = null;
    if (res && typeof res.text === 'function') {
      try { const t = await res.clone().text(); try { body = JSON.parse(t); } catch (_) { body = { message: t }; } } catch (_) {}
    }
    if (body && body.error) return body.error;
    const status = res && res.status;
    const det = body && (body.message || body.msg || body.code);
    if (status === 401) return `Supabase rechazó la llamada (401${det ? ': ' + det : ''}). En Supabase → Edge Functions → alta-empleado → Details, desactivá "Verify JWT with legacy secret" / "Enforce JWT verification" y guardá: la función ya verifica sola quién la llama.`;
    if (status === 404) return 'No se encontró la función "alta-empleado" en Supabase. Seguí el paso de instalación del README.';
    if (!status && /Failed to send|fetch/i.test(error.message || '')) return 'No se pudo llamar a la función "alta-empleado" (¿está desplegada con ese nombre exacto?).';
    return `La función "alta-empleado" respondió con error${status ? ' ' + status : ''}${det ? ': ' + det : ''}. Mirá Supabase → Edge Functions → alta-empleado → Logs.`;
  }

  // Presencia (quién está en línea), con Supabase Realtime
  let canalPresencia = null;
  let estadoPresencia = {};
  const metaPresencia = () => ({
    nombre: profile.nombre || profile.email.split('@')[0],
    rol: profile.rol,
    ...estadoPresencia,
  });

  // ── API pública ─────────────────────────────────────────
  window.SheetsAPI = {
    client: db,

    // AUTH
    async signIn(email, password) {
      const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        return { success: false, error: /invalid/i.test(error.message)
          ? 'Email o contraseña incorrectos.' : mensajeError(error) };
      }
      const chk = await this.checkEmployee();
      if (!chk.ok) {
        await db.auth.signOut();
        return { success: false, error: chk.error
          ? 'No se pudo verificar el permiso: ' + chk.error
          : `El email ${email.trim().toLowerCase()} no está dado de alta en el equipo (o está inactivo).` };
      }
      return ok();
    },

    async signOut() {
      await this.stopPresence();
      await db.auth.signOut();
      invalidarCache();
      profile = { email: '', nombre: '', rol: 'empleado' };
    },

    async hasSession() {
      const { data } = await db.auth.getSession();
      return !!data.session && (await this.isEmployee());
    },

    async isEmployee() {
      return (await this.checkEmployee()).ok;
    },

    // Devuelve { ok, rol, nombre, email }. Filtra por el email propio porque
    // los jefes pueden leer toda la tabla empleados.
    async checkEmployee() {
      const { data: sess } = await db.auth.getSession();
      const email = (sess.session?.user?.email || '').toLowerCase();
      if (!email) return { ok: false };
      const { data, error } = await db.from('empleados')
        .select('email, nombre, rol').eq('email', email).eq('activo', true).limit(1);
      if (error) {
        console.error('[SheetsAPI] checkEmployee', error);
        return { ok: false, error: error.message || String(error) };
      }
      if (!data.length) return { ok: false };
      profile = { email, nombre: data[0].nombre || '', rol: data[0].rol || 'empleado' };
      return { ok: true, ...profile };
    },

    getProfile() { return profile; },

    async changePassword(nueva) {
      const { error } = await db.auth.updateUser({ password: nueva });
      if (error) return { success: false, error: /different|same/i.test(error.message)
        ? 'La contraseña nueva tiene que ser distinta a la actual.'
        : /least|short|weak/i.test(error.message) ? 'La contraseña es muy corta (mínimo 6 caracteres).' : mensajeError(error) };
      return ok();
    },

    async marcarAcceso() {
      const { error } = await db.rpc('marcar_acceso');
      if (error) console.warn('[SheetsAPI] marcarAcceso', error.message);
    },

    // CONFIGURACIÓN: canchas, precios y horarios (fuente única: la base)
    async getConfig() {
      try {
        const [canchas, conf] = await Promise.all([
          db.from('canchas').select('id, tipo, etiqueta, precio_hora, activa, orden').eq('eliminada', false).order('orden'),
          db.from('configuracion').select('hora_apertura, hora_cierre').eq('id', 1).maybeSingle(),
        ]);
        if (canchas.error) throw canchas.error;
        return {
          success: true,
          canchas: canchas.data.map(c => ({
            id: c.id, type: c.tipo, label: c.etiqueta, activa: c.activa,
            name: 'Fútbol ' + String(c.tipo).replace(/^F/, ''),
            price: num(c.precio_hora),
          })),
          // si todavía no se corrió la migración 005, usa el horario de siempre
          apertura: conf.data ? conf.data.hora_apertura : 9,
          cierre:   conf.data ? conf.data.hora_cierre   : 24,
        };
      } catch (e) { return fail(e); }
    },

    async saveAjustes({ precios, apertura, cierre }) {
      try {
        for (const [id, precio] of Object.entries(precios || {})) {
          const { error } = await db.from('canchas').update({ precio_hora: num(precio) }).eq('id', id);
          if (error) throw error;
        }
        const { error } = await db.from('configuracion')
          .update({ hora_apertura: parseInt(apertura), hora_cierre: parseInt(cierre) }).eq('id', 1);
        if (error) throw error;
        return ok();
      } catch (e) { return fail(e); }
    },

    // GESTIÓN DE CANCHAS (jefes): crear, editar, desactivar, eliminar
    async crearCancha({ tipo, etiqueta, precio }) {
      const { error } = await db.rpc('crear_cancha', { p_tipo: tipo, p_etiqueta: etiqueta, p_precio: num(precio) });
      return error ? { success: false, error: mensajeError(error) } : ok();
    },

    async editarCancha({ id, tipo, etiqueta, precio }) {
      const { error } = await db.from('canchas')
        .update({ tipo, etiqueta: String(etiqueta).trim(), precio_hora: num(precio) }).eq('id', id);
      if (!error) invalidarCache();
      return error ? { success: false, error: mensajeError(error) } : ok();
    },

    // Devuelve { success, ok:false, uso } si todavía tiene reservas futuras / turnos fijos activos
    async cambiarEstadoCancha(id, activa) {
      const { data, error } = await db.rpc('cambiar_estado_cancha', { p_id: id, p_activa: activa, p_hoy: hoyStr() });
      if (error) return { success: false, error: mensajeError(error) };
      invalidarCache();
      return { success: true, ok: data.ok, uso: data.uso };
    },

    // Devuelve { success, ok:false, uso } si tiene reservas futuras / fijos activos y no se confirmó (forzar)
    async eliminarCancha(id, forzar = false) {
      const { data, error } = await db.rpc('eliminar_cancha', { p_id: id, p_hoy: hoyStr(), p_forzar: forzar });
      if (error) return { success: false, error: mensajeError(error) };
      invalidarCache();
      return { success: true, ok: data.ok, uso: data.uso };
    },

    // GRILLA DEL DÍA
    async getAvailability(courtId, fecha) {
      try {
        const reservas = (await reservasDelDia(fecha)).filter(r => r.court === courtId && esActiva(r));
        const bookedSlots = [];
        const bookingDetails = {};
        reservas.forEach(r => {
          const [h, m] = r.time.split(':').map(Number);
          for (let i = 0; i < r.duration && h + i <= 23; i++) {
            const slot = `${pad(h + i)}:${pad(m)}`;
            bookedSlots.push(slot);
            bookingDetails[slot] = r; // mismo objeto para todos los turnos de la reserva
          }
        });
        return { bookedSlots, bookingDetails };
      } catch (e) {
        console.error('[SheetsAPI] getAvailability', e);
        return { error: mensajeError(e), bookedSlots: [], bookingDetails: {} };
      }
    },

    // Reservas canceladas / "no vino" del día (para la caja: señas retenidas)
    async getCanceladasDelDia(fecha) {
      try {
        return (await reservasDelDia(fecha)).filter(r => !esActiva(r));
      } catch (e) {
        console.error('[SheetsAPI] getCanceladasDelDia', e);
        return [];
      }
    },

    diaSena,

    // Señas cobradas ese día para turnos de OTRA fecha (entran en la caja del día cobrado)
    async getSenasDeOtrasFechas(fecha) {
      try {
        const [y, m, d] = fecha.split('-').map(Number);
        const ini = new Date(y, m - 1, d).toISOString();
        const fin = new Date(y, m - 1, d + 1).toISOString();
        const rows = await traerTodo(() =>
          db.from('reservas').select(SELECT_RESERVA)
            .eq('estado_sena', 'Recibida').neq('fecha', fecha)
            .gte('sena_at', ini).lt('sena_at', fin)
        );
        return rows.map(mapReserva);
      } catch (e) {
        console.error('[SheetsAPI] getSenasDeOtrasFechas', e);
        return [];
      }
    },

    // CLIENTES (autocompletado)
    async getClients() {
      try {
        const rows = await traerTodo(() =>
          db.from('clientes').select('nombre, telefono').order('nombre')
        );
        return rows.map(c => ({ name: c.nombre, phone: c.telefono }));
      } catch (e) {
        console.error('[SheetsAPI] getClients', e);
        return [];
      }
    },

    // CLIENTES con historial completo (todos los meses)
    async getClientesDetalle() {
      try {
        const [clientes, rows] = await Promise.all([
          traerTodo(() => db.from('clientes').select('nombre, telefono').order('nombre')),
          traerTodo(() => db.from('reservas').select(SELECT_RESERVA).order('fecha', { ascending: false }).order('hora_inicio', { ascending: false }))
        ]);
        const porTel = new Map();
        clientes.forEach(c => porTel.set(c.telefono, { name: c.nombre, phone: c.telefono, reservas: [] }));
        rows.map(mapReserva).forEach(r => {
          if (!porTel.has(r.phone)) porTel.set(r.phone, { name: r.name, phone: r.phone, reservas: [] });
          porTel.get(r.phone).reservas.push(r);
        });
        return { success: true, clientes: [...porTel.values()] };
      } catch (e) {
        return fail(e);
      }
    },

    // RESERVAS
    async makeReservation({ court, date, time, duration, name, phone, sena, tipoSena, estadoSena, origen }) {
      try {
        const cliente_id = await upsertCliente(name, phone);
        const { data, error } = await db.from('reservas').insert({
          cancha_id: court,
          cliente_id,
          fecha: date,
          hora_inicio: time,
          duracion: parseInt(duration) || 1,
          origen: origen || 'Dashboard',
          ...camposSena({ sena, tipoSena, estadoSena }),
        }).select('id').single();
        if (error) throw error;
        invalidarCache();
        return ok({ id: data.id });
      } catch (e) { return fail(e); }
    },

    async updateReservation({ recordId, court, date, time, duration, name, phone, notas, sena, tipoSena, estadoSena }) {
      try {
        const cliente_id = await upsertCliente(name, phone);
        const { error } = await db.from('reservas').update({
          cancha_id: court,
          cliente_id,
          fecha: date,
          hora_inicio: time,
          duracion: parseInt(duration) || 1,
          notas: notas || null,
          ...camposSena({ sena, tipoSena, estadoSena }),
        }).eq('id', recordId);
        if (error) throw error;
        invalidarCache();
        return ok();
      } catch (e) { return fail(e); }
    },

    async deleteReservation(recordId) {
      const { data, error } = await db.from('reservas').delete().eq('id', recordId).select('id');
      if (error) return fail(error);
      if (!data || !data.length) return { success: false, error: 'Solo un Admin puede eliminar reservas. Usá "Cancelar reserva".' };
      invalidarCache();
      return ok();
    },

    // Cancelar o marcar "No vino": la reserva queda registrada y libera la cancha.
    // devolverSena = true → la seña se devuelve y deja de contar como cobrada.
    async cancelReservation({ recordId, estado, motivo, devolverSena }) {
      const cambios = {
        estado:             estado === 'No vino' ? 'No vino' : 'Cancelada',
        motivo_cancelacion: (motivo || '').trim() || null,
      };
      if (devolverSena) cambios.estado_sena = 'Devuelta';
      const { error } = await db.from('reservas').update(cambios).eq('id', recordId);
      if (error) return fail(error);
      invalidarCache();
      return ok();
    },

    async updateSena({ recordId, estadoSena }) {
      const { error } = await db.from('reservas').update({ estado_sena: estadoSena }).eq('id', recordId);
      if (error) return fail(error);
      invalidarCache();
      return ok();
    },

    async confirmAttendance({ recordId, tipoPago, pagoRestante, pagoTransf }) {
      const { error } = await db.from('reservas').update({
        estado:             'Asistida',
        pago_restante:      num(pagoRestante),
        tipo_pago_restante: tipoPago || null,
        pago_restante_transf: tipoPago === 'Mixto' ? num(pagoTransf) : 0,
      }).eq('id', recordId);
      if (error) return fail(error);
      invalidarCache();
      return ok();
    },

    // CONTROL MENSUAL
    async getMonthlyStats(year, month) {
      try {
        const { desde, hasta } = monthRange(year, month);
        const iniTs = new Date(year, month - 1, 1).toISOString();
        const finTs = new Date(year, month, 1).toISOString();
        // Turnos del mes + señas cobradas en el mes para turnos de otros meses
        const rows = await traerTodo(() =>
          db.from('reservas').select(SELECT_RESERVA)
            .or(`and(fecha.gte.${desde},fecha.lt.${hasta}),and(sena_at.gte.${iniTs},sena_at.lt.${finTs})`)
            .order('fecha').order('hora_inicio')
        );
        const reservasCobro = rows.map(mapReserva);
        const reservas = reservasCobro.filter(r => r.date >= desde && r.date < hasta);
        return { stats: calcularCobros(reservasCobro, desde, hasta), reservas, reservasCobro };
      } catch (e) {
        console.error('[SheetsAPI] getMonthlyStats', e);
        return { error: mensajeError(e), stats: {}, reservas: [] };
      }
    },


    // EQUIPO (solo jefes; RLS lo hace cumplir)
    async getTeam() {
      let { data, error } = await db.from('empleados').select('email, nombre, rol, activo, ultimo_acceso').order('rol').order('email');
      if (error && /ultimo_acceso/.test(error.message || '')) {   // migración 005 todavía no corrida
        ({ data, error } = await db.from('empleados').select('email, nombre, rol, activo').order('rol').order('email'));
      }
      if (error) return { ...fail(error), team: [] };
      return ok({ team: data });
    },

    async saveTeamMember({ email, nombre, rol, activo }) {
      const { error } = await db.from('empleados').upsert({
        email: String(email).trim().toLowerCase(),
        nombre: nombre || null,
        rol,
        activo,
      }, { onConflict: 'email' });
      return error ? fail(error) : ok();
    },

    // Alta con usuario de login (Edge Function "alta-empleado")
    async altaEmpleado({ email, nombre, rol }) {
      const { data, error } = await db.functions.invoke('alta-empleado', {
        body: { accion: 'alta', email, nombre, rol },
      });
      if (error) return { success: false, error: await errorDeFuncion(error) };
      return ok(data);
    },

    async resetearPassword(email) {
      const { data, error } = await db.functions.invoke('alta-empleado', {
        body: { accion: 'resetear', email },
      });
      if (error) return { success: false, error: await errorDeFuncion(error) };
      return ok(data);
    },

    // HISTORIAL DE ACTIVIDAD (solo jefes)
    async getActividad({ desde, hasta }) {
      try {
        const rows = await traerTodo(() =>
          db.from('actividad').select('creado_at, usuario, email, accion, tabla, detalle')
            .gte('creado_at', desde).lt('creado_at', hasta)
            .order('creado_at', { ascending: false })
        );
        return ok({ actividad: rows });
      } catch (e) { return { ...fail(e), actividad: [] }; }
    },

    // TURNOS FIJOS
    async getTurnosFijos() {
      try {
        const { data, error } = await db.from('turnos_fijos')
          .select('id, cancha_id, dia_semana, hora_inicio, duracion, desde, hasta, activo, notas, creado_por, created_at, dado_de_baja_por, baja_at, cliente:clientes(nombre, telefono)')
          .order('activo', { ascending: false }).order('dia_semana').order('hora_inicio');
        if (error) throw error;
        return ok({ turnos: data.map(t => ({
          id: t.id, court: t.cancha_id, dia: t.dia_semana, time: hhmm(t.hora_inicio),
          duration: t.duracion, desde: t.desde, hasta: t.hasta, activo: t.activo, notas: t.notas || '',
          creadoPor: t.creado_por || '', creadoAt: t.created_at,
          bajaPor: t.dado_de_baja_por || '', bajaAt: t.baja_at,
          name: t.cliente?.nombre || '', phone: t.cliente?.telefono || '',
        })) });
      } catch (e) { return { ...fail(e), turnos: [] }; }
    },

    // Crea el turno fijo y las reservas de las próximas semanas.
    // La seña (si se cargó) se aplica a la primera fecha.
    async createTurnoFijo({ court, date, time, duration, name, phone, sena, tipoSena, estadoSena, hoy, hasta }) {
      try {
        const cliente_id = await upsertCliente(name, phone);
        const [y, m, d] = date.split('-').map(Number);
        const { data: tf, error } = await db.from('turnos_fijos').insert({
          cancha_id: court, cliente_id,
          dia_semana: new Date(y, m - 1, d).getDay(),
          hora_inicio: time, duracion: parseInt(duration) || 1, desde: date,
        }).select('id').single();
        if (error) {
          if (error.code === '23P01') throw { message: 'Ya hay otro turno fijo activo en esa cancha, ese día y horario.' };
          throw error;
        }
        const gen = await db.rpc('generar_turnos_fijos', { p_hoy: hoy, p_hasta: hasta || null, p_turno_id: tf.id });
        if (gen.error) throw gen.error;
        const conflictos = gen.data?.conflictos || [];
        const primeraLibre = !conflictos.some(c => c.fecha === date);
        if (primeraLibre && tipoSena && tipoSena !== 'Sin seña') {
          await db.from('reservas').update(camposSena({ sena, tipoSena, estadoSena }))
            .eq('turno_fijo_id', tf.id).eq('fecha', date);
        }
        invalidarCache();
        return ok({ id: tf.id, creadas: gen.data?.creadas || 0, conflictos });
      } catch (e) { return fail(e); }
    },

    // Crea las repeticiones que falten hasta la fecha "hasta" (tope: 1 año).
    async generarTurnosFijos(hoy, hasta) {
      const { data, error } = await db.rpc('generar_turnos_fijos', { p_hoy: hoy, p_hasta: hasta || null });
      if (error) { console.warn('[SheetsAPI] generarTurnosFijos', error.message); return { creadas: 0, error: error.message }; }
      if (data?.creadas) invalidarCache();
      return data || { creadas: 0 };
    },

    // Editar un turno fijo: mueve las repeticiones desde "desde" al horario nuevo
    async editTurnoFijo({ id, court, dia, time, duration, name, phone, notas, desde, hoy, hasta }) {
      try {
        const cliente_id = await upsertCliente(name, phone);
        const { data, error } = await db.rpc('editar_turno_fijo', {
          p_id: id, p_cancha: court, p_cliente_id: cliente_id, p_dia: parseInt(dia),
          p_hora: time, p_duracion: parseInt(duration) || 1, p_notas: notas || null,
          p_desde: desde || hoy, p_hoy: hoy, p_hasta: hasta || null,
        });
        if (error) {
          if (error.code === '23P01') throw { message: 'Ya hay otro turno fijo activo en esa cancha, ese día y horario.' };
          throw error;
        }
        invalidarCache();
        return ok({
          movidas: data?.movidas || 0, creadas: data?.creadas || 0,
          noMovidas: data?.no_movidas || [], conflictos: data?.conflictos || [],
        });
      } catch (e) { return fail(e); }
    },

    async bajaTurnoFijo(id, hoy) {
      const { data, error } = await db.rpc('baja_turno_fijo', { p_id: id, p_hoy: hoy });
      if (error) return fail(error);
      invalidarCache();
      return ok({ canceladas: data || 0 });
    },

    // PRESENCIA: quién tiene el panel abierto ahora
    startPresence(meta, onChange) {
      if (canalPresencia || !profile.email) return;
      estadoPresencia = { desde: new Date().toISOString(), ...meta };
      canalPresencia = db.channel('panel-en-linea', { config: { presence: { key: profile.email } } });
      const notificar = () => {
        const estado = canalPresencia.presenceState();
        const personas = Object.entries(estado).map(([email, metas]) => {
          // si alguien tiene varias pestañas, se toma la más reciente
          const m = metas.slice().sort((a, b) => (b.desde || '').localeCompare(a.desde || ''))[0] || {};
          return { email, nombre: m.nombre || email.split('@')[0], rol: m.rol || 'empleado',
                   vista: m.vista || '', desde: m.desde || '', pestanas: metas.length };
        });
        personas.sort((a, b) => a.nombre.localeCompare(b.nombre));
        onChange(personas);
      };
      canalPresencia
        .on('presence', { event: 'sync' }, notificar)
        .subscribe(async status => {
          if (status === 'SUBSCRIBED') {
            await canalPresencia.track(metaPresencia());
          }
        });
    },

    async updatePresence(meta) {
      estadoPresencia = { ...estadoPresencia, ...meta };
      if (!canalPresencia) return;
      try {
        await canalPresencia.track(metaPresencia());
      } catch (_) { /* reconectando */ }
    },

    async stopPresence() {
      if (!canalPresencia) return;
      try { await canalPresencia.untrack(); await db.removeChannel(canalPresencia); } catch (_) {}
      canalPresencia = null;
    },

    // EGRESOS
    async getEgresos({ year, month }) {
      try {
        const { desde, hasta } = monthRange(year, month);
        const rows = await traerTodo(() =>
          db.from('egresos').select('*')
            .gte('fecha', desde).lt('fecha', hasta)
            .order('fecha').order('created_at')
        );
        const egresos = rows.map(e => ({
          id:        e.id,
          fecha:     e.fecha,
          categoria: e.categoria,
          desc:      e.descripcion || '',
          monto:     num(e.monto),
          formaPago: e.forma_pago,
          notas:     e.notas || '',
          creadoPor: e.creado_por || '',
        }));
        const stats = { total: 0, efectivo: 0, transferencias: 0 };
        egresos.forEach(e => {
          stats.total += e.monto;
          if (e.formaPago === 'Efectivo') stats.efectivo += e.monto;
          else if (e.formaPago === 'Transferencia') stats.transferencias += e.monto;
        });
        return { stats, egresos };
      } catch (e) {
        console.error('[SheetsAPI] getEgresos', e);
        return { error: mensajeError(e), stats: {}, egresos: [] };
      }
    },

    async saveEgreso({ fecha, categoria, desc, monto, formaPago, notas }) {
      const { data, error } = await db.from('egresos').insert({
        fecha,
        categoria,
        descripcion: desc  || null,
        monto:       num(monto),
        forma_pago:  formaPago || 'Efectivo',
        notas:       notas || null,
      }).select('id').single();
      if (error) return fail(error);
      return ok({ id: data.id });
    },

    async deleteEgreso(id) {
      const { error } = await db.from('egresos').delete().eq('id', id);
      if (error) return fail(error);
      return ok();
    },
  };
})();
