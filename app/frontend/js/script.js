// ─────────────────────────────────────────────────────────
//  DASHBOARD — Panel de empleados Complejo Deportivo
// ─────────────────────────────────────────────────────────

// CONFIG
// Login: Supabase Auth (ver js/supabase-api.js). Ya no hay contraseña en el código.

// Canchas, precios y horarios se cargan de la base al iniciar sesión (loadConfig).
// Para cambiarlos: Equipo → Precios y horarios (jefes), o la tabla "canchas" en Supabase.
let COURTS     = [];   // [{ id, type, label, name, price }]
let PRICES     = {};   // { 'F5-1': 45000, ... } precio por hora de cada cancha
let TIME_SLOTS = [];   // ['09:00', ..., '23:00']
let HORARIO    = { apertura: 9, cierre: 24 };

const DIAS_LARGOS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

// STATE
let currentDate      = todayStr();
let matrixData       = {};  // { 'F5-1': ['10:00', ...], ... }
let bookingDetailsMap = {}; // { 'F5-1': { '10:00': { name, phone, price, ... } } }
let isLoading        = false;
let dashAutoRefresh  = null;
let lockedCourts     = {}; // { 'F5-1_2026-05-31': expiresAt } — protege reservas recién creadas
let clientesCache    = [];  // clientes cargados desde Airtable
let acActiveIndex    = -1;  // índice del item resaltado en autocomplete
let currentDetailInfo  = null; // info de la reserva en vista/edición
let currentDetailCourt = null; // cancha de la reserva en vista/edición
let selectedPayMethod  = '';   // método de pago del resto al confirmar asistencia
let currentView        = 'home'; // vista activa: home | dashboard | buffet | caja | monthly
let userRol            = 'empleado'; // 'empleado' | 'jefe' (viene de la tabla empleados)
let daySenasOtras      = [];  // señas cobradas en el día para turnos de otras fechas (entran en la caja)
let dayCanceladas      = [];  // reservas canceladas / "no vino" del día (para la caja)
let enLinea            = [];  // personas con el panel abierto ahora (presencia)
let accesoTimer        = null;
let fijosHasta         = '';  // hasta qué fecha ya están cargadas las repeticiones de los turnos fijos
const esJefe = () => userRol === 'jefe';
// —.——.— SIDEBAR MOBILE —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const main     = document.querySelector('.main');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (window.innerWidth <= 700) {
    sidebar.classList.remove('collapsed');
    main.classList.remove('sidebar-hidden');
    const isOpen = sidebar.classList.toggle('mobile-open');
    backdrop.classList.toggle('visible', isOpen);
  } else {
    sidebar.classList.remove('mobile-open');
    backdrop.classList.remove('visible');
    const isCollapsed = sidebar.classList.toggle('collapsed');
    main.classList.toggle('sidebar-hidden', isCollapsed);
  }
}

// —.——.— AUTH —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
async function doLogin() {
  const emailEl = document.getElementById('login-email');
  const passEl  = document.getElementById('login-pass');
  const btn     = document.getElementById('login-btn');
  const email   = emailEl.value.trim();
  const pass    = passEl.value;

  if (!email || !pass) return showLoginError('Completá email y contraseña.');

  btn.disabled    = true;
  btn.textContent = 'Ingresando...';
  const result = await SheetsAPI.signIn(email, pass);
  btn.disabled    = false;
  btn.textContent = 'Ingresar al panel';

  if (result.success) {
    showApp();
  } else {
    showLoginError(result.error || 'Email o contraseña incorrectos.');
    passEl.value = '';
    passEl.focus();
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.add('show');
}

function applyRole() {
  const p = SheetsAPI.getProfile();
  userRol = p.rol === 'jefe' ? 'jefe' : 'empleado';
  const nombre = p.nombre || p.email.split('@')[0] || 'Usuario';
  document.getElementById('sidebar-user-name').textContent   = nombre;
  document.getElementById('sidebar-user-avatar').textContent = nombre.charAt(0).toUpperCase();
  document.getElementById('sidebar-user-role').textContent   = esJefe() ? 'Jefe' : 'Empleado';
  document.querySelectorAll('.solo-jefe').forEach(el => { el.style.display = esJefe() ? '' : 'none'; });
  document.getElementById('nav-monthly').style.display = esJefe() ? '' : 'none';
  document.getElementById('nav-team').style.display    = esJefe() ? '' : 'none';
  document.getElementById('nav-actividad').style.display = esJefe() ? '' : 'none';
}

async function showApp() {
  applyRole();
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  await loadConfig();
  initDashboard();
}

async function doLogout() {
  if (dashAutoRefresh) { clearInterval(dashAutoRefresh); dashAutoRefresh = null; }
  if (accesoTimer)     { clearInterval(accesoTimer);     accesoTimer = null; }
  await SheetsAPI.signOut();
  location.reload();
}

// —.— CONFIGURACIÓN (canchas, precios, horarios) —.—
async function loadConfig() {
  const res = await SheetsAPI.getConfig();
  if (!res.success || !res.canchas.length) {
    showToast('No se pudieron cargar las canchas: ' + (res.error || 'la tabla está vacía'), true);
    return;
  }
  COURTS  = res.canchas.filter(c => c.activa !== false);
  PRICES  = Object.fromEntries(res.canchas.map(c => [c.id, c.price]));
  HORARIO = { apertura: res.apertura, cierre: res.cierre };
  TIME_SLOTS = [];
  for (let h = res.apertura; h < res.cierre; h++) TIME_SLOTS.push(`${pad(h)}:00`);
  fillTimeSelects();
}

// —.— Turnos fijos: que estén cargados en cualquier mes que se mire —.—
// Último día del mes de "fecha" + mesesExtra (formato YYYY-MM-DD)
function finDeMes(fecha, mesesExtra = 0) {
  const [y, m] = fecha.split('-').map(Number);
  const d = new Date(y, m + mesesExtra, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Genera las repeticiones de los turnos fijos hasta el fin del mes de "fecha" (si falta).
async function asegurarTurnosFijos(fecha) {
  const objetivo = finDeMes(fecha, 0);
  if (objetivo < todayStr() || (fijosHasta && objetivo <= fijosHasta)) return 0;
  const r = await SheetsAPI.generarTurnosFijos(todayStr(), objetivo);
  if (!r.error) fijosHasta = r.hasta && r.hasta < objetivo ? r.hasta : objetivo;
  if (r.creadas) Object.keys(monthStatsCache).forEach(k => delete monthStatsCache[k]);
  return r.creadas || 0;
}

// Precio total de una cancha por X horas (mismo cálculo que hace la base)
function courtPrice(courtId, duration = 1) {
  return (PRICES[courtId] || 0) * (parseInt(duration) || 1);
}

function fillTimeSelects() {
  ['m-time', 'e-time'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = (id === 'm-time' ? '<option value="">Elegir hora</option>' : '') +
      TIME_SLOTS.map(t => `<option value="${t}">${t}</option>`).join('');
    if (prev && TIME_SLOTS.includes(prev)) sel.value = prev;
  });
}

['login-email', 'login-pass'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
    document.getElementById('login-error').classList.remove('show');
  });
});

// Si ya hay una sesión válida de Supabase, entrar directo
window.addEventListener('DOMContentLoaded', async () => {
  if (await SheetsAPI.hasSession()) showApp();
});

// —.——.— INIT —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
async function initDashboard() {
  currentDate = todayStr();
  updateDateDisplay();
  document.getElementById('m-date').value = currentDate;
  initClientAutocomplete();
  loadClientesCache();
  startClock();
  renderMatrixSkeleton();
  // Quién está en línea + último acceso
  SheetsAPI.marcarAcceso();
  if (accesoTimer) clearInterval(accesoTimer);
  accesoTimer = setInterval(() => { if (!document.hidden) SheetsAPI.marcarAcceso(); }, 120000);
  SheetsAPI.startPresence({ vista: currentView }, personas => { enLinea = personas; renderPresence(); });
  // Carga las repeticiones de los turnos fijos (este mes y los 2 siguientes).
  // Si después se navega a un mes más adelante, se cargan en ese momento.
  await asegurarTurnosFijos(finDeMes(todayStr(), 2));
  loadMatrix();
  if (dashAutoRefresh) clearInterval(dashAutoRefresh);
  dashAutoRefresh = setInterval(() => {
    const now = Date.now();
    Object.keys(lockedCourts).forEach(k => { if (lockedCourts[k] <= now) delete lockedCourts[k]; });
    loadMatrix(true);
  }, 30000);
}

// —.——.— DATE HELPERS —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function pad(n) { return String(n).padStart(2,'0'); }

function formatDateLabel(str) {
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  const DAYS   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return `${DAYS[dt.getDay()]} ${d} de ${MONTHS[m-1]} de ${y}`;
}

function updateDateDisplay() {
  const isToday = currentDate === todayStr();
  document.getElementById('topbar-date').textContent = formatDateLabel(currentDate) + (isToday ? ' — Hoy' : '');
  document.getElementById('grid-date-label').textContent = formatDateLabel(currentDate);
  updateDateDisplayBtn();
}

function shiftDate(delta) {
  const [y, m, d] = currentDate.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + delta);
  currentDate = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
  updateDateDisplay();
  loadMatrix();
}

function goToday() {
  currentDate = todayStr();
  updateDateDisplay();
  loadMatrix();
}

// —.——.— CUSTOM DATE PICKER —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
let calPopupView = null;

function updateDateDisplayBtn() {
  const el = document.getElementById('date-display-text');
  if (!el) return;
  const [y, m, d] = currentDate.split('-').map(Number);
  el.textContent = `${pad(d)}/${pad(m)}/${y}`;
}

function toggleCalendarPopup() {
  const popup = document.getElementById('cal-popup');
  const btn   = document.getElementById('date-display-btn');
  if (popup.classList.contains('open')) {
    closeCalendarPopup();
  } else {
    const [y, m] = currentDate.split('-').map(Number);
    calPopupView = { year: y, month: m - 1 };
    popup.classList.add('open');
    btn.classList.add('open');
    renderCalendarPopup();
  }
}

function closeCalendarPopup() {
  document.getElementById('cal-popup').classList.remove('open');
  document.getElementById('date-display-btn').classList.remove('open');
}

function renderCalendarPopup() {
  const popup = document.getElementById('cal-popup');
  if (!popup.classList.contains('open') || !calPopupView) return;

  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const WEEK   = ['LU','MA','MI','JU','VI','SA','DO'];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { year, month } = calPopupView;
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const startOff = (firstDay.getDay() + 6) % 7;

  let daysHtml = '';
  for (let i = 0; i < startOff; i++) daysHtml += `<div class="dp-day dp-empty"></div>`;

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const date    = new Date(year, month, d);
    date.setHours(0, 0, 0, 0);
    const dateStr = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow     = (date.getDay() + 6) % 7;

    const isToday    = date.getTime() === today.getTime();
    const isSelected = currentDate === dateStr;
    const isWeekend  = dow >= 5;

    let cls = 'dp-day';
    if (isSelected)       cls += ' dp-selected';
    else if (isToday)     cls += ' dp-today';
    if (isWeekend && !isSelected) cls += ' dp-weekend';

    daysHtml += `<div class="${cls}" onclick="pickCalendarDate('${dateStr}')">${d}</div>`;
  }

  const MONTHS_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const [sy, sm, sd] = currentDate.split('-').map(Number);
  const selectedLabel = `${sd} de ${MONTHS_SHORT[sm-1]} de ${sy}`;

  popup.innerHTML = `
    <div class="dp-cal-header">
      <button class="dp-nav-btn" onclick="dpNav(-1)"><i class="fas fa-chevron-left"></i></button>
      <div class="dp-month-title">
        ${MONTHS[month]}
        <span class="dp-year-badge">${year}</span>
      </div>
      <button class="dp-nav-btn" onclick="dpNav(1)"><i class="fas fa-chevron-right"></i></button>
    </div>
    <div class="dp-weekdays">${WEEK.map(w => `<div class="dp-weekday">${w}</div>`).join('')}</div>
    <div class="dp-days">${daysHtml}</div>
    <div class="dp-footer">
      <div class="dp-footer-date"><i class="fas fa-calendar-check"></i>${selectedLabel}</div>
      <button class="dp-today-btn" onclick="dpGoToday()">Hoy</button>
    </div>`;
}

function dpNav(dir) {
  calPopupView.month += dir;
  if (calPopupView.month > 11) { calPopupView.month = 0; calPopupView.year++; }
  if (calPopupView.month < 0)  { calPopupView.month = 11; calPopupView.year--; }
  renderCalendarPopup();
}

function pickCalendarDate(dateStr) {
  currentDate = dateStr;
  updateDateDisplay();
  loadMatrix();
  closeCalendarPopup();
}

function dpGoToday() {
  currentDate = todayStr();
  const [y, m] = currentDate.split('-').map(Number);
  calPopupView = { year: y, month: m - 1 };
  updateDateDisplay();
  loadMatrix();
  renderCalendarPopup();
}

document.addEventListener('click', e => {
  const wrap = document.getElementById('date-picker-wrap');
  if (!wrap) return;
  const path = e.composedPath ? e.composedPath() : [];
  if (!path.includes(wrap)) closeCalendarPopup();
});

// —.——.— LOAD MATRIX —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
// silent=true: refresca en segundo plano sin skeleton ni indicador visual
async function loadMatrix(silent = false) {
  if (isLoading) return;
  isLoading = true;

  const refreshBtn = document.getElementById('refresh-btn');
  if (!silent) {
    document.getElementById('matrix-loading').style.display = 'flex';
    refreshBtn.innerHTML = '<i class="fas fa-arrows-rotate fa-spin"></i> Cargando...';
    renderMatrixSkeleton();
  }

  try {
    const fechaPedida = currentDate;
    await asegurarTurnosFijos(fechaPedida);   // si se navega a un mes nuevo, carga sus turnos fijos
    const [results, canceladas, senasOtras] = await Promise.all([
      Promise.all(
        COURTS.map(c => SheetsAPI.getAvailability(c.id, fechaPedida).then(r => ({
          id: c.id, booked: r.bookedSlots || [], details: r.bookingDetails || {}, hasError: !!r.error
        })))
      ),
      SheetsAPI.getCanceladasDelDia(fechaPedida),
      SheetsAPI.getSenasDeOtrasFechas(fechaPedida),
    ]);
    dayCanceladas = canceladas;
    daySenasOtras = senasOtras;
    // Preserve existing data for courts whose request failed or whose local state is locked
    // (recently created reservation — protects against stale GAS cached responses).
    const prevData    = matrixData;
    const prevDetails = bookingDetailsMap;
    matrixData        = {};
    bookingDetailsMap = {};
    const now = Date.now();
    results.forEach(r => {
      // Solo aplicar el bloqueo en refreshes silenciosos (auto-refresh).
      // Los refrescos manuales o post-edición siempre usan los datos de GAS.
      const isLocked = silent && (lockedCourts[`${r.id}_${currentDate}`] || 0) > now;
      if (!r.hasError && !isLocked) {
        matrixData[r.id]        = r.booked;
        bookingDetailsMap[r.id] = r.details;
      } else {
        matrixData[r.id]        = prevData[r.id]    || [];
        bookingDetailsMap[r.id] = prevDetails[r.id] || {};
      }
    });
  } catch(e) {
    if (!silent) showToast('Error al cargar disponibilidad.', true);
  }

  isLoading = false;
  if (!silent) {
    document.getElementById('matrix-loading').style.display = 'none';
    refreshBtn.innerHTML = '<i class="fas fa-arrows-rotate"></i> Actualizar';
  }

  renderMatrix();
  updateStats();
}

// —.——.— MATRIX RENDER —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function buildGridHeader() {
  let html = `<div class="mg-header corner-cell">Hora</div>`;
  COURTS.forEach(c => {
    html += `<div class="mg-header">
      <div class="court-badge-label">
        <span class="court-type-tag ${c.type.toLowerCase()}">${c.type}</span>${c.label}
      </div>
    </div>`;
  });
  return html;
}

function renderMatrixSkeleton() {
  const cols = `80px repeat(${COURTS.length}, minmax(110px, 1fr))`;
  let html = `<div class="matrix-grid" style="grid-template-columns:${cols}">` + buildGridHeader();
  TIME_SLOTS.forEach(() => {
    html += `<div class="mg-time-label">—</div>`;
    COURTS.forEach(() => {
      html += `<div class="mg-slot-cell"><div class="slot loading"></div></div>`;
    });
  });
  html += `</div>`;
  document.getElementById('matrix-wrap').innerHTML = html;
}

function renderMatrix() {
  const nowHour = new Date().getHours();
  const cols = `80px repeat(${COURTS.length}, minmax(110px, 1fr))`;
  let html = `<div class="matrix-grid" style="grid-template-columns:${cols}">` + buildGridHeader();
  TIME_SLOTS.forEach(t => {
    const isNow = (currentDate === todayStr()) && parseInt(t) === nowHour;
    html += `<div class="mg-time-label${isNow ? ' time-now' : ''}">${t.replace(':00','')}h</div>`;
    COURTS.forEach(c => {
      const booked     = matrixData[c.id] || [];
      const isBooked   = booked.includes(t);
      const info       = isBooked ? (bookingDetailsMap[c.id] || {})[t] : null;
      const isAsistida = info && info.status === 'Asistida';
      const hasSena    = info && (info.estadoSena || 'Pendiente') === 'Recibida';
      const cls        = isBooked ? (isAsistida ? 'asistida' : hasSena ? 'occupied' : 'no-sena') : 'free';
      const nowCls     = isNow ? ' now-col' : '';
      const click      = isBooked
        ? `onclick="showBookingDetail('${c.id}','${t}')"`
        : `onclick="quickBook('${c.id}','${c.type}','${t}')"`;
      const title      = isBooked
        ? (info?.name ? `${info.name} — ${isAsistida ? 'Asistió ✓' : hasSena ? 'Seña recibida' : 'Sin seña'} — ver detalles` : (isAsistida ? 'Asistida — ver detalles' : hasSena ? 'Seña recibida — ver detalles' : 'Sin seña — ver detalles'))
        : 'Disponible — click para reservar';
      let labelHtml;
      if (isBooked && info?.name) {
        const firstName  = info.name.split(' ')[0];
        const slotStatus = isAsistida ? 'asistió' : hasSena ? 'señado' : 'sin seña';
        labelHtml = `<span class="slot-name">${info.turnoFijoId ? '<i class="fas fa-repeat" style="font-size:9px;opacity:.75;margin-right:3px" title="Turno fijo"></i>' : ''}${escHtml(firstName)}</span><span class="slot-status">${slotStatus}</span>`;
      } else if (isBooked) {
        labelHtml = `<span class="slot-name">${isAsistida ? 'Asistida' : hasSena ? 'Reservado' : 'Sin seña'}</span>`;
      } else {
        labelHtml = `<span class="slot-name">Libre</span>`;
      }
      html += `<div class="mg-slot-cell"><div class="slot ${cls}${nowCls}" ${click} title="${title}">${labelHtml}</div></div>`;
    });
  });
  html += `</div>`;
  document.getElementById('matrix-wrap').innerHTML = html;
}

// —.——.— STATS —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function updateStats() {
  const totalBookings = getDayBookings().length;
  const { ingresos, transferencias, efectivo } = computeDayTotals(getCajaItems());

  // Fecha en el header
  const MONTHS_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const [sy, sm, sd] = currentDate.split('-').map(Number);
  document.getElementById('income-date-badge').textContent = `${sd} de ${MONTHS_SHORT[sm-1]} de ${sy}`;

  // CANCHAS
  document.getElementById('stat-canchas').textContent = totalBookings;
  document.getElementById('stat-canchas-sub').textContent =
    totalBookings === 1 ? '1 reserva del día' : `${totalBookings} reservas del día`;

  // INGRESOS
  document.getElementById('stat-ingresos').textContent = fmtCurrency(ingresos);
  document.getElementById('stat-ingresos-sub').textContent = ingresos > 0
    ? `de ${totalBookings} reserva${totalBookings !== 1 ? 's' : ''}`
    : 'sin señas cobradas aún';

  // TRANSFERENCIAS
  document.getElementById('stat-transferencias').textContent = fmtCurrency(transferencias);
  document.getElementById('stat-transf-sub').textContent = 'cobradas por transferencia';

  // EFECTIVO
  document.getElementById('stat-efectivo').textContent = fmtCurrency(efectivo);
  document.getElementById('stat-efectivo-sub').textContent = 'cobrado en mano';

  renderHome();
}

function animCount(id, target) {
  const el  = document.getElementById(id);
  const cur = parseInt(el.textContent) || 0;
  const step = Math.ceil(Math.abs(target - cur) / 12) || 1;
  let   val  = cur;
  const interval = setInterval(() => {
    val += val < target ? step : -step;
    if ((step > 0 && val >= target) || (step < 0 && val <= target)) { val = target; clearInterval(interval); }
    el.textContent = val;
  }, 30);
}

function fmtCurrency(v) {
  if (v === 0) return '$0';
  return '$' + v.toLocaleString('es-AR');
}

// —.——.— QUICK BOOK —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function quickBook(courtId, courtType, time) {
  openNewBookingModal();
  setTimeout(() => {
    document.getElementById('m-type').value = courtType;
    onTypeChange();
    setTimeout(() => {
      document.getElementById('m-court').value = courtId;
      document.getElementById('m-date').value  = currentDate;
      document.getElementById('m-time').value  = time;
      updatePricePreview();
    }, 50);
  }, 80);
}

// —.——.— AUTOCOMPLETE CLIENTES —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function initClientAutocomplete() {
  const input  = document.getElementById('m-name');
  const list   = document.getElementById('ac-list');

  input.addEventListener('input', () => {
    acActiveIndex = -1;
    renderAcList(input.value.trim());
  });

  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('.autocomplete-item');
    if (!list.classList.contains('open') || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acActiveIndex = Math.min(acActiveIndex + 1, items.length - 1);
      updateAcActive(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acActiveIndex = Math.max(acActiveIndex - 1, 0);
      updateAcActive(items);
    } else if (e.key === 'Enter') {
      if (acActiveIndex >= 0 && items[acActiveIndex]) {
        e.preventDefault();
        items[acActiveIndex].click();
      }
    } else if (e.key === 'Escape') {
      closeAcList();
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.autocomplete-wrap')) closeAcList();
  });
}

function updateAcActive(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === acActiveIndex));
  if (acActiveIndex >= 0) items[acActiveIndex].scrollIntoView({ block: 'nearest' });
}

function renderAcList(query) {
  const list = document.getElementById('ac-list');
  if (!query || !clientesCache.length) { closeAcList(); return; }

  const q = query.toLowerCase();
  const matches = clientesCache.filter(c =>
    c.name.toLowerCase().includes(q) || c.phone.includes(q)
  ).slice(0, 8);

  if (!matches.length) { closeAcList(); return; }

  const hl = text => text.replace(
    new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
    m => `<span class="autocomplete-match">${m}</span>`
  );

  list.innerHTML = matches.map(c =>
    `<div class="autocomplete-item">
      <span class="autocomplete-name">${hl(c.name)}</span>
      <span class="autocomplete-phone">${c.phone}</span>
    </div>`
  ).join('');

  list.querySelectorAll('.autocomplete-item').forEach((el, i) => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      selectClient(matches[i].name, matches[i].phone);
    });
  });

  list.classList.add('open');
}

function selectClient(name, phone) {
  document.getElementById('m-name').value  = name;
  document.getElementById('m-phone').value = phone;
  closeAcList();
  document.getElementById('m-phone').focus();
}

function closeAcList() {
  document.getElementById('ac-list').classList.remove('open');
  acActiveIndex = -1;
}

async function loadClientesCache() {
  clientesCache = await SheetsAPI.getClients();
}

// —.——.— MODAL —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function openNewBookingModal() {
  clearModalAlert();
  const confirmBtn = document.getElementById('confirm-booking-btn');
  confirmBtn.style.display = '';
  confirmBtn.disabled      = false;
  confirmBtn.innerHTML     = '<i class="fas fa-circle-check"></i> Confirmar reserva';
  document.getElementById('m-date').value     = currentDate;
  document.getElementById('m-duration').value = '1';
  document.getElementById('m-name').value     = '';
  document.getElementById('m-phone').value    = '';
  document.getElementById('m-sena').value     = '';
  document.getElementById('m-tipo-sena').value = 'Sin seña';
  document.getElementById('m-sena-estado-wrap').style.display = 'none';
  document.getElementById('m-fijo').checked = false;
  onFijoChange();
  closeAcList();
  updatePricePreview();
  document.getElementById('booking-modal-overlay').classList.add('open');
  document.getElementById('m-name').focus();
}

function closeNewBookingModal() {
  document.getElementById('booking-modal-overlay').classList.remove('open');
  clearModalAlert();
}

document.getElementById('booking-modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeNewBookingModal();
});

function onTypeChange() {
  const type = document.getElementById('m-type').value;
  const courtSel = document.getElementById('m-court');
  courtSel.innerHTML = '';
  if (!type) {
    courtSel.innerHTML = '<option value="">— primero elegí tipo —</option>';
    return;
  }
  const courts = COURTS.filter(c => c.type === type);
  courts.forEach(c => {
    const opt = document.createElement('option');
    opt.value       = c.id;
    opt.textContent = `${c.id} — ${c.label}`;
    courtSel.appendChild(opt);
  });
  updatePricePreview();
}

function updatePricePreview() {
  renderPricePreview('m-court', 'm-duration', 'price-preview', 'price-preview-val');
}

// Muestra el precio de la cancha elegida (sale de la base, igual que el que se cobra)
function renderPricePreview(courtSelId, durSelId, boxId, valId) {
  const court = document.getElementById(courtSelId).value;
  const dur   = parseInt(document.getElementById(durSelId).value) || 1;
  if (!court || PRICES[court] == null) { document.getElementById(boxId).style.display = 'none'; return; }
  const hora = PRICES[court];
  document.getElementById(boxId).style.display = 'flex';
  document.getElementById(valId).textContent =
    '$' + (hora * dur).toLocaleString('es-AR') + (dur > 1 ? ` (${dur} hs × $${hora.toLocaleString('es-AR')})` : '');
}

function onFijoChange() {
  const fijo = document.getElementById('m-fijo').checked;
  const date = document.getElementById('m-date').value;
  const hint = document.getElementById('m-fijo-hint');
  if (!hint) return;
  if (!fijo) { hint.textContent = 'Se repite todas las semanas el mismo día y horario.'; return; }
  const dia = date ? DIAS_LARGOS[new Date(date + 'T12:00:00').getDay()].toLowerCase() : 'el día elegido';
  hint.textContent = `Se reserva todos los ${dia} a la misma hora, todos los meses, desde esta fecha hasta que lo des de baja.`;
}

async function submitNewBooking() {
  clearModalAlert();

  const court    = document.getElementById('m-court').value;
  const date     = document.getElementById('m-date').value;
  const time     = document.getElementById('m-time').value;
  const duration = parseInt(document.getElementById('m-duration').value) || 1;
  const name     = document.getElementById('m-name').value.trim();
  const phone    = document.getElementById('m-phone').value.trim();
  const sena       = parseFloat(document.getElementById('m-sena').value) || 0;
  const tipoSena   = document.getElementById('m-tipo-sena').value || 'Sin seña';
  const estadoSena = tipoSena === 'Sin seña' ? 'Pendiente' : (document.getElementById('m-estado-sena').value || 'Pendiente');

  if (!court)  return showModalAlert('Seleccioná una cancha.');
  if (!date)   return showModalAlert('Seleccioná una fecha.');
  if (!time)   return showModalAlert('Seleccioná un horario.');
  if (!name)   return showModalAlert('Ingresá el nombre del cliente.');
  if (!phone)  return showModalAlert('Ingresá el WhatsApp del cliente.');

  const btn = document.getElementById('confirm-booking-btn');
  btn.disabled    = true;
  btn.innerHTML   = '<i class="fas fa-spinner fa-spin"></i> Procesando...';

  if (document.getElementById('m-fijo').checked) {
    const r = await SheetsAPI.createTurnoFijo({ court, date, time, duration, name, phone, sena, tipoSena, estadoSena,
                                               hoy: todayStr(), hasta: fijosHasta > finDeMes(date, 2) ? fijosHasta : finDeMes(date, 2) });
    if (!r.success) {
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-circle-check"></i> Confirmar reserva';
      return showModalAlert(r.error || 'No se pudo crear el turno fijo.');
    }
    btn.style.display = 'none';
    if (!clientesCache.some(c => c.phone === phone)) clientesCache.push({ name, phone });
    if (date !== currentDate) { currentDate = date; updateDateDisplay(); }
    loadMatrix();
    if (r.conflictos.length) {
      const lista = r.conflictos.map(c => fmtFechaCorta(c.fecha)).join(', ');
      showModalAlert(`Turno fijo creado (${r.creadas} fecha${r.creadas === 1 ? '' : 's'} reservada${r.creadas === 1 ? '' : 's'}). ` +
        `Estas fechas ya estaban ocupadas y quedaron sin reservar: ${lista}.`, true);
    } else {
      showModalAlert(`¡Turno fijo creado! Queda reservado todas las semanas, todos los meses, hasta que lo des de baja.`, false);
      setTimeout(() => closeNewBookingModal(), 2200);
    }
    showToast(`Turno fijo: ${DIAS_LARGOS[new Date(date + 'T12:00:00').getDay()]} ${time} — ${name}`);
    return;
  }

  const result = await SheetsAPI.makeReservation({ court, date, time, duration, name, phone, sena, tipoSena, estadoSena, origen: 'Dashboard' });

  if (result.success) {
    btn.style.display = 'none';
    // Actualización inmediata en memoria para feedback instantáneo
    if (!matrixData[court])        matrixData[court]        = [];
    if (!bookingDetailsMap[court]) bookingDetailsMap[court] = {};
    const startIdx    = TIME_SLOTS.indexOf(time);
    const ahora       = new Date().toISOString();
    const bookingInfo = { name, phone, price: courtPrice(court, duration), startTime: time, duration, status: 'Confirmada', sena, tipoSena, estadoSena, recordId: result.id,
                          creadaPor: yoNombre(), creadaAt: ahora,
                          ...(estadoSena === 'Recibida' && tipoSena !== 'Sin seña' ? { senaPor: yoNombre(), senaAt: ahora } : {}) };
    for (let i = 0; i < duration; i++) {
      const slot = TIME_SLOTS[startIdx + i];
      if (slot && !matrixData[court].includes(slot)) {
        matrixData[court].push(slot);
        bookingDetailsMap[court][slot] = bookingInfo;
      }
    }
    // Navegar a la fecha de la reserva y renderizar inmediatamente
    if (date !== currentDate) {
      currentDate = date;
      updateDateDisplay();
    }
    renderMatrix();
    updateStats();

    // Bloquear este turno por 90 segundos para que el auto-refresh no sobreescriba
    // con datos cacheados de GAS que aún no incluyen esta reserva.
    lockedCourts[`${court}_${date}`] = Date.now() + 90000;

    showModalAlert('¡Reserva confirmada exitosamente!', false);
    showToast(`Reserva registrada: ${court} — ${time} — ${name}`);
    if (!clientesCache.some(c => c.phone === phone)) {
      clientesCache.push({ name, phone });
    }
    setTimeout(() => closeNewBookingModal(), 2000);
  } else {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-circle-check"></i> Confirmar reserva';
    showModalAlert(result.error || 'Error al procesar la reserva. Intentá de nuevo.', true);
  }
}

function showModalAlert(msg, isError = true) {
  const el = document.getElementById('modal-alert');
  el.textContent = msg;
  el.className   = 'modal-alert ' + (isError ? 'error' : 'success');
  el.style.display = 'flex';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearModalAlert() {
  const el = document.getElementById('modal-alert');
  el.style.display = 'none';
  el.className = 'modal-alert';
}

// —.——.— TOAST —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function showToast(msg, isError = false) {
  const ct   = document.getElementById('toast-container');
  const div  = document.createElement('div');
  div.className = 'toast' + (isError ? ' toast-error' : '');
  div.innerHTML = `<i class="fas ${isError ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i> ${escHtml(msg)}`;
  ct.appendChild(div);
  setTimeout(() => {
    div.style.animation = 'slideOut .25s forwards';
    setTimeout(() => div.remove(), 280);
  }, 3500);
}

// —.——.— BOOKING DETAIL MODAL —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function showBookingDetail(courtId, slot) {
  const info  = (bookingDetailsMap[courtId] || {})[slot];
  const court = COURTS.find(c => c.id === courtId);
  const dateLabel = formatDateLabel(currentDate);

  currentDetailInfo  = info || null;
  currentDetailCourt = courtId;
  hideDeleteConfirm();
  hideCancelConfirm();
  document.getElementById('confirm-section').style.display = 'none';

  // Cancelar: todos. Eliminar: solo jefes (para cargas por error; queda en el historial).
  document.getElementById('detail-action-edit').style.display   = info ? '' : 'none';
  document.getElementById('detail-action-cancel').style.display = info && info.status === 'Confirmada' ? '' : 'none';
  document.getElementById('detail-action-delete').style.display = info && esJefe() ? '' : 'none';

  document.getElementById('detail-subtitle').textContent = court ? court.name + ' — ' + court.label : courtId;
  document.getElementById('detail-when').innerHTML = `<span><i class="fas fa-calendar-day"></i> ${escHtml(dateLabel)}</span>`;

  // Botones de seña
  const senaActionsEl = document.getElementById('sena-actions');
  if (info && (info.estadoSena || 'Pendiente') !== 'Recibida') {
    const waPhone = waNumber(info.phone);
    const waMsg   = encodeURIComponent(
      `Hola ${info.name || ''}! Te recordamos que tu reserva del ${dateLabel} a las ${info.startTime}hs necesita seña para confirmarse. Podés pagarla en efectivo en el complejo o transferir y mandarnos el comprobante. ¡Gracias!`
    );
    let senaHtml = `<button class="btn-sena-ok" id="btn-mark-sena" onclick="markSenaReceived()"><i class="fas fa-circle-check"></i> Marcar seña recibida</button>`;
    if ((info.tipoSena || '') === 'Transferencia' && waPhone) {
      senaHtml += `<a class="btn-wa-sena" href="https://wa.me/${waPhone}?text=${waMsg}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Pedir comprobante</a>`;
    }
    senaActionsEl.innerHTML     = senaHtml;
    senaActionsEl.style.display = 'flex';
  } else {
    senaActionsEl.innerHTML     = '';
    senaActionsEl.style.display = 'none';
  }

  if (!info) {
    document.getElementById('detail-body').innerHTML =
      `<p style="color:var(--text-muted);font-size:14px;padding:8px 0">Sin información disponible.</p>`;
    document.getElementById('detail-modal-overlay').classList.add('open');
    return;
  }

  const endIdx     = TIME_SLOTS.indexOf(info.startTime) + info.duration;
  const endTime    = TIME_SLOTS[endIdx] ? TIME_SLOTS[endIdx] : `${parseInt(info.startTime) + info.duration}:00`;
  const totalPrice = info.price || courtPrice(courtId, info.duration);
  const tipoSena   = info.tipoSena   || 'Sin seña';
  const estadoSena = info.estadoSena || 'Pendiente';
  const senaMonto  = info.sena || 0;

  const senaMostrar = tipoSena === 'Sin seña'
    ? 'Sin seña'
    : (senaMonto > 0 ? `$${senaMonto.toLocaleString('es-AR')} · ${tipoSena}` : tipoSena);

  const restaPagar = Math.max(0, totalPrice - senaMonto);
  const asistida   = info.status === 'Asistida';
  const waPhoneD   = info.phone && info.phone !== '—' ? waNumber(info.phone) : '';
  const telD       = (info.phone || '').replace(/[^\d+]/g, '');
  const inicial    = (info.name || '?').trim().charAt(0).toUpperCase();
  const senaOk     = estadoSena === 'Recibida';

  document.getElementById('detail-when').innerHTML = `
    <span><i class="fas fa-calendar-day"></i> ${escHtml(dateLabel)}</span>
    <span><i class="fas fa-clock"></i> ${escHtml(info.startTime)} a ${escHtml(endTime)} hs</span>
    <span class="status-pill"><i class="fas ${asistida ? 'fa-circle-check' : 'fa-calendar-check'}"></i> ${escHtml(info.status || 'Confirmada')}</span>
    ${info.turnoFijoId ? '<span class="status-pill"><i class="fas fa-repeat"></i> Turno fijo</span>' : ''}`;

  const money = (icon, label, value) =>
    `<div class="dt-money-row"><span><i class="fas ${icon}"></i> ${label}</span><b>${value}</b></div>`;

  const html = `
    <div class="dt-client">
      <div class="dt-avatar">${escHtml(inicial)}</div>
      <div class="dt-client-info">
        <div class="dt-client-name">${escHtml(info.name || '—')}</div>
        <div class="dt-client-phone"><i class="fas fa-phone" style="font-size:11px"></i> ${escHtml(info.phone || '—')}</div>
      </div>
      ${waPhoneD ? `<div class="dt-contact">
        <a href="https://wa.me/${waPhoneD}" target="_blank" rel="noopener" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>
        <a href="tel:${telD}" title="Llamar"><i class="fas fa-phone"></i></a>
      </div>` : ''}
    </div>

    <div class="dt-stats">
      <div class="dt-stat"><div class="dt-stat-label"><i class="fas fa-hourglass-half"></i> Duración</div>
        <div class="dt-stat-value">${info.duration} hora${info.duration > 1 ? 's' : ''}</div></div>
      <div class="dt-stat"><div class="dt-stat-label"><i class="fas fa-flag-checkered"></i> Horario</div>
        <div class="dt-stat-value">${escHtml(info.startTime)} – ${escHtml(endTime)}</div></div>
      <div class="dt-stat"><div class="dt-stat-label"><i class="fas fa-hand-holding-dollar"></i> Seña</div>
        <div style="margin-top:6px"><span class="sena-badge ${senaOk ? 'recibida' : 'pendiente'}"><i class="fas ${senaOk ? 'fa-circle-check' : 'fa-clock'}"></i> ${tipoSena === 'Sin seña' ? 'Sin seña' : (senaOk ? 'Recibida' : 'Pendiente')}</span></div></div>
    </div>

    <div class="dt-money">
      ${money('fa-tag', 'Costo total', '$' + totalPrice.toLocaleString('es-AR'))}
      ${tipoSena !== 'Sin seña' ? money('fa-hand-holding-dollar', 'Seña · ' + escHtml(tipoSena), '$' + senaMonto.toLocaleString('es-AR')) : ''}
      <div class="dt-money-total"><span>${asistida ? 'Reserva saldada' : 'Resta pagar'}</span><b>${asistida ? '$' + totalPrice.toLocaleString('es-AR') : '$' + restaPagar.toLocaleString('es-AR')}</b></div>
    </div>
    ${info.notas ? `<div class="dt-notes"><i class="fas fa-note-sticky"></i>${escHtml(info.notas)}</div>` : ''}
    ${auditTrailHtml(info)}`;

  document.getElementById('detail-body').innerHTML = html;

  // Confirm attendance section
  const confirmSection = document.getElementById('confirm-section');
  if (info.status === 'Asistida') {
    confirmSection.innerHTML = `
      <div style="background:var(--brand-50);border:1px solid var(--brand-200);border-radius:16px;padding:12px 14px;display:flex;align-items:center;gap:12px">
        <i class="fas fa-circle-check" style="color:var(--green);font-size:22px;flex-shrink:0"></i>
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--brand-800)">Asistencia confirmada</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${
            info.tipoPagoRestante === 'Transferencia' ? 'El cliente asistió y completó el pago en transferencia.' :
            info.tipoPagoRestante === 'Efectivo'      ? 'El cliente asistió y completó el pago en efectivo.' :
            info.tipoPagoRestante === 'Mixto'         ? `El cliente asistió y pagó $${(parseFloat(info.pagoRestanteTransf) || 0).toLocaleString('es-AR')} por transferencia y $${((parseFloat(info.pagoRestante) || 0) - (parseFloat(info.pagoRestanteTransf) || 0)).toLocaleString('es-AR')} en efectivo.` :
                                                        'El cliente asistió y completó el pago.'
          }</div>
        </div>
      </div>`;
    confirmSection.style.display = '';
  } else {
    selectedPayMethod = '';
    const restaPagar = Math.max(0, totalPrice - senaMonto);
    const restaHtml  = restaPagar > 0
      ? `<div style="margin-bottom:14px">
           <div style="font-size:11px;font-weight:700;color:var(--brand-800);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Cobrar al cliente</div>
           <div style="font-size:28px;font-weight:800;color:var(--green)">$${restaPagar.toLocaleString('es-AR')}</div>
           <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Total $${totalPrice.toLocaleString('es-AR')} Seña $${senaMonto.toLocaleString('es-AR')}</div>
         </div>
         <div style="margin-bottom:6px">
           <div style="font-size:11px;font-weight:700;color:var(--brand-800);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Forma de pago del resto</div>
           <div class="pay-method-row">
             <button type="button" class="pay-method-btn" id="pay-transf" onclick="selectPayMethod('Transferencia')">
               <i class="fas fa-mobile-screen-button"></i> Transferencia
             </button>
             <button type="button" class="pay-method-btn" id="pay-efect" onclick="selectPayMethod('Efectivo')">
               <i class="fas fa-money-bill-wave"></i> Efectivo
             </button>
           </div>
           <div class="pay-method-row">
             <button type="button" class="pay-method-btn" id="pay-mixto" onclick="selectPayMethod('Mixto')">
               <i class="fas fa-shuffle"></i> Mitad y mitad (efectivo + transferencia)
             </button>
           </div>
           <div class="pay-mixto-box" id="pay-mixto-box" style="display:none">
             <div class="pay-mixto-row"><span><i class="fas fa-mobile-screen-button"></i> Por transferencia</span>
               <input type="number" id="pay-mixto-transf" min="0" max="${restaPagar}" step="any" inputmode="decimal" placeholder="$0" oninput="updateMixto()"></div>
             <div class="pay-mixto-row"><span><i class="fas fa-money-bill-wave"></i> En efectivo</span>
               <b id="pay-mixto-efect">$${restaPagar.toLocaleString('es-AR')}</b></div>
           </div>
         </div>`
      : `<div style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">La reserva está completamente cubierta por la seña.</div>`;
    const needsMethod = restaPagar > 0;
    confirmSection.innerHTML = `
      <div style="background:var(--brand-50);border:1px solid var(--brand-200);border-radius:16px;padding:14px">
        <div style="font-size:11px;font-weight:700;color:var(--brand-800);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;display:flex;align-items:center;gap:6px">
          <i class="fas fa-futbol"></i> Confirmar asistencia y pago
        </div>
        ${restaHtml}
        <button class="btn-confirm-attendance" id="btn-confirm-attendance" onclick="confirmAttendance()" ${needsMethod ? 'disabled' : ''}>
          <i class="fas fa-circle-check"></i> Confirmar cancha
        </button>
      </div>`;
    confirmSection.style.display = '';
  }

  document.getElementById('detail-modal-overlay').classList.add('open');
}

function closeDetailModal() {
  document.getElementById('detail-modal-overlay').classList.remove('open');
  hideDeleteConfirm();
}

document.getElementById('detail-modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDetailModal();
});

// —.——.— EDIT MODAL —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function openEditFromDetail() {
  if (!currentDetailInfo) return;
  const info     = currentDetailInfo;
  const courtId  = currentDetailCourt;
  const courtType = courtId.startsWith('F7') ? 'F7' : 'F5';

  closeDetailModal();
  clearEditModalAlert();

  document.getElementById('e-type').value = courtType;
  onEditTypeChange();

  setTimeout(() => {
    document.getElementById('e-court').value    = courtId;
    document.getElementById('e-date').value     = currentDate;
    document.getElementById('e-time').value     = info.startTime;
    document.getElementById('e-duration').value = String(info.duration);
    document.getElementById('e-name').value     = info.name !== '—' ? info.name : '';
    document.getElementById('e-phone').value    = info.phone !== '—' ? info.phone : '';
    document.getElementById('e-notas').value    = info.notas || '';
    // Seña
    const senaVal      = info.sena || 0;
    const tipoSenaVal  = info.tipoSena   || 'Sin seña';
    const estadoSenaVal = info.estadoSena || 'Pendiente';
    document.getElementById('e-sena').value      = senaVal > 0 ? senaVal : '';
    document.getElementById('e-tipo-sena').value = tipoSenaVal;
    onSenaTipoChange('e');
    if (tipoSenaVal !== 'Sin seña') {
      document.getElementById('e-estado-sena').value = estadoSenaVal;
    }
    updateEditPricePreview();
  }, 50);

  document.getElementById('edit-modal-overlay').classList.add('open');
}

function closeEditModal() {
  document.getElementById('edit-modal-overlay').classList.remove('open');
  clearEditModalAlert();
}

document.getElementById('edit-modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeEditModal();
});

function onEditTypeChange() {
  const type     = document.getElementById('e-type').value;
  const courtSel = document.getElementById('e-court');
  courtSel.innerHTML = '';
  COURTS.filter(c => c.type === type).forEach(c => {
    const opt = document.createElement('option');
    opt.value       = c.id;
    opt.textContent = `${c.id} — ${c.label}`;
    courtSel.appendChild(opt);
  });
  updateEditPricePreview();
}

function updateEditPricePreview() {
  renderPricePreview('e-court', 'e-duration', 'edit-price-preview', 'edit-price-preview-val');
}

async function submitEditBooking() {
  clearEditModalAlert();
  const recordId   = currentDetailInfo?.recordId;
  const court      = document.getElementById('e-court').value;
  const date       = document.getElementById('e-date').value;
  const time       = document.getElementById('e-time').value;
  const duration   = parseInt(document.getElementById('e-duration').value) || 1;
  const name       = document.getElementById('e-name').value.trim();
  const phone      = document.getElementById('e-phone').value.trim();
  const notas      = document.getElementById('e-notas').value.trim();
  const sena       = parseFloat(document.getElementById('e-sena').value) || 0;
  const tipoSena   = document.getElementById('e-tipo-sena').value || 'Sin seña';
  const estadoSena = tipoSena === 'Sin seña' ? 'Pendiente' : (document.getElementById('e-estado-sena').value || 'Pendiente');

  if (!recordId) return showEditModalAlert('Error: sin ID de reserva.');
  if (!court)    return showEditModalAlert('Seleccioná una cancha.');
  if (!date)     return showEditModalAlert('Seleccioná una fecha.');
  if (!time)     return showEditModalAlert('Seleccioná un horario.');
  if (!name)     return showEditModalAlert('Ingresá el nombre del cliente.');
  if (!phone)    return showEditModalAlert('Ingresá el WhatsApp del cliente.');

  const btn = document.getElementById('save-edit-btn');
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';

  const result = await SheetsAPI.updateReservation({ recordId, court, date, time, duration, name, phone, notas, sena, tipoSena, estadoSena });

  btn.disabled  = false;
  btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar cambios';

  if (result.success) {
    showToast(`Reserva actualizada: ${name} — ${time}`);
    closeEditModal();
    loadMatrix();
  } else {
    showEditModalAlert(result.error || 'Error al guardar los cambios.');
  }
}

function showEditModalAlert(msg, isError = true) {
  const el = document.getElementById('edit-modal-alert');
  el.textContent = msg;
  el.className   = 'modal-alert ' + (isError ? 'error' : 'success');
  el.style.display = 'flex';
}

function clearEditModalAlert() {
  const el = document.getElementById('edit-modal-alert');
  el.style.display = 'none';
  el.className = 'modal-alert';
}

// —.——.— DELETE —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function showDeleteConfirm() {
  hideCancelConfirm();
  document.getElementById('delete-confirm-bar').classList.add('show');
}

function hideDeleteConfirm() {
  document.getElementById('delete-confirm-bar').classList.remove('show');
}

async function executeDelete() {
  const recordId = currentDetailInfo?.recordId;
  if (!recordId) return;

  const btn = document.getElementById('delete-confirm-btn');
  btn.textContent = 'Eliminando...';
  btn.disabled    = true;

  const result = await SheetsAPI.deleteReservation(recordId);

  btn.textContent = 'Sí, eliminar';
  btn.disabled    = false;

  if (result.success) {
    // Eliminar de la memoria local
    if (currentDetailCourt) {
      Object.keys(bookingDetailsMap[currentDetailCourt] || {}).forEach(slot => {
        if ((bookingDetailsMap[currentDetailCourt][slot] || {}).recordId === recordId) {
          delete bookingDetailsMap[currentDetailCourt][slot];
          matrixData[currentDetailCourt] = (matrixData[currentDetailCourt] || []).filter(s => s !== slot);
        }
      });
    }
    renderMatrix();
    updateStats();
    closeDetailModal();
    showToast('Reserva eliminada correctamente.');
  } else {
    showToast(result.error || 'No se pudo eliminar.', true);
    btn.textContent = 'Error — reintentar';
    setTimeout(() => { btn.textContent = 'Sí, eliminar'; }, 2000);
  }
}

// —.——.— CANCELAR / NO VINO —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
// La reserva no se borra: queda registrada como "Cancelada" o "No vino" y libera la cancha.
// Si tenía seña cobrada se elige si queda para el complejo (sigue en la caja) o se devuelve.
function showCancelConfirm() {
  const info = currentDetailInfo;
  if (!info) return;
  hideDeleteConfirm();
  const senaCobrada = info.estadoSena === 'Recibida' && (parseFloat(info.sena) || 0) > 0;
  document.getElementById('cancel-sena-wrap').style.display = senaCobrada ? '' : 'none';
  document.getElementById('cancel-sena-monto').textContent = fmtCurrency(parseFloat(info.sena) || 0);
  document.querySelector('input[name="cancel-tipo"][value="Cancelada"]').checked = true;
  document.querySelector('input[name="cancel-sena"][value="retener"]').checked  = true;
  // "No vino" solo tiene sentido para hoy o días anteriores
  const yaPaso = currentDate <= todayStr();
  document.getElementById('cancel-novino-opt').style.display = yaPaso ? '' : 'none';
  document.getElementById('cancel-motivo').value = '';
  document.getElementById('cancel-confirm-bar').classList.add('show');
}

function hideCancelConfirm() {
  document.getElementById('cancel-confirm-bar')?.classList.remove('show');
}

async function executeCancel() {
  const info = currentDetailInfo;
  if (!info?.recordId) return;
  const estado       = document.querySelector('input[name="cancel-tipo"]:checked')?.value || 'Cancelada';
  const devolverSena = document.getElementById('cancel-sena-wrap').style.display !== 'none' &&
                       document.querySelector('input[name="cancel-sena"]:checked')?.value === 'devolver';
  const motivo = document.getElementById('cancel-motivo').value;

  const btn = document.getElementById('cancel-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  const r = await SheetsAPI.cancelReservation({ recordId: info.recordId, estado, motivo, devolverSena });
  btn.disabled = false;
  btn.textContent = 'Confirmar';

  if (!r.success) return showToast(r.error || 'No se pudo cancelar la reserva.', true);
  closeDetailModal();
  showToast(estado === 'No vino' ? `Marcado: ${info.name} no vino.` : `Reserva cancelada: ${info.name}.`);
  loadMatrix(true);
}

// Quién hizo cada cosa con esta reserva (lo registra la base automáticamente)
function auditTrailHtml(info) {
  const items = [];
  const add = (icon, txt, por, at) => {
    if (!por) return;
    items.push(`<li><i class="fas ${icon}"></i><span>${txt} <b>${escHtml(por)}</b>${at ? ` <small>${escHtml(fmtFechaHora(at))}</small>` : ''}</span></li>`);
  };
  add(info.turnoFijoId ? 'fa-repeat' : 'fa-plus', info.turnoFijoId ? 'Turno fijo generado por' : 'Creada por', info.creadaPor, info.creadaAt);
  add('fa-hand-holding-dollar', 'Seña registrada por', info.senaPor, info.senaAt);
  add('fa-circle-check', 'Asistencia y cobro confirmados por', info.asistenciaPor, info.asistenciaAt);
  if (info.canceladaPor) {
    add(info.status === 'No vino' ? 'fa-user-xmark' : 'fa-ban',
        info.status === 'No vino' ? 'Marcada "no vino" por' : 'Cancelada por', info.canceladaPor, info.canceladaAt);
  }
  const ultima = [info.creadaAt, info.senaAt, info.asistenciaAt, info.canceladaAt].filter(Boolean).sort().pop() || '';
  if (info.modificadaPor && info.modificadaAt && info.modificadaAt.slice(0, 19) > ultima.slice(0, 19)) {
    add('fa-pen', 'Última edición por', info.modificadaPor, info.modificadaAt);
  }
  if (!items.length) return '';
  return `<div class="dt-audit"><div class="dt-audit-title"><i class="fas fa-clock-rotate-left"></i> Historial</div><ul>${items.join('')}</ul></div>`;
}

function fmtFechaHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const hoy = new Date();
  const mismoDia = d.toDateString() === hoy.toDateString();
  return (mismoDia ? 'hoy' : `${d.getDate()}/${d.getMonth() + 1}`) + ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Hace cuánto (para "último acceso")
function hace(iso) {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2)    return 'recién';
  if (min < 60)   return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.round(min / 60)} h`;
  const dias = Math.round(min / 1440);
  return dias === 1 ? 'ayer' : `hace ${dias} días`;
}

// —.——.— NAVIGATION —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function setView(view) {
  if (['monthly', 'team', 'actividad'].includes(view) && !esJefe()) view = 'home'; // solo jefes
  currentView = view;
  SheetsAPI.updatePresence({ vista: view });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('nav-' + view)?.classList.add('active');
  // cerrar sidebar en móvil al navegar
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-backdrop').classList.remove('visible');

  const isHome      = view === 'home';
  const isDashboard = view === 'dashboard';
  const isMonthly   = view === 'monthly';
  document.getElementById('home-section').style.display    = isHome ? '' : 'none';
  document.getElementById('grid-section').style.display    = isDashboard ? '' : 'none';
  document.querySelector('.content-stats').style.display   = isDashboard ? '' : 'none';
  document.getElementById('buffet-section').style.display  = view === 'buffet' ? 'block' : 'none';
  document.getElementById('caja-section').style.display    = view === 'caja' ? 'block' : 'none';
  document.getElementById('team-section').style.display    = view === 'team' ? 'block' : 'none';
  document.getElementById('clients-section').style.display = view === 'clients' ? 'block' : 'none';
  document.getElementById('monthly-section').style.display = isMonthly ? 'block' : 'none';
  document.getElementById('fijos-section').style.display   = view === 'fijos' ? 'block' : 'none';
  document.getElementById('actividad-section').style.display = view === 'actividad' ? 'block' : 'none';
  document.getElementById('main-content').scrollTop = 0;

  const topbarTitle   = document.getElementById('topbar-title');
  const topbarActions = document.querySelector('.topbar-actions');
  if (isHome) {
    topbarTitle.textContent     = 'Dashboard';
    topbarActions.style.display = '';
    renderHome();
  } else if (view === 'buffet') {
    topbarTitle.textContent     = 'Buffet';
    topbarActions.style.display = 'none';
  } else if (view === 'clients') {
    topbarTitle.textContent     = 'Clientes';
    topbarActions.style.display = 'none';
    loadClients();
  } else if (view === 'team') {
    topbarTitle.textContent     = 'Equipo';
    topbarActions.style.display = 'none';
    loadTeam();
  } else if (view === 'fijos') {
    topbarTitle.textContent     = 'Turnos fijos';
    topbarActions.style.display = 'none';
    loadTurnosFijos();
  } else if (view === 'actividad') {
    topbarTitle.textContent     = 'Actividad';
    topbarActions.style.display = 'none';
    loadActividad();
  } else if (view === 'caja') {
    topbarTitle.textContent     = 'Caja del día';
    topbarActions.style.display = '';
    renderCaja();
  } else if (isMonthly) {
    topbarTitle.textContent     = 'Control mensual';
    topbarActions.style.display = 'none';
    loadMonthlyStats();
  } else {
    topbarTitle.textContent     = 'Disponibilidad de canchas';
    topbarActions.style.display = '';
  }
}

// —.——.— SE—'A —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
// ===== CLIENTES =====
const CLIENTS_PAGE = 30;
let clientsData = [];
let clientsShown = CLIENTS_PAGE;

// Número para wa.me en formato internacional de Argentina: 549 + área + número.
// Acepta "11 1234-5678", "011 15 1234-5678", "+54 9 11 1234 5678", "541112345678", etc.
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);                 // 0054...
  if (d.startsWith('54')) d = d.slice(2);                 // código de país
  if (d.startsWith('9') && d.length === 11) d = d.slice(1); // el 9 de celular
  if (d.startsWith('0')) d = d.slice(1);                  // 0 de larga distancia
  // "15" después del código de área (formato local de celular): 11 15 1234 5678
  if (d.length === 12) {
    for (const largoArea of [2, 3, 4]) {
      if (d.substr(largoArea, 2) === '15') { d = d.slice(0, largoArea) + d.slice(largoArea + 2); break; }
    }
  }
  return '549' + d;
}

function clientStats(c) {
  const activas = c.reservas.filter(isActiva);
  const asistio = activas.filter(r => r.status === 'Asistida').length;
  return { total: activas.length, asistio, ultima: activas[0]?.date || c.reservas[0]?.date || '' };
}

function fmtFechaCorta(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${DAYS_SHORT[new Date(y, m - 1, d).getDay()]} ${d}/${m}/${y}`;
}

async function loadClients() {
  const wrap = document.getElementById('clients-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-muted)">Cargando clientes…</div>';
  const res = await SheetsAPI.getClientesDetalle();
  if (!res.success) { wrap.innerHTML = `<div class="empty-state"><p>${escHtml(res.error)}</p></div>`; return; }
  clientsData = res.clientes.sort((a, b) => clientStats(b).ultima.localeCompare(clientStats(a).ultima) || a.name.localeCompare(b.name));
  clientsShown = CLIENTS_PAGE;
  wrap.innerHTML = `
    <div class="monthly-nav">
      <div class="monthly-nav-title">Clientes (${clientsData.length})</div>
      <input type="search" id="clients-search" class="form-input" placeholder="Buscar por nombre o teléfono…" oninput="clientsShown = CLIENTS_PAGE; renderClientsList()" style="flex:1;min-width:180px">
      <button class="btn-refresh" onclick="loadClients()"><i class="fas fa-arrows-rotate"></i> Actualizar</button>
    </div>
    <div id="clients-list"></div>`;
  renderClientsList();
}

function renderClientsList() {
  const list = document.getElementById('clients-list');
  if (!list) return;
  const q = (document.getElementById('clients-search')?.value || '').trim().toLowerCase();
  const matches = clientsData.filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
  if (!matches.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-address-book"></i><p>No se encontraron clientes.</p></div>';
    return;
  }
  const rows = matches.slice(0, clientsShown).map((c, i) => {
    const st = clientStats(c);
    return `
      <tr class="monthly-tr${i % 2 ? ' stripe' : ''}" style="cursor:pointer" onclick="openClientDetail('${escHtml(c.phone)}')">
        <td class="monthly-td" style="font-weight:700">${escHtml(c.name)}</td>
        <td class="monthly-td">${escHtml(c.phone)}</td>
        <td class="monthly-td">${st.total}</td>
        <td class="monthly-td" style="font-weight:700;color:var(--brand)">${st.asistio}</td>
        <td class="monthly-td">${fmtFechaCorta(st.ultima)}</td>
      </tr>`;
  }).join('');
  const resto = matches.length - clientsShown;
  list.innerHTML = `
    <div class="monthly-table-card rows-open">
      <div class="monthly-table-header">
        <i class="fas fa-address-book"></i>
        <span class="mth-title">Todos los clientes</span>
        <span class="mth-count">${matches.length} cliente${matches.length !== 1 ? 's' : ''}</span>
      </div>
      <div style="overflow-x:auto">
        <table class="monthly-table">
          <thead><tr>
            <th class="monthly-th">Cliente</th><th class="monthly-th">WhatsApp</th>
            <th class="monthly-th">Reservas</th><th class="monthly-th">Asistió</th><th class="monthly-th">Última reserva</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${resto > 0 ? `<button class="more-rows-btn" onclick="clientsShown += CLIENTS_PAGE; renderClientsList()"><i class="fas fa-chevron-down"></i> <span>Ver más (${resto})</span></button>` : ''}
    </div>`;
}

function openClientDetail(phone) {
  const c = clientsData.find(x => x.phone === phone);
  if (!c) return;
  const st = clientStats(c);
  const tel = c.phone.replace(/[^\d+]/g, '');
  const msg = encodeURIComponent(`Hola ${c.name}! `);
  const hist = c.reservas.slice(0, 15).map(r => `
    <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:13px">
      <span>${fmtFechaCorta(r.date)} · ${escHtml(r.time)} · ${escHtml(r.court)}</span>
      <span class="status-pill ${{ Asistida: 'asistida', Cancelada: 'cancelada', 'No vino': 'cancelada' }[r.status] || 'confirmada'}">${escHtml(r.status)}</span>
    </div>`).join('') || '<p style="color:var(--text-muted);font-size:13px">Todavía no tiene reservas.</p>';
  const extra = c.reservas.length > 15 ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">y ${c.reservas.length - 15} reservas más antiguas</div>` : '';
  const box = (n, l) => `<div style="flex:1;text-align:center;background:var(--brand-50);border:1px solid var(--brand-200);border-radius:14px;padding:10px 4px"><div style="font-size:22px;font-weight:800;color:var(--brand-800)">${n}</div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);font-weight:600">${l}</div></div>`;
  document.getElementById('client-modal-body').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-right:40px">
      <div style="width:44px;height:44px;background:var(--brand-100);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fas fa-user" style="color:var(--brand);font-size:18px"></i></div>
      <div><div style="font-size:18px;font-weight:800">${escHtml(c.name)}</div><div style="font-size:12px;color:var(--text-muted);margin-top:2px">${escHtml(c.phone)}</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px">${box(st.total, 'Reservas')}${box(st.asistio, 'Asistió')}${box(st.total - st.asistio, 'Sin asistir')}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <a class="btn-wa-sena" href="https://wa.me/${waNumber(c.phone)}?text=${msg}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> WhatsApp</a>
      <a class="btn-wa-sena" href="tel:${tel}"><i class="fas fa-phone"></i> Llamar</a>
    </div>
    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:4px">Historial</div>
    ${hist}${extra}`;
  document.getElementById('client-modal-overlay').classList.add('open');
}

function closeClientModal() {
  document.getElementById('client-modal-overlay').classList.remove('open');
}
document.getElementById('client-modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeClientModal();
});

// ===== EQUIPO (solo jefes) =====
let teamCache = [];

async function loadTeam() {
  const wrap = document.getElementById('team-wrap');
  if (!wrap || !esJefe()) return;
  wrap.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-muted)">Cargando equipo…</div>';
  const res = await SheetsAPI.getTeam();
  if (!res.success) { wrap.innerHTML = `<div class="empty-state"><p>${escHtml(res.error)}</p></div>`; return; }
  teamCache = res.team;

  wrap.innerHTML = `
    <div class="monthly-table-card" style="margin-top:0">
      <div class="monthly-table-header">
        <i class="fas fa-users-gear"></i><span class="mth-title">Equipo y permisos</span>
        <span class="mth-count">${res.team.length} persona${res.team.length === 1 ? '' : 's'}</span>
      </div>
      <div style="overflow-x:auto"><table class="monthly-table">
        <thead><tr><th class="monthly-th">PERSONA</th><th class="monthly-th">CONEXIÓN</th><th class="monthly-th">ROL</th><th class="monthly-th">ESTADO</th><th class="monthly-th">CONTRASEÑA</th></tr></thead>
        <tbody id="team-rows"></tbody>
      </table></div>
    </div>
    <div class="monthly-table-card">
      <div class="monthly-table-header"><i class="fas fa-user-plus"></i><span class="mth-title">Agregar persona</span></div>
      <div style="padding:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <input class="form-input" id="team-new-email" type="email" placeholder="email@ejemplo.com" style="flex:2;min-width:200px">
        <input class="form-input" id="team-new-nombre" placeholder="Nombre" style="flex:1;min-width:140px">
        <select class="form-select" id="team-new-rol" style="flex:1;min-width:130px">
          <option value="empleado">Empleado</option><option value="jefe">Jefe</option>
        </select>
        <button class="btn-new-booking" id="team-add-btn" onclick="addTeamMember()"><i class="fas fa-plus"></i> Agregar</button>
      </div>
      <p style="padding:0 16px 16px;margin:0;color:var(--text-muted);font-size:12px">
        Se le crea el usuario automáticamente con una contraseña temporal que vas a ver acá. Pasásela y que la cambie al entrar (menú de su nombre → Cambiar contraseña).
      </p>
      <div id="team-cred" style="display:none"></div>
    </div>
    <div id="ajustes-wrap"></div>`;
  renderTeamRows();
  loadAjustes();
}

function renderTeamRows() {
  const tbody = document.getElementById('team-rows');
  if (!tbody) return;
  const me = SheetsAPI.getProfile().email;
  const online = new Set(enLinea.map(p => p.email));
  tbody.innerHTML = teamCache.map((m, i) => {
    const soyYo = m.email === me;
    const e = escHtml(m.email);
    const conectado = online.has(m.email);
    const conexion = conectado
      ? '<span class="online-tag"><i class="online-dot"></i> En línea</span>'
      : `<span style="color:var(--text-muted);font-size:12px">${'ultimo_acceso' in m ? 'Últ. vez ' + hace(m.ultimo_acceso) : '—'}</span>`;
    return `
      <tr class="monthly-tr${i % 2 ? ' stripe' : ''}">
        <td class="monthly-td"><div style="font-weight:700">${escHtml(m.nombre || '—')}${soyYo ? ' <small style="color:var(--text-muted)">(vos)</small>' : ''}</div><div style="font-size:12px;color:var(--text-muted)">${e}</div></td>
        <td class="monthly-td" style="white-space:nowrap">${conexion}</td>
        <td class="monthly-td">
          <select class="form-select" ${soyYo ? 'disabled' : ''} onchange="changeTeamMember('${e}', {rol: this.value})">
            <option value="empleado" ${m.rol === 'empleado' ? 'selected' : ''}>Empleado</option>
            <option value="jefe" ${m.rol === 'jefe' ? 'selected' : ''}>Jefe</option>
          </select>
        </td>
        <td class="monthly-td">
          <select class="form-select" ${soyYo ? 'disabled' : ''} onchange="changeTeamMember('${e}', {activo: this.value === '1'})">
            <option value="1" ${m.activo ? 'selected' : ''}>Activo</option>
            <option value="0" ${m.activo ? '' : 'selected'}>Dado de baja</option>
          </select>
        </td>
        <td class="monthly-td">${soyYo ? '<button class="chip-btn" onclick="openPasswordModal()"><i class="fas fa-key"></i> Cambiar</button>'
          : `<button class="chip-btn" onclick="resetTeamPassword('${e}')"><i class="fas fa-key"></i> Nueva temporal</button>`}</td>
      </tr>`;
  }).join('');
}

async function changeTeamMember(email, cambio) {
  const res = await SheetsAPI.getTeam();
  const m = (res.team || []).find(x => x.email === email);
  if (!m) return showToast('No se encontró a la persona.', true);
  const r = await SheetsAPI.saveTeamMember({ email: m.email, nombre: m.nombre, rol: m.rol, activo: m.activo, ...cambio });
  showToast(r.success ? 'Cambio guardado.' : r.error, !r.success);
  loadTeam();
}

function showCredenciales(email, password, titulo) {
  const box = document.getElementById('team-cred');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = `
    <div class="cred-box">
      <div class="cred-title"><i class="fas fa-circle-check"></i> ${escHtml(titulo)}</div>
      <div class="cred-row"><span>Email</span><b>${escHtml(email)}</b></div>
      ${password ? `<div class="cred-row"><span>Contraseña temporal</span><b class="cred-pass">${escHtml(password)}</b>
        <button class="chip-btn" onclick="navigator.clipboard?.writeText('${escHtml(password)}').then(() => showToast('Contraseña copiada.'))"><i class="fas fa-copy"></i> Copiar</button></div>
        <p>Anotala ahora: por seguridad no se vuelve a mostrar. Si se pierde, generá otra con "Nueva temporal".</p>`
        : '<p>Esta persona ya tenía usuario: entra con su contraseña de siempre.</p>'}
    </div>`;
}

async function addTeamMember() {
  const email = document.getElementById('team-new-email').value.trim().toLowerCase();
  if (!email) return showToast('Ingresá el email.', true);
  const btn = document.getElementById('team-add-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando...';
  const r = await SheetsAPI.altaEmpleado({
    email,
    nombre: document.getElementById('team-new-nombre').value.trim(),
    rol: document.getElementById('team-new-rol').value,
  });
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-plus"></i> Agregar';
  if (!r.success) return showToast(r.error, true);
  showToast('Persona agregada.');
  await loadTeam();
  showCredenciales(email, r.password, r.creado ? 'Usuario creado' : 'Acceso habilitado');
}

async function resetTeamPassword(email) {
  if (!confirm(`¿Generar una contraseña temporal nueva para ${email}?\n\nLa actual deja de funcionar.`)) return;
  const r = await SheetsAPI.resetearPassword(email);
  if (!r.success) return showToast(r.error, true);
  showCredenciales(email, r.password, 'Contraseña nueva generada');
  document.getElementById('team-cred')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// —.— Precios y horarios (jefes) —.—
async function loadAjustes() {
  const wrap = document.getElementById('ajustes-wrap');
  if (!wrap) return;
  const res = await SheetsAPI.getConfig();
  if (!res.success) { wrap.innerHTML = ''; return; }
  const horas = (desde, hasta, sel) => Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i)
    .map(h => `<option value="${h}" ${h === sel ? 'selected' : ''}>${h === 24 ? '24:00 (medianoche)' : pad(h) + ':00'}</option>`).join('');
  wrap.innerHTML = `
    <div class="monthly-table-card">
      <div class="monthly-table-header"><i class="fas fa-futbol"></i><span class="mth-title">Canchas</span></div>
      <div style="padding:16px">
        <div class="ajustes-grid">
          ${res.canchas.map(c => `
            <div class="ajuste-item${c.activa ? '' : ' inactiva'}" data-cancha="${escHtml(c.id)}">
              <div style="display:flex;gap:6px;align-items:center">
                <select class="form-select" data-f="tipo" style="width:auto">
                  <option value="F5" ${c.type === 'F5' ? 'selected' : ''}>F5</option>
                  <option value="F7" ${c.type === 'F7' ? 'selected' : ''}>F7</option>
                </select>
                <input class="form-input" data-f="etiqueta" value="${escHtml(c.label)}" maxlength="30" style="flex:1;min-width:0">
              </div>
              <div class="ajuste-input"><b>$</b><input class="form-input" type="number" min="0" step="500" data-f="precio" value="${c.price}"><small>/hora</small></div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="chip-btn" onclick="guardarCancha('${escHtml(c.id)}')"><i class="fas fa-floppy-disk"></i> Guardar</button>
                <button class="chip-btn" onclick="toggleCancha('${escHtml(c.id)}', ${!c.activa})"><i class="fas fa-${c.activa ? 'eye-slash' : 'eye'}"></i> ${c.activa ? 'Desactivar' : 'Reactivar'}</button>
                <button class="chip-btn danger" onclick="borrarCancha('${escHtml(c.id)}')"><i class="fas fa-trash"></i> Eliminar</button>
              </div>
              ${c.activa ? '' : '<small style="color:var(--text-muted)">Desactivada: no aparece en la grilla.</small>'}
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:14px">
          <div class="form-group" style="margin:0"><label class="form-label">Nueva cancha</label>
            <select class="form-select" id="nc-tipo"><option value="F5">Fútbol 5</option><option value="F7">Fútbol 7</option></select></div>
          <div class="form-group" style="margin:0;flex:1;min-width:140px"><label class="form-label">Nombre</label>
            <input class="form-input" id="nc-etiqueta" placeholder="Cancha 7" maxlength="30"></div>
          <div class="form-group" style="margin:0;width:140px"><label class="form-label">Precio por hora</label>
            <input class="form-input" id="nc-precio" type="number" min="0" step="500" placeholder="45000"></div>
          <button class="btn-new-booking" onclick="agregarCancha()"><i class="fas fa-plus"></i> Agregar</button>
        </div>
        <p style="margin:12px 0 0;color:var(--text-muted);font-size:12px">El precio nuevo se aplica a las reservas que se carguen desde ahora; las ya cargadas mantienen su precio. Una cancha con reservas no se puede eliminar (se pierde el historial): desactivala y deja de aparecer.</p>
      </div>
    </div>
    <div class="monthly-table-card">
      <div class="monthly-table-header"><i class="fas fa-clock"></i><span class="mth-title">Horarios</span></div>
      <div style="padding:16px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div class="form-group" style="margin:0;min-width:150px"><label class="form-label">Abre (primer turno)</label>
            <select class="form-select" id="aj-apertura">${horas(0, 23, res.apertura)}</select></div>
          <div class="form-group" style="margin:0;min-width:150px"><label class="form-label">Cierra (fin del último turno)</label>
            <select class="form-select" id="aj-cierre">${horas(1, 24, res.cierre)}</select></div>
          <button class="btn-new-booking" id="aj-save" onclick="saveAjustes()"><i class="fas fa-floppy-disk"></i> Guardar</button>
        </div>
      </div>
    </div>`;
}

async function saveAjustes() {
  const apertura = parseInt(document.getElementById('aj-apertura').value);
  const cierre   = parseInt(document.getElementById('aj-cierre').value);
  if (apertura >= cierre) return showToast('El horario de cierre tiene que ser después de la apertura.', true);
  const btn = document.getElementById('aj-save');
  btn.disabled = true;
  const r = await SheetsAPI.saveAjustes({ precios: {}, apertura, cierre });
  btn.disabled = false;
  if (!r.success) return showToast(r.error, true);
  await loadConfig();
  loadMatrix(true);
  showToast('Horarios guardados.');
}

// —.— Gestión de canchas (jefes) —.—
async function refrescarCanchas() {
  await loadConfig();
  loadMatrix(true);
  loadAjustes();
}

function textoUso(uso) {
  const partes = [];
  if (uso.reservas_futuras > 0) partes.push(`${uso.reservas_futuras} reserva(s) futura(s)`);
  if (uso.fijos_activos > 0)    partes.push(`${uso.fijos_activos} turno(s) fijo(s) activo(s)`);
  return partes.join(' y ');
}

async function agregarCancha() {
  const etiqueta = document.getElementById('nc-etiqueta').value.trim();
  const precio   = parseFloat(document.getElementById('nc-precio').value);
  if (!etiqueta) return showToast('Ingresá el nombre de la cancha.', true);
  if (isNaN(precio) || precio < 0) return showToast('Ingresá el precio por hora.', true);
  const r = await SheetsAPI.crearCancha({ tipo: document.getElementById('nc-tipo').value, etiqueta, precio });
  if (!r.success) return showToast(r.error, true);
  showToast('Cancha agregada.');
  refrescarCanchas();
}

async function guardarCancha(id) {
  const fila = document.querySelector(`#ajustes-wrap .ajuste-item[data-cancha="${CSS.escape(id)}"]`);
  const etiqueta = fila.querySelector('[data-f="etiqueta"]').value.trim();
  const precio   = parseFloat(fila.querySelector('[data-f="precio"]').value);
  if (!etiqueta) return showToast('El nombre no puede quedar vacío.', true);
  if (isNaN(precio) || precio < 0) return showToast('Precio inválido.', true);
  const r = await SheetsAPI.editarCancha({ id, etiqueta, precio, tipo: fila.querySelector('[data-f="tipo"]').value });
  if (!r.success) return showToast(r.error, true);
  showToast('Cancha guardada.');
  refrescarCanchas();
}

async function toggleCancha(id, activar) {
  if (!activar && !confirm('¿Desactivar esta cancha? Deja de aparecer en la grilla; las reservas pasadas y la caja se conservan.')) return;
  const r = await SheetsAPI.cambiarEstadoCancha(id, activar);
  if (!r.success) return showToast(r.error, true);
  if (!r.ok) return showToast(`No se puede desactivar: tiene ${textoUso(r.uso)}. Cancelalas o movelas antes.`, true);
  showToast(activar ? 'Cancha reactivada.' : 'Cancha desactivada.');
  refrescarCanchas();
}

async function borrarCancha(id) {
  if (!confirm('¿Eliminar esta cancha? No se puede deshacer. Si ya tuvo reservas, se conservan en la caja y los reportes.')) return;
  let r = await SheetsAPI.eliminarCancha(id);
  if (!r.success) return showToast(r.error, true);
  if (!r.ok) {
    if (!confirm(`Esta cancha tiene ${textoUso(r.uso)}.\n\nSi la eliminás, esas reservas se CANCELAN y los turnos fijos se dan de baja. Avisá a los clientes.\n\n¿Eliminar igual?`)) return;
    r = await SheetsAPI.eliminarCancha(id, true);
    if (!r.success) return showToast(r.error, true);
  }
  showToast('Cancha eliminada.');
  refrescarCanchas();
}

// ===== TURNOS FIJOS =====
let turnosFijosCache = [];

async function loadTurnosFijos() {
  const wrap = document.getElementById('fijos-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-muted)">Cargando turnos fijos…</div>';
  const res = await SheetsAPI.getTurnosFijos();
  if (!res.success) { wrap.innerHTML = `<div class="empty-state"><p>${escHtml(res.error)}</p></div>`; return; }
  turnosFijosCache = res.turnos;
  const activos = res.turnos.filter(t => t.activo);
  const bajas   = res.turnos.filter(t => !t.activo);
  const fila = (t, i) => `
    <tr class="monthly-tr${i % 2 ? ' stripe' : ''}">
      <td class="monthly-td" style="font-weight:700;white-space:nowrap">${DIAS_LARGOS[t.dia]} ${escHtml(t.time)}</td>
      <td class="monthly-td" style="white-space:nowrap">${escHtml(t.court)} · ${t.duration}h</td>
      <td class="monthly-td"><div style="font-weight:600">${escHtml(t.name)}</div><div style="font-size:12px;color:var(--text-muted)">${escHtml(t.phone)}</div></td>
      <td class="monthly-td" style="white-space:nowrap">${fmtFechaCorta(t.desde)}${t.hasta ? ' → ' + fmtFechaCorta(t.hasta) : ''}</td>
      <td class="monthly-td" style="font-size:12px;color:var(--text-muted)">${t.activo
        ? `Creado por ${escHtml(t.creadoPor || '—')}`
        : `Baja por ${escHtml(t.bajaPor || '—')} ${t.bajaAt ? escHtml(fmtFechaHora(t.bajaAt)) : ''}`}</td>
      <td class="monthly-td" style="white-space:nowrap">${t.activo ? `<button class="chip-btn" onclick="openEditTurnoFijo('${t.id}')"><i class="fas fa-pen"></i> Editar</button>
        <button class="chip-btn danger" onclick="darDeBajaTurnoFijo('${t.id}')"><i class="fas fa-ban"></i> Dar de baja</button>` : ''}</td>
    </tr>`;
  const tabla = (lista, titulo, icono, vacio) => `
    <div class="monthly-table-card"${titulo === 'Activos' ? ' style="margin-top:0"' : ''}>
      <div class="monthly-table-header"><i class="fas ${icono}"></i><span class="mth-title">${titulo}</span><span class="mth-count">${lista.length}</span></div>
      ${lista.length ? `<div style="overflow-x:auto"><table class="monthly-table">
        <thead><tr><th class="monthly-th">DÍA Y HORA</th><th class="monthly-th">CANCHA</th><th class="monthly-th">CLIENTE</th><th class="monthly-th">VIGENCIA</th><th class="monthly-th">REGISTRO</th><th class="monthly-th"></th></tr></thead>
        <tbody>${lista.map(fila).join('')}</tbody></table></div>`
      : `<div class="empty-state" style="margin:0"><p>${vacio}</p></div>`}
    </div>`;
  wrap.innerHTML = `
    <div class="monthly-nav">
      <div class="monthly-nav-title">Turnos fijos</div>
      <button class="btn-new-booking" onclick="openNewBookingModal(); document.getElementById('m-fijo').checked = true; onFijoChange();"><i class="fas fa-plus"></i> Nuevo turno fijo</button>
    </div>
    <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px">Clientes que juegan todas las semanas el mismo día y horario. Quedan reservados todos los meses hasta que los des de baja: cualquier mes que abras en la grilla ya los muestra. Para saltear una semana, cancelá esa reserva desde la grilla; para cambiar día, horario, cancha o cliente, usá "Editar".</p>
    ${tabla(activos, 'Activos', 'fa-repeat', 'Todavía no hay turnos fijos. Creá uno desde "Nueva reserva" tildando "Turno fijo".')}
    ${bajas.length ? tabla(bajas, 'Dados de baja', 'fa-box-archive', '') : ''}`;
}

// —.— Editar turno fijo —.—
let editandoTurnoId = null;

function openEditTurnoFijo(id) {
  const t = turnosFijosCache.find(x => x.id === id);
  if (!t) return;
  editandoTurnoId = id;
  const alerta = document.getElementById('tf-alert');
  alerta.style.display = 'none';
  const btn = document.getElementById('tf-save');
  btn.style.display = ''; btn.disabled = false;

  const courtSel = document.getElementById('tf-court');
  courtSel.innerHTML = COURTS.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)} — ${escHtml(c.label)}</option>`).join('');
  if (!COURTS.some(c => c.id === t.court)) courtSel.insertAdjacentHTML('afterbegin', `<option value="${escHtml(t.court)}">${escHtml(t.court)}</option>`);
  courtSel.value = t.court;
  document.getElementById('tf-dia').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<option value="${d}">${DIAS_LARGOS[d]}</option>`).join('');
  document.getElementById('tf-dia').value = String(t.dia);
  const timeSel = document.getElementById('tf-time');
  timeSel.innerHTML = TIME_SLOTS.map(h => `<option value="${h}">${h}</option>`).join('');
  if (!TIME_SLOTS.includes(t.time)) timeSel.insertAdjacentHTML('afterbegin', `<option value="${escHtml(t.time)}">${escHtml(t.time)}</option>`);
  timeSel.value = t.time;
  document.getElementById('tf-duration').value = String(t.duration);
  document.getElementById('tf-name').value  = t.name;
  document.getElementById('tf-phone').value = t.phone;
  document.getElementById('tf-notas').value = t.notas || '';
  const desde = document.getElementById('tf-desde');
  desde.min = todayStr();
  desde.value = todayStr();
  document.getElementById('tf-subtitle').textContent = `${t.name} · hoy: ${DIAS_LARGOS[t.dia]} ${t.time} hs · ${t.court}`;
  updateTfPrice();
  document.getElementById('tf-modal-overlay').classList.add('open');
}

function closeEditTurnoFijo() {
  document.getElementById('tf-modal-overlay').classList.remove('open');
  editandoTurnoId = null;
}

function updateTfPrice() {
  renderPricePreview('tf-court', 'tf-duration', 'tf-price-preview', 'tf-price-preview-val');
}

async function submitEditTurnoFijo() {
  const alerta = document.getElementById('tf-alert');
  const mostrar = (msg, err = true) => { alerta.textContent = msg; alerta.className = 'modal-alert ' + (err ? 'error' : 'success'); alerta.style.display = 'flex'; };
  const datos = {
    id: editandoTurnoId,
    court:    document.getElementById('tf-court').value,
    dia:      document.getElementById('tf-dia').value,
    time:     document.getElementById('tf-time').value,
    duration: document.getElementById('tf-duration').value,
    name:     document.getElementById('tf-name').value.trim(),
    phone:    document.getElementById('tf-phone').value.trim(),
    notas:    document.getElementById('tf-notas').value.trim(),
    desde:    document.getElementById('tf-desde').value || todayStr(),
    hoy:      todayStr(),
    hasta:    fijosHasta || finDeMes(todayStr(), 2),
  };
  if (!datos.name)  return mostrar('Ingresá el nombre del cliente.');
  if (!datos.phone) return mostrar('Ingresá el WhatsApp del cliente.');
  if (datos.desde < todayStr()) return mostrar('Los cambios se aplican desde hoy en adelante.');

  const btn = document.getElementById('tf-save');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
  const r = await SheetsAPI.editTurnoFijo(datos);
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Guardar cambios';
  if (!r.success) return mostrar(r.error || 'No se pudo editar el turno fijo.');

  Object.keys(monthStatsCache).forEach(k => delete monthStatsCache[k]);
  if (!clientesCache.some(c => c.phone === datos.phone)) clientesCache.push({ name: datos.name, phone: datos.phone });
  loadTurnosFijos();
  loadMatrix(true);
  const ocupadas = [...r.noMovidas, ...r.conflictos];
  if (ocupadas.length) {
    btn.style.display = 'none';
    mostrar(`Turno fijo actualizado. Estas fechas no se pudieron pasar al horario nuevo porque la cancha ya está ocupada: ` +
      ocupadas.map(c => `${fmtFechaCorta(c.fecha)} ${c.hora}`).join(', ') +
      `. Quedaron como estaban; revisalas en la grilla.`);
  } else {
    mostrar('Turno fijo actualizado. Las próximas fechas ya tienen el horario nuevo.', false);
    showToast(`Turno fijo actualizado: ${DIAS_LARGOS[datos.dia]} ${datos.time} — ${datos.name}`);
    setTimeout(closeEditTurnoFijo, 1500);
  }
}

async function darDeBajaTurnoFijo(id) {
  const t = turnosFijosCache.find(x => x.id === id);
  const nombre = t ? `${t.name} (${DIAS_LARGOS[t.dia]} ${t.time})` : 'este cliente';
  if (!confirm(`¿Dar de baja el turno fijo de ${nombre}?\n\nSe cancelan las reservas de las próximas semanas (las de hoy no se tocan).`)) return;
  const r = await SheetsAPI.bajaTurnoFijo(id, todayStr());
  if (!r.success) return showToast(r.error, true);
  showToast(`Turno fijo dado de baja. ${r.canceladas} reserva${r.canceladas === 1 ? '' : 's'} futura${r.canceladas === 1 ? '' : 's'} cancelada${r.canceladas === 1 ? '' : 's'}.`);
  loadTurnosFijos();
  loadMatrix(true);
}

// ===== ACTIVIDAD (solo jefes): quién hizo qué =====
let actividadCache = [];

async function loadActividad() {
  const wrap = document.getElementById('actividad-wrap');
  if (!wrap || !esJefe()) return;
  const fechaSel = document.getElementById('act-fecha')?.value || todayStr();
  wrap.innerHTML = `
    <div class="monthly-nav">
      <div class="monthly-nav-title">Actividad del equipo</div>
      <input type="date" class="form-input" id="act-fecha" value="${fechaSel}" onchange="loadActividad()" style="max-width:170px">
      <select class="form-select" id="act-persona" onchange="renderActividad()" style="max-width:200px"><option value="">Todas las personas</option></select>
      <button class="btn-refresh" onclick="loadActividad()"><i class="fas fa-arrows-rotate"></i> Actualizar</button>
    </div>
    <div id="actividad-list"><div style="text-align:center;padding:40px 0;color:var(--text-muted)">Cargando…</div></div>`;
  // Día completo en hora local
  const [y, m, d] = fechaSel.split('-').map(Number);
  const desde = new Date(y, m - 1, d).toISOString();
  const hasta = new Date(y, m - 1, d + 1).toISOString();
  const res = await SheetsAPI.getActividad({ desde, hasta });
  if (!res.success) {
    document.getElementById('actividad-list').innerHTML = `<div class="empty-state"><p>${escHtml(res.error)}</p></div>`;
    return;
  }
  actividadCache = res.actividad;
  const personas = [...new Set(actividadCache.map(a => a.usuario))].sort();
  document.getElementById('act-persona').innerHTML = '<option value="">Todas las personas</option>' +
    personas.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');
  renderActividad();
}

const ACT_ICON = {
  'Creó reserva': 'fa-calendar-plus', 'Editó reserva': 'fa-pen', 'Eliminó reserva': 'fa-trash',
  'Canceló reserva': 'fa-ban', 'Marcó que no vino': 'fa-user-xmark', 'Confirmó asistencia': 'fa-circle-check',
  'Registró seña': 'fa-hand-holding-dollar', 'Registró egreso': 'fa-arrow-trend-down', 'Eliminó egreso': 'fa-trash',
  'Creó turno fijo': 'fa-repeat', 'Dio de baja turno fijo': 'fa-ban', 'Cambió precio': 'fa-tag', 'Cambió horarios': 'fa-clock',
};

function renderActividad() {
  const list = document.getElementById('actividad-list');
  if (!list) return;
  const persona = document.getElementById('act-persona')?.value || '';
  const rows = actividadCache.filter(a => !persona || a.usuario === persona);
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-clock-rotate-left"></i><p>No hay movimientos registrados ese día.</p></div>';
    return;
  }
  list.innerHTML = `
    <div class="monthly-table-card" style="margin-top:0">
      <div class="monthly-table-header"><i class="fas fa-clock-rotate-left"></i><span class="mth-title">Movimientos</span><span class="mth-count">${rows.length}</span></div>
      <div style="overflow-x:auto"><table class="monthly-table">
        <thead><tr><th class="monthly-th">HORA</th><th class="monthly-th">QUIÉN</th><th class="monthly-th">QUÉ HIZO</th><th class="monthly-th">DETALLE</th></tr></thead>
        <tbody>${rows.map((a, i) => {
          const d = new Date(a.creado_at);
          const danger = /Eliminó|Canceló|baja|no vino/i.test(a.accion);
          return `<tr class="monthly-tr${i % 2 ? ' stripe' : ''}">
            <td class="monthly-td" style="white-space:nowrap;font-variant-numeric:tabular-nums">${pad(d.getHours())}:${pad(d.getMinutes())}</td>
            <td class="monthly-td" style="font-weight:700;white-space:nowrap">${escHtml(a.usuario)}</td>
            <td class="monthly-td" style="white-space:nowrap;${danger ? 'color:var(--red)' : ''}"><i class="fas ${ACT_ICON[a.accion] || 'fa-circle-info'}" style="width:16px;opacity:.7"></i> ${escHtml(a.accion)}</td>
            <td class="monthly-td" style="color:var(--text-dim)">${escHtml(a.detalle || '')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`;
}

// ===== EN LÍNEA (presencia) =====
const VISTA_LABEL = { home: 'Dashboard', dashboard: 'Canchas', buffet: 'Buffet', caja: 'Caja del día', clients: 'Clientes',
                      monthly: 'Control mensual', team: 'Equipo', fijos: 'Turnos fijos', actividad: 'Actividad' };

function renderPresence() {
  const pill = document.getElementById('presence-pill');
  if (!pill) return;
  const me = SheetsAPI.getProfile().email;
  const n = enLinea.length;
  pill.style.display = n ? '' : 'none';
  const avatares = enLinea.slice(0, 3).map(p =>
    `<span class="presence-avatar${p.rol === 'jefe' ? ' jefe' : ''}" title="${escHtml(p.nombre)}">${escHtml(p.nombre.charAt(0).toUpperCase())}</span>`).join('');
  document.getElementById('presence-btn').innerHTML =
    `<i class="online-dot"></i><span class="presence-avatars">${avatares}</span><span class="presence-count">${n} en línea</span>`;
  document.getElementById('presence-list').innerHTML = `
    <div class="presence-title">Con el panel abierto ahora</div>
    ${enLinea.map(p => `
      <div class="presence-item">
        <span class="presence-avatar${p.rol === 'jefe' ? ' jefe' : ''}">${escHtml(p.nombre.charAt(0).toUpperCase())}</span>
        <div style="min-width:0">
          <div class="presence-name">${escHtml(p.nombre)}${p.email === me ? ' <small>(vos)</small>' : ''}</div>
          <div class="presence-meta">${p.rol === 'jefe' ? 'Jefe' : 'Empleado'} · en ${escHtml(VISTA_LABEL[p.vista] || 'el panel')} · desde ${escHtml(fmtFechaHora(p.desde))}</div>
        </div>
      </div>`).join('')}`;
  if (currentView === 'team') renderTeamRows();
}

function togglePresenceList() {
  document.getElementById('presence-list').classList.toggle('open');
}
document.addEventListener('click', e => {
  const wrap = document.getElementById('presence-pill');
  if (wrap && !wrap.contains(e.target)) document.getElementById('presence-list')?.classList.remove('open');
});

// ===== CAMBIAR CONTRASEÑA =====
function openPasswordModal() {
  ['pw-new', 'pw-new2'].forEach(id => { document.getElementById(id).value = ''; });
  const a = document.getElementById('pw-alert');
  a.style.display = 'none';
  document.getElementById('password-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('pw-new').focus(), 80);
}

function closePasswordModal() {
  document.getElementById('password-modal-overlay').classList.remove('open');
}

async function submitPassword() {
  const p1 = document.getElementById('pw-new').value;
  const p2 = document.getElementById('pw-new2').value;
  const a  = document.getElementById('pw-alert');
  const alerta = (msg, err = true) => { a.textContent = msg; a.className = 'modal-alert ' + (err ? 'error' : 'success'); a.style.display = 'flex'; };
  if (p1.length < 8) return alerta('Usá al menos 8 caracteres.');
  if (p1 !== p2)     return alerta('Las contraseñas no coinciden.');
  const btn = document.getElementById('pw-save');
  btn.disabled = true;
  const r = await SheetsAPI.changePassword(p1);
  btn.disabled = false;
  if (!r.success) return alerta(r.error);
  alerta('Contraseña actualizada.', false);
  setTimeout(closePasswordModal, 1200);
}

// ===== CAJA DEL DIA (empleados y jefes) =====
// Muestra solo lo cobrado en la fecha seleccionada (por defecto hoy) para el cierre de caja.
function renderCaja() {
  const wrap = document.getElementById('caja-wrap');
  if (!wrap) return;

  const bookings = getCajaItems();
  const t        = computeDayTotals(bookings);
  const nActivas = bookings.filter(b => isActiva(b.info) && b.info.date === currentDate).length;
  const isToday  = currentDate === todayStr();
  const label    = (isToday ? 'Hoy, ' : '') + formatDateLabel(currentDate);

  const medio = tipo => tipo === 'Transferencia' ? 'Transf.' : tipo === 'Efectivo' ? 'Efectivo' : tipo === 'Mixto' ? 'Mixto' : '';
  const money = v => v > 0 ? fmtCurrency(v) : '<span style="color:#cbd5e1">—</span>';

  const rows = bookings.map(({ court, info }, i) => {
    const otraFecha = info.date && info.date !== currentDate;
    const sena     = senaCobradaHoy(info) ? (parseFloat(info.sena) || 0) : 0;
    const resto    = !otraFecha && info.status === 'Asistida' ? (parseFloat(info.pagoRestante) || 0) : 0;
    const estado   = bookingState(info);
    const fmtDia   = f => f.split('-').reverse().slice(0, 2).join('/');
    const estadoTxt = otraFecha ? `Seña para el turno del ${fmtDia(info.date)}`
      : !isActiva(info) ? `${STATE_LABEL[estado]} · seña retenida`
      : (info.estadoSena === 'Recibida' && !sena && SheetsAPI.diaSena(info) !== currentDate && (parseFloat(info.sena) || 0) > 0)
        ? `${STATE_LABEL[estado]} · seña cobrada el ${fmtDia(SheetsAPI.diaSena(info))}`
        : STATE_LABEL[estado];
    const cobro = [...new Set([sena ? info.senaPor : '', resto ? info.asistenciaPor : ''].filter(Boolean))].join(', ');
    return `
      <tr class="monthly-tr${i % 2 ? ' stripe' : ''}">
        <td class="monthly-td" style="font-weight:700;white-space:nowrap">${escHtml(info.startTime)}</td>
        <td class="monthly-td" style="white-space:nowrap">${escHtml(court.id)}</td>
        <td class="monthly-td">${escHtml(info.name)}</td>
        <td class="monthly-td" style="white-space:nowrap">${money(sena)} <small style="color:var(--text-muted)">${sena ? medio(info.tipoSena) : ''}</small></td>
        <td class="monthly-td" style="white-space:nowrap">${money(resto)} <small style="color:var(--text-muted)">${resto ? medio(info.tipoPagoRestante) : ''}</small></td>
        <td class="monthly-td" style="font-weight:800;color:var(--brand);white-space:nowrap">${money(sena + resto)}</td>
        <td class="monthly-td" style="white-space:normal;min-width:120px;line-height:1.35">${escHtml(estadoTxt)}</td>
        <td class="monthly-td" style="color:var(--text-muted);font-size:12px;white-space:normal;min-width:70px">${escHtml(cobro) || '—'}</td>
      </tr>`;
  }).join('');

  const n = bookings.length;
  wrap.innerHTML = `
    <div class="income-panel">
      <div class="income-header">
        <i class="fas fa-cash-register"></i>
        <span class="income-header-title">Caja del día</span>
        <span class="income-date-badge">${escHtml(label)}</span>
      </div>
      <div class="income-metrics">
        <div class="income-metric ingresos">
          <div class="income-metric-label"><i class="fas fa-coins"></i> Total cobrado</div>
          <div class="income-metric-value">${fmtCurrency(t.ingresos)}</div>
          <div class="income-metric-sub">${nActivas} reserva${nActivas === 1 ? '' : 's'} en el día</div>
        </div>
        <div class="income-metric efectivo">
          <div class="income-metric-label"><i class="fas fa-money-bill-wave"></i> Efectivo en caja</div>
          <div class="income-metric-value">${fmtCurrency(t.efectivo)}</div>
          <div class="income-metric-sub">debe coincidir con el cierre</div>
        </div>
        <div class="income-metric transf">
          <div class="income-metric-label"><i class="fas fa-mobile-screen-button"></i> Transferencias</div>
          <div class="income-metric-value">${fmtCurrency(t.transferencias)}</div>
          <div class="income-metric-sub">verificar en la cuenta</div>
        </div>
        <div class="income-metric canchas">
          <div class="income-metric-label"><i class="fas fa-hourglass-half"></i> Por cobrar</div>
          <div class="income-metric-value">${fmtCurrency(t.aCobrar)}</div>
          <div class="income-metric-sub">${t.pendientes} seña${t.pendientes === 1 ? '' : 's'} pendiente${t.pendientes === 1 ? '' : 's'}</div>
        </div>
      </div>
    </div>
    <div class="monthly-table-card">
      <div class="monthly-table-header">
        <i class="fas fa-list-check"></i>
        <span class="mth-title">Detalle de cobros</span>
        <span class="mth-count">${n} turno${n === 1 ? '' : 's'}</span>
      </div>
      ${n ? `
      <div style="overflow-x:auto">
        <table class="monthly-table">
          <thead><tr>
            <th class="monthly-th">HORA</th><th class="monthly-th">CANCHA</th><th class="monthly-th">CLIENTE</th>
            <th class="monthly-th">SEÑA</th><th class="monthly-th">RESTO</th>
            <th class="monthly-th" style="color:var(--brand)">COBRADO</th><th class="monthly-th">ESTADO</th>
            <th class="monthly-th">COBRÓ</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<div class="empty-state"><i class="fas fa-calendar-xmark"></i><p>No hay reservas en esta fecha.</p></div>`}
    </div>`;
}

function onSenaTipoChange(prefix) {
  const tipo = document.getElementById(`${prefix}-tipo-sena`).value;
  const wrap = document.getElementById(`${prefix}-sena-estado-wrap`);
  wrap.style.display = (tipo === 'Sin seña') ? 'none' : 'block';
  if (tipo !== 'Sin seña') {
    document.getElementById(`${prefix}-estado-sena`).value = 'Recibida';
  }
}

async function markSenaReceived() {
  const recordId = currentDetailInfo?.recordId;
  if (!recordId) return;
  const btn = document.getElementById('btn-mark-sena');
  if (!btn) return;
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
  const result  = await SheetsAPI.updateSena({ recordId, estadoSena: 'Recibida' });
  if (result.success) {
    if (currentDetailCourt) {
      Object.values(bookingDetailsMap[currentDetailCourt] || {}).forEach(info => {
        if (info && info.recordId === recordId) Object.assign(info, { estadoSena: 'Recibida', senaPor: yoNombre(), senaAt: new Date().toISOString() });
      });
    }
    if (currentDetailInfo) Object.assign(currentDetailInfo, { estadoSena: 'Recibida', senaPor: yoNombre(), senaAt: new Date().toISOString() });
    renderMatrix();
    updateStats();
    closeDetailModal();
    showToast(`Seña confirmada: ${currentDetailInfo?.name || ''}`);
  } else {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-circle-check"></i> Marcar seña recibida';
    showToast('Error al confirmar seña. Intentá de nuevo.', true);
  }
}

// —.——.— CONFIRMAR ASISTENCIA —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function selectPayMethod(method) {
  selectedPayMethod = method;
  const tBtn = document.getElementById('pay-transf');
  const eBtn = document.getElementById('pay-efect');
  if (tBtn) { tBtn.className = 'pay-method-btn' + (method === 'Transferencia' ? ' selected-transf' : ''); }
  const mBtn = document.getElementById('pay-mixto');
  if (eBtn) { eBtn.className = 'pay-method-btn' + (method === 'Efectivo'      ? ' selected-efect'  : ''); }
  if (mBtn) { mBtn.className = 'pay-method-btn' + (method === 'Mixto'         ? ' selected-mixto'  : ''); }
  const box = document.getElementById('pay-mixto-box');
  if (box) box.style.display = method === 'Mixto' ? '' : 'none';
  if (method === 'Mixto') { updateMixto(); return; }
  const confirmBtn = document.getElementById('btn-confirm-attendance');
  if (confirmBtn) confirmBtn.disabled = false;
}

// Monto por transferencia tipeado en el pago mixto (0 si es inválido)
function mixtoTransf() {
  return parseFloat(document.getElementById('pay-mixto-transf')?.value) || 0;
}

function updateMixto() {
  const resta  = Math.max(0, (parseFloat(currentDetailInfo?.price) || 0) - (parseFloat(currentDetailInfo?.sena) || 0));
  const transf = mixtoTransf();
  const valido = transf > 0 && transf < resta;
  const efect  = document.getElementById('pay-mixto-efect');
  if (efect) efect.textContent = '$' + Math.max(0, resta - transf).toLocaleString('es-AR');
  const confirmBtn = document.getElementById('btn-confirm-attendance');
  if (confirmBtn) confirmBtn.disabled = !valido;
}

async function confirmAttendance() {
  const recordId = currentDetailInfo?.recordId;
  if (!recordId) return;

  const totalPrice = parseFloat(currentDetailInfo?.price) || 0;
  const senaMonto  = parseFloat(currentDetailInfo?.sena)  || 0;
  const restaPagar = Math.max(0, totalPrice - senaMonto);

  if (restaPagar > 0 && !selectedPayMethod) {
    showToast('Seleccioná la forma de pago antes de confirmar.', true);
    return;
  }

  const pagoTransf = restaPagar > 0 && selectedPayMethod === 'Mixto' ? mixtoTransf() : 0;
  if (restaPagar > 0 && selectedPayMethod === 'Mixto' && !(pagoTransf > 0 && pagoTransf < restaPagar)) {
    showToast('Indicá cuánto pagó por transferencia (menos que el total a cobrar).', true);
    return;
  }

  const btn = document.getElementById('btn-confirm-attendance');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Confirmando...';
  }

  const result = await SheetsAPI.confirmAttendance({
    recordId,
    tipoPago:     restaPagar > 0 ? selectedPayMethod : '',
    pagoRestante: restaPagar,
    pagoTransf,
  });

  if (result.success) {
    const tipoPagoUsado = restaPagar > 0 ? selectedPayMethod : '';
    if (currentDetailCourt) {
      Object.values(bookingDetailsMap[currentDetailCourt] || {}).forEach(info => {
        if (info && info.recordId === recordId) {
          info.status           = 'Asistida';
          info.pagoRestante     = restaPagar;
          info.tipoPagoRestante = tipoPagoUsado;
          info.pagoRestanteTransf = pagoTransf;
          info.asistenciaPor    = yoNombre();
          info.asistenciaAt     = new Date().toISOString();
        }
      });
    }
    if (currentDetailInfo) {
      currentDetailInfo.status           = 'Asistida';
      currentDetailInfo.pagoRestante     = restaPagar;
      currentDetailInfo.tipoPagoRestante = tipoPagoUsado;
      currentDetailInfo.pagoRestanteTransf = pagoTransf;
      currentDetailInfo.asistenciaPor    = yoNombre();
      currentDetailInfo.asistenciaAt     = new Date().toISOString();
    }
    selectedPayMethod = '';
    renderMatrix();
    updateStats();
    closeDetailModal();
    showToast(`Cancha confirmada — ${currentDetailInfo?.name || ''} asistió y pagó.`);
  } else {
    if (btn) {
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-circle-check"></i> Confirmar cancha';
    }
    showToast('Error al confirmar. Intentá de nuevo.', true);
  }
}

// —.——.— CONTROL MENSUAL —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
const MONTHS_LONG = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DAYS_SHORT  = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

let monthlyYear  = new Date().getFullYear();
let monthlyMonth = new Date().getMonth() + 1;

const COLLAPSE_ROWS = 7; // filas visibles antes del "Ver más"

function moreRowsBtn(total) {
  if (total <= COLLAPSE_ROWS) return '';
  return `<button class="more-rows-btn" onclick="toggleRows(this)" data-total="${total}">
    <i class="fas fa-chevron-down"></i> <span>Ver más (${total - COLLAPSE_ROWS})</span></button>`;
}

function toggleRows(btn) {
  const card = btn.closest('.monthly-table-card');
  const open = card.classList.toggle('rows-open');
  btn.querySelector('i').className = 'fas ' + (open ? 'fa-chevron-up' : 'fa-chevron-down');
  btn.querySelector('span').textContent = open ? 'Ver menos' : `Ver más (${btn.dataset.total - COLLAPSE_ROWS})`;
}

function shiftMonth(delta) {
  monthlyMonth += delta;
  if (monthlyMonth > 12) { monthlyMonth = 1; monthlyYear++; }
  if (monthlyMonth < 1)  { monthlyMonth = 12; monthlyYear--; }
  loadMonthlyStats();
}

async function loadMonthlyStats() {
  const wrap = document.getElementById('monthly-wrap');
  if (!wrap || !esJefe()) return;

  const label = MONTHS_LONG[monthlyMonth - 1] + ' ' + monthlyYear;
  wrap.innerHTML = `
    <div class="monthly-nav">
      <button class="date-nav-btn" onclick="shiftMonth(-1)"><i class="fas fa-chevron-left"></i></button>
      <div class="monthly-nav-title">${label}</div>
      <button class="date-nav-btn" onclick="shiftMonth(1)"><i class="fas fa-chevron-right"></i></button>
    </div>
    <div style="text-align:center;padding:40px 0;color:var(--text-muted)">
      <i class="fas fa-arrows-rotate fa-spin" style="font-size:24px;margin-bottom:12px;display:block"></i>
      Cargando datos de ${label}...
    </div>`;

  await asegurarTurnosFijos(`${monthlyYear}-${pad(monthlyMonth)}-01`);
  const [statsData, egresosData] = await Promise.all([
    SheetsAPI.getMonthlyStats(monthlyYear, monthlyMonth),
    SheetsAPI.getEgresos({ year: monthlyYear, month: monthlyMonth })
  ]);
  renderMonthlyView(statsData, egresosData);
}

function renderMonthlyView(data, egresosData) {
  const wrap = document.getElementById('monthly-wrap');
  if (!wrap) return;

  const { stats = {}, reservas = [], reservasCobro = reservas, error: statsError } = data || {};
  const { totalBookings = 0, ingresos = 0, transferencias = 0, efectivo = 0 } = stats;

  const { stats: eStats = {}, egresos = [], error: egresosError } = egresosData || {};
  const { total: egTotal = 0, efectivo: egEfect = 0, transferencias: egTransf = 0 } = eStats;

  const label = MONTHS_LONG[monthlyMonth - 1] + ' ' + monthlyYear;
  const netaMensual = ingresos - egTotal;
  const netaColor   = netaMensual >= 0 ? 'var(--green)' : 'var(--red)';

  const navHtml = `
    <div class="monthly-nav">
      <button class="date-nav-btn" onclick="shiftMonth(-1)" title="Mes anterior"><i class="fas fa-chevron-left"></i></button>
      <div class="monthly-nav-title">${label}</div>
      <button class="date-nav-btn" onclick="shiftMonth(1)" title="Mes siguiente"><i class="fas fa-chevron-right"></i></button>
      <button class="btn-refresh" onclick="loadMonthlyStats()"><i class="fas fa-arrows-rotate"></i> Actualizar</button>
      <button class="btn-new-booking is-egreso" onclick="openEgresoModal()">
        <i class="fas fa-plus"></i> Nuevo egreso
      </button>
    </div>`;

  if (statsError && !reservas.length && egresosError && !egresos.length) {
    wrap.innerHTML = navHtml + `<div class="empty-state"><i class="fas fa-triangle-exclamation"></i><p>Error al cargar datos. Intentá de nuevo.</p></div>`;
    return;
  }

  // Panel de ingresos
  const ingresosHtml = `
    <div class="income-panel">
      <div class="income-header">
        <i class="fas fa-chart-bar"></i>
        <span class="income-header-title">Ingresos del mes</span>
        <span class="income-date-badge">${label}</span>
      </div>
      <div class="income-metrics">
        <div class="income-metric canchas">
          <div class="income-metric-label"><i class="fas fa-futbol"></i> Reservas</div>
          <div class="income-metric-value">${totalBookings}</div>
          <div class="income-metric-sub">${totalBookings === 1 ? '1 reserva' : totalBookings + ' reservas'} en el mes</div>
        </div>
        <div class="income-metric ingresos">
          <div class="income-metric-label"><i class="fas fa-coins"></i> Bruta</div>
          <div class="income-metric-value">${fmtCurrency(ingresos)}</div>
          <div class="income-metric-sub">cobrado en el mes</div>
        </div>
        <div class="income-metric transf">
          <div class="income-metric-label"><i class="fas fa-mobile-screen-button"></i> Transferencias</div>
          <div class="income-metric-value">${fmtCurrency(transferencias)}</div>
          <div class="income-metric-sub">por transferencia</div>
        </div>
        <div class="income-metric efectivo">
          <div class="income-metric-label"><i class="fas fa-money-bill-wave"></i> Efectivo</div>
          <div class="income-metric-value">${fmtCurrency(efectivo)}</div>
          <div class="income-metric-sub">en mano</div>
        </div>
      </div>
    </div>`;

  // Panel de egresos
  const egresosHtml = `
    <div class="income-panel is-egresos">
      <div class="income-header">
        <i class="fas fa-arrow-trend-down"></i>
        <span class="income-header-title">Egresos del mes</span>
        <span class="income-date-badge">${label}</span>
      </div>
      <div class="income-metrics">
        <div class="income-metric canchas">
          <div class="income-metric-label"><i class="fas fa-receipt"></i> Gastos</div>
          <div class="income-metric-value">${egresos.length}</div>
          <div class="income-metric-sub">${egresos.length === 1 ? '1 egreso' : egresos.length + ' egresos'} registrados</div>
        </div>
        <div class="income-metric egreso-total">
          <div class="income-metric-label"><i class="fas fa-arrow-trend-down"></i> Total egresos</div>
          <div class="income-metric-value">${fmtCurrency(egTotal)}</div>
          <div class="income-metric-sub">gastado en el mes</div>
        </div>
        <div class="income-metric egreso-transf">
          <div class="income-metric-label"><i class="fas fa-mobile-screen-button"></i> Transferencias</div>
          <div class="income-metric-value">${fmtCurrency(egTransf)}</div>
          <div class="income-metric-sub">por transferencia</div>
        </div>
        <div class="income-metric egreso-efect">
          <div class="income-metric-label"><i class="fas fa-money-bill-wave"></i> Efectivo</div>
          <div class="income-metric-value">${fmtCurrency(egEfect)}</div>
          <div class="income-metric-sub">pagado en mano</div>
        </div>
      </div>
    </div>`;

  // Neta mensual
  const netaHtml = `
    <div class="neta-card">
      <div class="neta-icon ${netaMensual >= 0 ? 'pos' : 'neg'}"><i class="fas fa-scale-balanced"></i></div>
      <div>
        <div class="neta-label">Neta del mes</div>
        <div class="neta-value" style="color:${netaColor}">${fmtCurrency(netaMensual)}</div>
        <div class="neta-sub">Ingresos ${fmtCurrency(ingresos)} — Egresos ${fmtCurrency(egTotal)}</div>
      </div>
    </div>`;

  // Planilla diaria BRUTA / NETA
  const dailyHtml = buildDailyPlanilla(reservasCobro, egresos, label);

  // Tabla detalle reservas
  let reservasTableHtml = '';
  if (!reservas.length) {
    reservasTableHtml = `<div class="empty-state" style="margin-top:24px"><i class="fas fa-calendar-xmark"></i><p>No hay reservas en ${label}.</p></div>`;
  } else {
    const rows = reservas.map((r, i) => {
      const [y, m, d] = r.date.split('-').map(Number);
      const dow       = new Date(y, m - 1, d).getDay();
      const dayLabel  = `${DAYS_SHORT[dow]} ${d}/${m}`;
      const courtCls  = r.court.startsWith('F7') ? 'f7' : 'f5';
      const statusCls = { Asistida: 'asistida', Cancelada: 'cancelada', 'No vino': 'cancelada' }[r.status] || 'confirmada';
      const statusIco = {
        Asistida:  '<i class="fas fa-circle-check"></i> Asistida',
        Cancelada: '<i class="fas fa-ban"></i> Cancelada',
        'No vino': '<i class="fas fa-user-xmark"></i> No vino',
      }[r.status] || '<i class="fas fa-calendar-check"></i> Confirmada';
      const senaCls   = r.tipoSena === 'Sin seña' ? 'sin-sena'
        : r.estadoSena === 'Recibida' ? 'recibida' : r.estadoSena === 'Devuelta' ? 'sin-sena' : 'pendiente';
      const senaLabel = r.tipoSena === 'Sin seña' ? 'Sin seña'
        : r.estadoSena === 'Devuelta' ? 'Devuelta'
        : (r.sena > 0 ? '$' + r.sena.toLocaleString('es-AR') : r.tipoSena);
      const stripeClass = i % 2 !== 0 ? ' stripe' : '';

      return `
        <tr class="monthly-tr${stripeClass}${i >= COLLAPSE_ROWS ? ' row-extra' : ''}">
          <td class="monthly-td">${dayLabel}</td>
          <td class="monthly-td"><span class="court-pill ${courtCls}">${r.court}</span></td>
          <td class="monthly-td" style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis">${escHtml(r.name)}</td>
          <td class="monthly-td">${r.time}</td>
          <td class="monthly-td">${r.duration}h</td>
          <td class="monthly-td" style="font-weight:700;${isActiva(r) ? '' : 'text-decoration:line-through;color:var(--text-faint)'}">${fmtCurrency(r.price)}</td>
          <td class="monthly-td"><span class="sena-pill ${senaCls}">${senaLabel}</span></td>
          <td class="monthly-td"><span class="status-pill ${statusCls}">${statusIco}</span></td>
          <td class="monthly-td" style="font-size:12px;color:var(--text-muted);white-space:nowrap">${escHtml(r.creadaPor || '—')}</td>
        </tr>`;
    }).join('');

    reservasTableHtml = `
      <div class="monthly-table-card" style="margin-top:20px">
        <div class="monthly-table-header">
          <i class="fas fa-list"></i>
          <span class="mth-title">Detalle de reservas — ${label}</span>
          <span class="mth-count">${totalBookings} reserva${totalBookings !== 1 ? 's' : ''}${reservas.length > totalBookings ? ` · ${reservas.length - totalBookings} cancelada${reservas.length - totalBookings !== 1 ? 's' : ''}` : ''}</span>
        </div>
        <div style="overflow-x:auto">
          <table class="monthly-table">
            <thead>
              <tr>
                <th class="monthly-th">Fecha</th>
                <th class="monthly-th">Cancha</th>
                <th class="monthly-th">Cliente</th>
                <th class="monthly-th">Hora</th>
                <th class="monthly-th">Dur.</th>
                <th class="monthly-th">Total</th>
                <th class="monthly-th">Seña</th>
                <th class="monthly-th">Estado</th>
                <th class="monthly-th">Cargó</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${moreRowsBtn(reservas.length)}
      </div>`;
  }

  // Tabla detalle egresos
  let egresosTableHtml = '';
  if (!egresos.length) {
    egresosTableHtml = `<div class="empty-state" style="margin-top:24px"><i class="fas fa-receipt"></i><p>No hay egresos registrados en ${label}.</p></div>`;
  } else {
    const eRows = egresos.map((eg, i) => {
      const [y, m, d] = eg.fecha.split('-').map(Number);
      const dow       = new Date(y, m - 1, d).getDay();
      const dayLabel  = `${DAYS_SHORT[dow]} ${d}/${m}`;
      const cat       = EGRESO_CATS[eg.categoria] || EGRESO_CATS['Otros'];
      const fpCls     = eg.formaPago === 'Transferencia' ? 'selected-transf' : 'selected-efect';
      const fpIcon    = eg.formaPago === 'Transferencia' ? 'fa-mobile-screen-button' : 'fa-money-bill-wave';
      const stripeClass = i % 2 !== 0 ? ' stripe' : '';
      const descHtml  = eg.desc
        ? `<span style="color:var(--text-dim)">${escHtml(eg.desc)}</span>`
        : `<span style="color:#cbd5e1;font-style:italic">—</span>`;
      return `
        <tr class="monthly-tr${stripeClass}${i >= COLLAPSE_ROWS ? ' row-extra' : ''}">
          <td class="monthly-td">${dayLabel}</td>
          <td class="monthly-td">
            <span class="egreso-cat-badge ${cat.cls}">
              <i class="fas ${cat.icon}"></i> ${eg.categoria}
            </span>
          </td>
          <td class="monthly-td" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${descHtml}</td>
          <td class="monthly-td" style="font-weight:800;color:var(--red)">${fmtCurrency(eg.monto)}</td>
          <td class="monthly-td">
            <span class="pay-method-btn ${fpCls}" style="padding:3px 9px;font-size:11px;pointer-events:none;cursor:default">
              <i class="fas ${fpIcon}"></i> ${eg.formaPago}
            </span>
          </td>
          <td class="monthly-td" style="font-size:12px;color:var(--text-muted);white-space:nowrap">${escHtml(eg.creadoPor || '—')}</td>
          <td class="monthly-td">
            <button onclick="confirmDeleteEgreso('${eg.id}','${eg.categoria.replace(/'/g,"\\'")}',${eg.monto})"
              style="background:#fdf0f0;border:1px solid #f3c1c1;color:var(--red);border-radius:999px;width:30px;height:30px;font-size:11px;cursor:pointer;font-family:inherit">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join('');

    egresosTableHtml = `
      <div class="monthly-table-card" style="margin-top:20px">
        <div class="monthly-table-header is-egresos">
          <i class="fas fa-arrow-trend-down"></i>
          <span class="mth-title">Detalle de egresos — ${label}</span>
          <span class="mth-count">${egresos.length} egreso${egresos.length !== 1 ? 's' : ''}</span>
        </div>
        <div style="overflow-x:auto">
          <table class="monthly-table">
            <thead>
              <tr>
                <th class="monthly-th">Fecha</th>
                <th class="monthly-th">Categoría</th>
                <th class="monthly-th">Descripción</th>
                <th class="monthly-th">Monto</th>
                <th class="monthly-th">Forma de pago</th>
                <th class="monthly-th">Cargó</th>
                <th class="monthly-th">Acciones</th>
              </tr>
            </thead>
            <tbody>${eRows}</tbody>
          </table>
        </div>
        ${moreRowsBtn(egresos.length)}
      </div>`;
  }

  wrap.innerHTML = navHtml + ingresosHtml + egresosHtml + netaHtml + dailyHtml + reservasTableHtml + egresosTableHtml;
}

function buildDailyPlanilla(reservas, egresos, label) {
  // Agrupar lo cobrado por día: la seña cuenta el día que se recibió, el resto el día del turno
  const incomeByDay = {};
  const mesPrefijo  = `${monthlyYear}-${pad(monthlyMonth)}-`;
  const sumarDia = (fecha, monto) => {
    if (!fecha.startsWith(mesPrefijo) || !(monto > 0)) return;
    if (!incomeByDay[fecha]) incomeByDay[fecha] = { totalBruta: 0 };
    incomeByDay[fecha].totalBruta += monto;
  };
  reservas.forEach(r => {
    if (r.estadoSena === 'Recibida') sumarDia(SheetsAPI.diaSena(r), r.sena || 0);
    if (r.status === 'Asistida')     sumarDia(r.date, r.pagoRestante || 0);
  });

  // Agrupar egresos por fecha
  const egresosByDay = {};
  egresos.forEach(eg => {
    if (!egresosByDay[eg.fecha]) egresosByDay[eg.fecha] = { items: [], total: 0 };
    egresosByDay[eg.fecha].items.push(eg);
    egresosByDay[eg.fecha].total += (eg.monto || 0);
  });

  const allDates = [...new Set([...Object.keys(incomeByDay), ...Object.keys(egresosByDay)])].sort();
  if (!allDates.length) return '';

  const rows = allDates.map((date, i) => {
    const [y, m, d]     = date.split('-').map(Number);
    const dow            = new Date(y, m - 1, d).getDay();
    const dayLabel       = `${DAYS_SHORT[dow]} ${d}/${m}`;
    const bruta          = incomeByDay[date]?.totalBruta || 0;
    const egresosDelDia  = egresosByDay[date];
    const totalEgresosHoy = egresosDelDia?.total || 0;
    const neta           = bruta - totalEgresosHoy;
    const netaClr        = neta >= 0 ? 'var(--brand)' : 'var(--red)';
    const stripeClass    = i % 2 !== 0 ? ' stripe' : '';

    const egresosDetail = egresosDelDia?.items.map(eg => {
      const cat   = EGRESO_CATS[eg.categoria] || EGRESO_CATS['Otros'];
      const texto = eg.desc ? eg.desc : eg.categoria;
      return `<span class="egreso-cat-badge ${cat.cls}" style="font-size:10px;padding:2px 7px;margin:2px 2px;display:inline-flex;align-items:center;gap:3px;white-space:nowrap"><i class="fas ${cat.icon}"></i>${texto} <b>${fmtCurrency(eg.monto)}</b></span>`;
    }).join('') || '<span style="color:#cbd5e1;font-style:italic;font-size:12px">—</span>';

    return `
      <tr class="monthly-tr${stripeClass}${i >= COLLAPSE_ROWS ? ' row-extra' : ''}">
        <td class="monthly-td" style="font-weight:700;white-space:nowrap">${dayLabel}</td>
        <td class="monthly-td" style="font-weight:700;color:var(--brand);white-space:nowrap">${bruta > 0 ? fmtCurrency(bruta) : '<span style="color:#cbd5e1">—</span>'}</td>
        <td class="monthly-td" style="max-width:320px;white-space:normal;line-height:1.6">${egresosDetail}</td>
        <td class="monthly-td" style="font-weight:600;color:var(--red);white-space:nowrap">${totalEgresosHoy > 0 ? fmtCurrency(totalEgresosHoy) : '<span style="color:#cbd5e1">—</span>'}</td>
        <td class="monthly-td" style="font-weight:800;color:${netaClr};white-space:nowrap">${fmtCurrency(neta)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="monthly-table-card" style="margin-top:20px">
      <div class="monthly-table-header">
        <i class="fas fa-table-columns"></i>
        <span class="mth-title">Planilla diaria — ${label}</span>
        <span class="mth-count">${allDates.length} día${allDates.length !== 1 ? 's' : ''} con movimiento</span>
      </div>
      <div style="overflow-x:auto">
        <table class="monthly-table">
          <thead>
            <tr>
              <th class="monthly-th">FECHA</th>
              <th class="monthly-th" style="color:var(--brand)">BRUTA</th>
              <th class="monthly-th">EGRESOS</th>
              <th class="monthly-th" style="color:var(--red)">TOTAL EGRESADO</th>
              <th class="monthly-th">NETA</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${moreRowsBtn(allDates.length)}
    </div>`;
}


// —.——.— EGRESOS —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
const EGRESO_CATS = {
  'Luz':           { icon: 'fa-bolt',                cls: 'cat-luz'           },
  'Gas':           { icon: 'fa-fire',                cls: 'cat-gas'           },
  'Agua':          { icon: 'fa-droplet',             cls: 'cat-agua'          },
  'Mantenimiento': { icon: 'fa-wrench',              cls: 'cat-mantenimiento' },
  'Limpieza':      { icon: 'fa-broom',               cls: 'cat-limpieza'      },
  'Personal':      { icon: 'fa-users',               cls: 'cat-personal'      },
  'Buffet':        { icon: 'fa-utensils',            cls: 'cat-buffet'        },
  'Alquiler':      { icon: 'fa-house',               cls: 'cat-alquiler'      },
  'Impuestos':     { icon: 'fa-file-invoice-dollar', cls: 'cat-impuestos'     },
  'Otros':         { icon: 'fa-box',                 cls: 'cat-otros'         },
};


// MODAL EGRESO
function openEgresoModal() {
  const alertEl = document.getElementById('egreso-modal-alert');
  alertEl.style.display = 'none';
  alertEl.className     = 'modal-alert';

  const btn = document.getElementById('confirm-egreso-btn');
  btn.disabled  = false;
  btn.innerHTML = '<i class="fas fa-circle-check"></i> Registrar egreso';

  document.getElementById('eg-fecha').value      = todayStr();
  document.getElementById('eg-categoria').value  = 'Luz';
  document.getElementById('eg-desc').value       = '';
  document.getElementById('eg-monto').value      = '';
  document.getElementById('eg-forma-pago').value = 'Efectivo';
  document.getElementById('eg-notas').value      = '';

  document.getElementById('egreso-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('eg-desc').focus(), 80);
}

function closeEgresoModal() {
  document.getElementById('egreso-modal-overlay').classList.remove('open');
}

document.getElementById('egreso-modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeEgresoModal();
});

async function submitNewEgreso() {
  const alertEl   = document.getElementById('egreso-modal-alert');
  const showAlert = (msg, err = true) => {
    alertEl.textContent   = msg;
    alertEl.className     = 'modal-alert ' + (err ? 'error' : 'success');
    alertEl.style.display = 'flex';
  };

  const fecha     = document.getElementById('eg-fecha').value;
  const categoria = document.getElementById('eg-categoria').value;
  const desc      = document.getElementById('eg-desc').value.trim();
  const monto     = parseFloat(document.getElementById('eg-monto').value) || 0;
  const formaPago = document.getElementById('eg-forma-pago').value;
  const notas     = document.getElementById('eg-notas').value.trim();

  if (!fecha)     return showAlert('Seleccioná una fecha.');
  if (!categoria) return showAlert('Seleccioná una categoría.');
  if (monto <= 0) return showAlert('Ingresá un monto válido mayor a $0.');

  const btn = document.getElementById('confirm-egreso-btn');
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';

  const result = await SheetsAPI.saveEgreso({ fecha, categoria, desc, monto, formaPago, notas });

  if (result.success) {
    showAlert('Egreso registrado correctamente.', false);
    showToast(`Egreso registrado: ${categoria} — ${fmtCurrency(monto)}`);
    setTimeout(() => { closeEgresoModal(); loadMonthlyStats(); }, 1200);
  } else {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-circle-check"></i> Registrar egreso';
    showAlert(result.error || 'Error al registrar. Intentá de nuevo.');
  }
}

// DELETE EGRESO
function confirmDeleteEgreso(id, categoria, monto) {
  if (!confirm(`¿Eliminar el egreso de "${categoria}" por ${fmtCurrency(monto)}?\n\nEsta acción no se puede deshacer.`)) return;
  doDeleteEgreso(id);
}

async function doDeleteEgreso(id) {
  const result = await SheetsAPI.deleteEgreso(id);
  if (result.success) {
    showToast('Egreso eliminado correctamente.');
    loadMonthlyStats();
  } else {
    showToast('Error al eliminar el egreso. Intentá de nuevo.', true);
  }
}


// —.——.— DASHBOARD (INICIO) —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
// Usa los mismos datos que la grilla (matrixData / bookingDetailsMap) para el día
// seleccionado y getMonthlyStats() para la ocupación de la semana.

const WEEK_LETTERS = ['L','M','M','J','V','S','D'];
const WEEK_NAMES   = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
const monthStatsCache = {};   // { 'YYYY-M': { t, reservas } }
let weekRenderKey = '';        // fecha seleccionada del último render semanal
let clockTimer    = null;

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function bookingState(info) {
  if (info.status === 'Cancelada') return 'cancelada';
  if (info.status === 'No vino')   return 'no-vino';
  if (info.status === 'Asistida')  return 'asistida';
  return (info.estadoSena || 'Pendiente') === 'Recibida' ? 'occupied' : 'no-sena';
}
const STATE_LABEL = { asistida: 'Asistida', occupied: 'Señado', 'no-sena': 'Sin seña', cancelada: 'Cancelada', 'no-vino': 'No vino' };
const STATE_ICON  = { asistida: 'fa-circle-check', occupied: 'fa-hand-holding-dollar', 'no-sena': 'fa-clock', cancelada: 'fa-ban', 'no-vino': 'fa-user-xmark' };

function slotEnd(startTime, duration) {
  const idx = TIME_SLOTS.indexOf(startTime);
  const end = TIME_SLOTS[idx + (duration || 1)];
  return end || `${pad((parseInt(startTime) || 0) + (duration || 1))}:00`;
}

// Reservas únicas del día (deduplicadas por recordId), ordenadas por hora
function getDayBookings() {
  const seen = new Set();
  const list = [];
  COURTS.forEach(c => {
    Object.values(bookingDetailsMap[c.id] || {}).forEach(info => {
      if (!info) return;
      const key = info.recordId || `${c.id}_${info.startTime}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ court: c, info });
    });
  });
  list.sort((a, b) => (a.info.startTime || '').localeCompare(b.info.startTime || '') || a.court.id.localeCompare(b.court.id));
  return list;
}

// Totales de caja. Las canceladas / "no vino" solo suman la seña si se retuvo.
function computeDayTotals(items) {
  let ingresos = 0, transferencias = 0, efectivo = 0, aCobrar = 0, pendientes = 0, horas = 0;
  const cobrar = (monto, medio, transf = 0) => {
    if (monto <= 0) return;
    ingresos += monto;
    if (medio === 'Transferencia') transferencias += monto;
    else if (medio === 'Efectivo') efectivo += monto;
    else if (medio === 'Mixto') { transferencias += transf; efectivo += monto - transf; }
  };
  items.forEach(({ court, info }) => {
    const price  = parseFloat(info.price) || courtPrice(court.id, info.duration);
    const senaOk = (info.estadoSena || 'Pendiente') === 'Recibida';
    const sena   = parseFloat(info.sena) || 0;
    if (senaCobradaHoy(info)) cobrar(sena, info.tipoSena);
    if (info.date && info.date !== currentDate) return;   // seña de otro día: solo suma la seña
    if (!isActiva(info)) return;
    horas += info.duration || 1;
    if (!senaOk && info.status !== 'Asistida') pendientes++;
    if (info.status === 'Asistida') {
      cobrar(parseFloat(info.pagoRestante) || 0, info.tipoPagoRestante, parseFloat(info.pagoRestanteTransf) || 0);
    } else {
      aCobrar += Math.max(0, price - (senaOk ? sena : 0));
    }
  });
  return { ingresos, transferencias, efectivo, aCobrar, pendientes, horas };
}

// La seña suma en la caja del día en que se cobró (no en el del turno)
function senaCobradaHoy(info) {
  return (info.estadoSena || 'Pendiente') === 'Recibida' && SheetsAPI.diaSena(info) === currentDate;
}

// Reservas activas del día + canceladas con seña retenida + señas cobradas hoy para otras fechas
function getCajaItems() {
  const retenidas = dayCanceladas
    .filter(r => r.estadoSena === 'Recibida' && (parseFloat(r.sena) || 0) > 0 && senaCobradaHoy(r))
    .map(r => ({ court: courtById(r.court), info: r }));
  const deOtrasFechas = daySenasOtras
    .filter(r => (parseFloat(r.sena) || 0) > 0 && senaCobradaHoy(r))
    .map(r => ({ court: courtById(r.court), info: r }));
  return [...getDayBookings(), ...retenidas, ...deOtrasFechas]
    .sort((a, b) => (a.info.startTime || '').localeCompare(b.info.startTime || '') || a.court.id.localeCompare(b.court.id));
}

function courtById(id) {
  return COURTS.find(c => c.id === id) ||
    { id, type: String(id).slice(0, 2), label: id, name: String(id).startsWith('F7') ? 'Fútbol 7' : 'Fútbol 5' };
}

const isActiva = info => !info || !['Cancelada', 'No vino'].includes(info.status);

// Nombre con el que la base registra mis acciones (igual que usuario_actual())
function yoNombre() {
  const p = SheetsAPI.getProfile();
  return (p.nombre || '').trim() || p.email;
}

function renderHome() {
  if (!document.getElementById('home-section')) return;
  const bookings  = getDayBookings();
  const totals    = computeDayTotals(getCajaItems());
  const capacity  = COURTS.length * TIME_SLOTS.length;
  const occupied  = COURTS.reduce((n, c) => n + (matrixData[c.id] || []).length, 0);
  const pct       = capacity ? Math.round(occupied / capacity * 100) : 0;
  const isToday   = currentDate === todayStr();

  // Subtítulo
  document.getElementById('home-sub').textContent =
    `Resumen de ${isToday ? 'hoy, ' : ''}${formatDateLabel(currentDate).toLowerCase()}.`;

  // KPIs
  document.getElementById('kpi-reservas').textContent        = bookings.length;
  document.getElementById('kpi-reservas-badge').textContent  = totals.horas;
  document.getElementById('kpi-reservas-foot').textContent   = totals.horas === 1 ? 'hora de cancha reservada' : 'horas de cancha reservadas';
  document.getElementById('kpi-ocupacion').textContent       = pct + '%';
  document.getElementById('kpi-ocupacion-badge').textContent = capacity - occupied;
  document.getElementById('kpi-ocupacion-foot').textContent  = `turnos libres de ${capacity}`;
  document.getElementById('kpi-cobrado').textContent         = fmtCurrency(totals.ingresos);
  document.getElementById('kpi-cobrado-foot').textContent    = `Transf. ${fmtCurrency(totals.transferencias)} · Efectivo ${fmtCurrency(totals.efectivo)}`;
  document.getElementById('kpi-pendientes').textContent      = totals.pendientes;
  document.getElementById('kpi-pendientes-badge').textContent = fmtCurrency(totals.aCobrar);
  document.getElementById('kpi-pendientes-foot').textContent = 'resta cobrar en el día';

  const badge = document.getElementById('nav-badge-canchas');
  if (badge) badge.textContent = bookings.length ? bookings.length : '';
  if (currentView === 'caja') renderCaja();
  if (currentView !== 'home') return;

  renderNextBooking(bookings, isToday);
  renderCourtsList(isToday);
  renderBookingList(bookings);
  renderGauge(bookings, capacity);
  updateClockSub();
  renderWeek();
}

function renderNextBooking(bookings, isToday) {
  const el = document.getElementById('next-body');
  const nowHour = new Date().getHours();
  let next = null, label = 'Próximo turno';
  if (currentDate > todayStr()) {
    next = bookings[0];
    label = 'Primer turno del día';
  } else if (isToday) {
    next = bookings.find(b => parseInt(b.info.startTime) > nowHour && b.info.status !== 'Asistida');
    const live = bookings.find(b => parseInt(b.info.startTime) <= nowHour && nowHour < parseInt(b.info.startTime) + (b.info.duration || 1));
    if (!next && live) { next = live; label = 'En juego ahora'; }
  }
  document.querySelector('#next-card .card-title').textContent = label;

  if (!next) {
    el.innerHTML = `<div class="next-empty">${
      currentDate < todayStr() ? 'Este día ya terminó.' : 'No quedan turnos por hoy. Buen momento para cargar reservas.'
    }</div>`;
    el.style.display = 'flex'; el.style.flexDirection = 'column'; el.style.flex = '1';
    return;
  }
  const { court, info } = next;
  const st = bookingState(info);
  el.style.display = 'flex'; el.style.flexDirection = 'column'; el.style.flex = '1';
  el.innerHTML = `
    <div class="next-name">${escHtml(info.name || 'Reserva')}</div>
    <div class="next-meta">
      <span><i class="fas fa-clock"></i> ${escHtml(info.startTime)} – ${escHtml(slotEnd(info.startTime, info.duration))} hs</span>
      <span><i class="fas fa-futbol"></i> ${escHtml(court.name)} · ${escHtml(court.label)}</span>
      <span><i class="fas ${STATE_ICON[st]}"></i> ${STATE_LABEL[st]}</span>
    </div>
    <div style="flex:1;min-height:16px"></div>
    <button class="btn-pill solid" onclick="showBookingDetail('${court.id}','${escHtml(info.startTime)}')"><i class="fas fa-eye"></i> Ver detalle</button>`;
}

function renderCourtsList(isToday) {
  const nowHour = new Date().getHours();
  const html = COURTS.map(c => {
    const booked = matrixData[c.id] || [];
    const details = bookingDetailsMap[c.id] || {};
    const cells = TIME_SLOTS.map(t => {
      let cls = '';
      if (booked.includes(t)) cls = details[t] ? bookingState(details[t]) : 'occupied';
      if (isToday && parseInt(t) === nowHour) cls += ' now';
      const who = details[t]?.name ? ` · ${escHtml(details[t].name)}` : '';
      return `<span class="${cls.trim()}" title="${t}${booked.includes(t) ? who : ' · libre'}"></span>`;
    }).join('');
    return `
      <div class="court-row">
        <div class="court-row-name"><span class="court-type-tag ${c.type.toLowerCase()}">${c.type}</span>${c.label}</div>
        <div class="court-row-count">${booked.length}/${TIME_SLOTS.length}</div>
        <div class="court-timeline">${cells}</div>
      </div>`;
  }).join('');
  document.getElementById('courts-list').innerHTML = html;
}

function renderBookingList(bookings) {
  const el = document.getElementById('booking-list');
  document.getElementById('bookings-sub').textContent = bookings.length
    ? `${bookings.length} turno${bookings.length !== 1 ? 's' : ''} · tocá uno para ver el detalle`
    : 'Todavía no hay turnos cargados';
  if (!bookings.length) {
    el.innerHTML = `<div class="home-empty"><i class="fas fa-calendar-plus"></i>No hay reservas para este día.</div>`;
    return;
  }
  el.innerHTML = bookings.map(({ court, info }) => {
    const st = bookingState(info);
    const initials = (info.name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    return `
      <div class="booking-item" onclick="showBookingDetail('${court.id}','${escHtml(info.startTime)}')">
        <div class="booking-avatar ${st}">${escHtml(initials)}</div>
        <div style="min-width:0">
          <div class="booking-name">${escHtml(info.name || 'Reserva')}</div>
          <div class="booking-meta"><b>${escHtml(info.startTime)}–${escHtml(slotEnd(info.startTime, info.duration))}</b> · ${court.type} ${escHtml(court.label)}</div>
        </div>
        <span class="state-chip ${st}"><i class="fas ${STATE_ICON[st]}"></i> ${STATE_LABEL[st]}</span>
      </div>`;
  }).join('');
}

// Semicírculo: asistidas / señadas / sin seña / libres (en turnos de 1 hora)
function renderGauge(bookings, capacity) {
  const hrs = { asistida: 0, occupied: 0, 'no-sena': 0 };
  COURTS.forEach(c => {
    const details = bookingDetailsMap[c.id] || {};
    (matrixData[c.id] || []).forEach(t => { hrs[details[t] ? bookingState(details[t]) : 'occupied']++; });
  });
  const used = hrs.asistida + hrs.occupied + hrs['no-sena'];
  const free = Math.max(0, capacity - used);
  const pct  = capacity ? Math.round(used / capacity * 100) : 0;

  const R = 82, CX = 100, CY = 96, SW = 22;
  const L = Math.PI * R;
  const arc = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
  const segs = [
    { v: hrs.asistida,   c: '#135133' },
    { v: hrs.occupied,   c: '#5cbf85' },
    { v: hrs['no-sena'], c: '#e0a526' },
  ];
  const GAP = 3;
  let offset = 0, paths = '';
  segs.forEach(s => {
    if (!s.v) return;
    const len = s.v / capacity * L;
    const draw = Math.max(0.5, len - (offset + len < L - 0.5 ? GAP : 0));
    paths += `<path d="${arc}" fill="none" stroke="${s.c}" stroke-width="${SW}" stroke-linecap="butt"
               stroke-dasharray="${draw} ${L}" stroke-dashoffset="${-offset}"/>`;
    offset += len;
  });

  document.getElementById('gauge-wrap').innerHTML = `
    <svg viewBox="0 0 200 110" role="img" aria-label="Ocupación del día: ${pct}%">
      <defs>
        <pattern id="gHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" fill="#fff"/><rect width="2" height="7" fill="#cfd6cf"/>
        </pattern>
      </defs>
      <path d="${arc}" fill="none" stroke="#dfe4de" stroke-width="${SW + 2}"/>
      <path d="${arc}" fill="none" stroke="url(#gHatch)" stroke-width="${SW}"/>
      ${paths}
    </svg>
    <div class="gauge-center"><div class="gauge-value">${pct}%</div><div class="gauge-label">ocupación</div></div>`;

  document.getElementById('gauge-legend').innerHTML = `
    <span><i class="lg-dot" style="background:#135133"></i>Asistidas <b>${hrs.asistida}</b></span>
    <span><i class="lg-dot" style="background:#5cbf85"></i>Señadas <b>${hrs.occupied}</b></span>
    <span><i class="lg-dot" style="background:#e0a526"></i>Sin seña <b>${hrs['no-sena']}</b></span>
    <span><i class="lg-dot hatch"></i>Libres <b>${free}</b></span>`;
}

// —.— Semana —.—
function weekDates(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const monday = new Date(base);
  monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(monday); dt.setDate(monday.getDate() + i);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  });
}

async function getMonthReservas(y, m, force = false) {
  const key = `${y}-${m}`;
  const hit = monthStatsCache[key];
  if (hit && !force && Date.now() - hit.t < 60000) return hit.reservas;
  try {
    await asegurarTurnosFijos(`${y}-${pad(m)}-01`);
    const data = await SheetsAPI.getMonthlyStats(y, m);
    const reservas = (data && data.reservas) || [];
    monthStatsCache[key] = { t: Date.now(), reservas };
    return reservas;
  } catch (e) {
    return hit ? hit.reservas : [];
  }
}

async function renderWeek() {
  const chart = document.getElementById('week-chart');
  if (!chart) return;
  const days     = weekDates(currentDate);
  const capacity = COURTS.length * TIME_SLOTS.length;
  const key      = currentDate + '|' + days[0];
  const firstRender = weekRenderKey !== key;
  weekRenderKey = key;

  // Dibujo inmediato: el día seleccionado sale de la grilla; el resto, del caché
  const draw = (hoursByDay) => {
    const today = todayStr();
    chart.innerHTML = days.map((d, i) => {
      const h   = d === currentDate
        ? COURTS.reduce((n, c) => n + (matrixData[c.id] || []).length, 0)
        : (hoursByDay[d] || 0);
      const pct = Math.min(100, Math.round(h / capacity * 100));
      const dayNum = parseInt(d.slice(8));
      const cls = ['week-col', d === currentDate ? 'selected' : '', d === today ? 'is-today' : ''].join(' ');
      return `
        <div class="${cls}" onclick="pickCalendarDate('${d}')" role="button" aria-label="${WEEK_NAMES[i]} ${dayNum}: ${pct}% (${h} de ${capacity} turnos)">
          <div class="week-track">
            <div class="week-fill" style="height:${pct}%"></div>
            <span class="week-tip" style="bottom:calc(${pct}% + 8px)">${pct}%</span>
          </div>
          <span class="week-day">${WEEK_LETTERS[i]}</span>
        </div>`;
    }).join('');
    const totalH = days.reduce((n, d) => n + (d === currentDate
      ? COURTS.reduce((k, c) => k + (matrixData[c.id] || []).length, 0) : (hoursByDay[d] || 0)), 0);
    const avg = Math.round(totalH / (capacity * 7) * 100);
    let best = 0, bestIdx = 0;
    days.forEach((d, i) => { const h = d === currentDate ? COURTS.reduce((k, c) => k + (matrixData[c.id] || []).length, 0) : (hoursByDay[d] || 0); if (h > best) { best = h; bestIdx = i; } });
    const [, m1, d1] = days[0].split('-').map(Number);
    const [, m7, d7] = days[6].split('-').map(Number);
    document.getElementById('week-sub').textContent = `Semana del ${d1}/${m1} al ${d7}/${m7} · % de turnos reservados`;
    document.getElementById('week-foot').innerHTML =
      `<span>Promedio semanal <b>${avg}%</b></span><span>${totalH} turnos reservados</span>` +
      (best ? `<span>Día más fuerte <b>${WEEK_NAMES[bestIdx]}</b></span>` : '');
  };

  const cachedHours = hoursFromCache(days);
  draw(cachedHours.hours);
  if (!firstRender && cachedHours.complete) return;

  // Cargar meses necesarios (1 o 2) y redibujar
  const months = [...new Set(days.map(d => d.slice(0, 7)))];
  await Promise.all(months.map(ym => { const [y, m] = ym.split('-').map(Number); return getMonthReservas(y, m); }));
  if (weekRenderKey !== key) return; // el usuario cambió de fecha mientras cargaba
  draw(hoursFromCache(days).hours);
}

function hoursFromCache(days) {
  const hours = {};
  let complete = true;
  const months = [...new Set(days.map(d => d.slice(0, 7)))];
  months.forEach(ym => {
    const [y, m] = ym.split('-').map(Number);
    const hit = monthStatsCache[`${y}-${m}`];
    if (!hit || Date.now() - hit.t >= 60000) complete = false;
    (hit?.reservas || []).forEach(r => {
      if (!r || !r.date || !isActiva(r)) return;
      hours[r.date] = (hours[r.date] || 0) + (parseInt(r.duration) || 1);
    });
  });
  return { hours, complete };
}

// —.— Reloj —.—
function startClock() {
  const tick = () => {
    const d = new Date();
    const el = document.getElementById('clock-time');
    if (el) el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (d.getSeconds() === 0) updateClockSub();
  };
  tick();
  updateClockSub();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}

function updateClockSub() {
  const el = document.getElementById('clock-sub');
  if (!el) return;
  const h = new Date().getHours();
  const slot = `${pad(h)}:00`;
  if (!TIME_SLOTS.includes(slot)) {
    el.textContent = `Fuera del horario de turnos (${TIME_SLOTS[0]} a ${parseInt(TIME_SLOTS[TIME_SLOTS.length - 1]) + 1}:00)`;
    return;
  }
  if (currentDate !== todayStr()) {
    el.textContent = `Turno de las ${h}h · estás viendo otro día`;
    return;
  }
  const playing = COURTS.filter(c => (matrixData[c.id] || []).includes(slot)).length;
  el.textContent = `Turno de las ${h}h · ${playing} de ${COURTS.length} canchas en juego`;
}

