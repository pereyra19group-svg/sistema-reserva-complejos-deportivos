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
    'estado, pago_restante, tipo_pago_restante, notas, origen, cliente:clientes(nombre, telefono)';

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
      notas:            r.notas || '',
      origen:           r.origen,
    };
  }

  // Lo cobrado = seña recibida + resto pagado al confirmar asistencia
  function calcularCobros(reservas) {
    const s = { totalBookings: reservas.length, ingresos: 0, transferencias: 0, efectivo: 0 };
    const sumar = (monto, medio) => {
      if (monto <= 0) return;
      s.ingresos += monto;
      if (medio === 'Transferencia') s.transferencias += monto;
      else if (medio === 'Efectivo') s.efectivo += monto;
    };
    reservas.forEach(r => {
      if (r.estadoSena === 'Recibida') sumar(r.sena, r.tipoSena);
      if (r.status === 'Asistida')     sumar(r.pagoRestante, r.tipoPagoRestante);
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
          : `El email ${email.trim().toLowerCase()} no está cargado en la tabla empleados (o está inactivo).` };
      }
      return ok();
    },

    async signOut() {
      await db.auth.signOut();
      invalidarCache();
    },

    async hasSession() {
      const { data } = await db.auth.getSession();
      return !!data.session && (await this.isEmployee());
    },

    async isEmployee() {
      return (await this.checkEmployee()).ok;
    },

    async checkEmployee() {
      const { data, error } = await db.from('empleados').select('email').eq('activo', true).limit(1);
      if (error) {
        console.error('[SheetsAPI] checkEmployee', error);
        return { ok: false, error: error.message || String(error) };
      }
      return { ok: data.length > 0 };
    },

    // GRILLA DEL DÍA
    async getAvailability(courtId, fecha) {
      try {
        const reservas = (await reservasDelDia(fecha)).filter(r => r.court === courtId);
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
      const { error } = await db.from('reservas').delete().eq('id', recordId);
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

    async confirmAttendance({ recordId, tipoPago, pagoRestante }) {
      const { error } = await db.from('reservas').update({
        estado:             'Asistida',
        pago_restante:      num(pagoRestante),
        tipo_pago_restante: tipoPago || null,
      }).eq('id', recordId);
      if (error) return fail(error);
      invalidarCache();
      return ok();
    },

    // CONTROL MENSUAL
    async getMonthlyStats(year, month) {
      try {
        const { desde, hasta } = monthRange(year, month);
        const rows = await traerTodo(() =>
          db.from('reservas').select(SELECT_RESERVA)
            .gte('fecha', desde).lt('fecha', hasta)
            .order('fecha').order('hora_inicio')
        );
        const reservas = rows.map(mapReserva);
        return { stats: calcularCobros(reservas), reservas };
      } catch (e) {
        console.error('[SheetsAPI] getMonthlyStats', e);
        return { error: mensajeError(e), stats: {}, reservas: [] };
      }
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
