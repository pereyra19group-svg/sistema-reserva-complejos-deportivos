// ─────────────────────────────────────────────────────────
//  DASHBOARD — Panel de empleados Complejo Deportivo
// ─────────────────────────────────────────────────────────

// CONFIG
const DASH_PASSWORD = 'anden2026';
const SESSION_KEY   = 'anden_employee_session';

const COURTS = [
  { id: 'F5-1', type: 'F5', label: 'Cancha 1', name: 'Fútbol 5' },
  { id: 'F5-2', type: 'F5', label: 'Cancha 2', name: 'Fútbol 5' },
  { id: 'F5-3', type: 'F5', label: 'Cancha 3', name: 'Fútbol 5' },
  { id: 'F5-4', type: 'F5', label: 'Cancha 4', name: 'Fútbol 5' },
  { id: 'F7-1', type: 'F7', label: 'Cancha 1', name: 'Fútbol 7' },
  { id: 'F7-2', type: 'F7', label: 'Cancha 2', name: 'Fútbol 7' },
];

const TIME_SLOTS = [
  '09:00','10:00','11:00','12:00','13:00','14:00','15:00',
  '16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00'
];

const PRICES = { F5: 45000, F7: 63000 };

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
let currentView        = 'home'; // vista activa: home | dashboard | buffet | monthly
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
function doLogin() {
  const val = document.getElementById('login-pass').value;
  if (val === DASH_PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, '1');
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.add('visible');
    initDashboard();
  } else {
    document.getElementById('login-error').classList.add('show');
    document.getElementById('login-pass').value = '';
    document.getElementById('login-pass').focus();
  }
}

function doLogout() {
  if (dashAutoRefresh) { clearInterval(dashAutoRefresh); dashAutoRefresh = null; }
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
  document.getElementById('login-error').classList.remove('show');
});

// Check session on load
window.addEventListener('DOMContentLoaded', () => {
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.add('visible');
    initDashboard();
  }
});

// —.——.— INIT —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function initDashboard() {
  currentDate = todayStr();
  updateDateDisplay();
  document.getElementById('m-date').value = currentDate;
  initClientAutocomplete();
  loadClientesCache();
  startClock();
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
    const results = await Promise.all(
      COURTS.map(c => SheetsAPI.getAvailability(c.id, currentDate).then(r => ({
        id: c.id, booked: r.bookedSlots || [], details: r.bookingDetails || {}, hasError: !!r.error
      })))
    );
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
        labelHtml = `<span class="slot-name">${firstName}</span><span class="slot-status">${slotStatus}</span>`;
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
  // Recorrer reservas únicas deduplicadas por recordId
  let totalBookings   = 0;
  let ingresos        = 0;
  let transferencias  = 0;
  let efectivo        = 0;
  const seenIds = new Set();

  COURTS.forEach(c => {
    Object.values(bookingDetailsMap[c.id] || {}).forEach(info => {
      if (info && info.recordId && !seenIds.has(info.recordId)) {
        seenIds.add(info.recordId);
        totalBookings++;

        // Seña cobrada
        if ((info.estadoSena || 'Pendiente') === 'Recibida') {
          const monto = parseFloat(info.sena) || 0;
          ingresos += monto;
          if ((info.tipoSena || '') === 'Transferencia') transferencias += monto;
          else if ((info.tipoSena || '') === 'Efectivo') efectivo       += monto;
        }

        // Pago restante cobrado al confirmar asistencia
        if (info.status === 'Asistida') {
          const resto = parseFloat(info.pagoRestante) || 0;
          if (resto > 0) {
            ingresos += resto;
            if ((info.tipoPagoRestante || '') === 'Transferencia') transferencias += resto;
            else if ((info.tipoPagoRestante || '') === 'Efectivo') efectivo       += resto;
          }
        }
      }
    });
  });

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
  const type = document.getElementById('m-type').value;
  const dur  = parseInt(document.getElementById('m-duration').value) || 1;
  if (!type) { document.getElementById('price-preview').style.display = 'none'; return; }
  const total = (PRICES[type] || 0) * dur;
  document.getElementById('price-preview').style.display = 'flex';
  document.getElementById('price-preview-val').textContent =
    '$' + total.toLocaleString('es-AR') + (dur > 1 ? ` (${dur} hs — $${PRICES[type].toLocaleString('es-AR')})` : '');
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

  const result = await SheetsAPI.makeReservation({ court, date, time, duration, name, phone, sena, tipoSena, estadoSena, origen: 'Dashboard' });

  if (result.success) {
    btn.style.display = 'none';
    // Actualización inmediata en memoria para feedback instantáneo
    if (!matrixData[court])        matrixData[court]        = [];
    if (!bookingDetailsMap[court]) bookingDetailsMap[court] = {};
    const courtType   = court.startsWith('F7') ? 'F7' : 'F5';
    const startIdx    = TIME_SLOTS.indexOf(time);
    const bookingInfo = { name, phone, price: (PRICES[courtType] || 0) * duration, startTime: time, duration, status: 'Confirmada', sena, tipoSena, estadoSena, recordId: result.id };
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
  div.innerHTML = `<i class="fas ${isError ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i> ${msg}`;
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
  document.getElementById('confirm-section').style.display = 'none';

  document.getElementById('detail-action-edit').style.display  = info ? '' : 'none';
  document.getElementById('detail-action-delete').style.display = info ? '' : 'none';

  document.getElementById('detail-subtitle').textContent =
    `${court ? court.name + ' — ' + court.label : courtId} · ${dateLabel}`;

  // Botones de seña
  const senaActionsEl = document.getElementById('sena-actions');
  if (info && (info.estadoSena || 'Pendiente') !== 'Recibida') {
    const waPhone = (info.phone || '').replace(/\D/g, '');
    const waMsg   = encodeURIComponent(
      `Hola ${info.name || ''}! Te recordamos que tu reserva del ${dateLabel} a las ${info.startTime}hs necesita seña para confirmarse. Podés pagarla en efectivo en el complejo o transferir y mandarnos el comprobante. ¡Gracias!`
    );
    let senaHtml = `<button class="btn-sena-ok" id="btn-mark-sena" onclick="markSenaReceived()"><i class="fas fa-circle-check"></i> Marcar seña recibida</button>`;
    if ((info.tipoSena || '') === 'Transferencia' && waPhone) {
      senaHtml += `<a class="btn-wa-sena" href="https://wa.me/54${waPhone}?text=${waMsg}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Pedir comprobante</a>`;
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
  const courtType  = courtId.startsWith('F7') ? 'F7' : 'F5';
  const totalPrice = info.price || (PRICES[courtType] || 0) * info.duration;
  const tipoSena   = info.tipoSena   || 'Sin seña';
  const estadoSena = info.estadoSena || 'Pendiente';
  const senaMonto  = info.sena || 0;

  const senaMostrar = tipoSena === 'Sin seña'
    ? 'Sin seña'
    : (senaMonto > 0 ? `$${senaMonto.toLocaleString('es-AR')} · ${tipoSena}` : tipoSena);

  const rows = [
    { icon: 'fa-user',              label: 'Cliente',     value: info.name },
    { icon: 'fa-phone',             label: 'WhatsApp',    value: info.phone },
    { icon: 'fa-clock',             label: 'Hora inicio', value: info.startTime },
    { icon: 'fa-flag-checkered',    label: 'Hora fin',    value: endTime },
    { icon: 'fa-hourglass-half',    label: 'Duración',    value: `${info.duration} hora${info.duration > 1 ? 's' : ''}` },
    { icon: 'fa-dollar-sign',       label: 'Costo total', value: '$' + totalPrice.toLocaleString('es-AR'), highlight: true },
    { icon: 'fa-circle-check',      label: 'Estado',      value: info.status || 'Confirmada' },
    { icon: 'fa-hand-holding-dollar', label: 'Seña',      value: senaMostrar, isSena: true, senaEstado: estadoSena },
    ...(senaMonto > 0 ? [{ icon: 'fa-money-bill-wave', label: 'Resta pagar', value: '$' + Math.max(0, totalPrice - senaMonto).toLocaleString('es-AR'), restaPagar: true }] : []),
  ];

  if (info.notas) {
    rows.push({ icon: 'fa-note-sticky', label: 'Notas', value: info.notas });
  }

  const html = rows.map((r, i) => {
    const iconColor = r.isSena
      ? (r.senaEstado === 'Recibida' ? 'var(--green)' : 'var(--yellow)')
      : r.restaPagar ? 'var(--green)'
      : (r.highlight ? 'var(--yellow)' : 'var(--text-muted)');

    const valueHtml = r.isSena
      ? `<div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
           <span style="font-size:14px;font-weight:600;color:var(--text)">${r.value}</span>
           <span class="sena-badge ${r.senaEstado === 'Recibida' ? 'recibida' : 'pendiente'}">
             <i class="fas ${r.senaEstado === 'Recibida' ? 'fa-circle-check' : 'fa-clock'}"></i>
             ${r.senaEstado === 'Recibida' ? 'Recibida' : 'Pendiente'}
           </span>
         </div>`
      : r.restaPagar
      ? `<div style="font-size:18px;font-weight:800;color:var(--green);margin-top:2px">${r.value}</div>`
      : `<div style="font-size:14px;font-weight:${r.highlight ? '800' : '600'};color:${r.highlight ? 'var(--yellow)' : 'var(--text)'};margin-top:2px;white-space:pre-wrap">${r.value}</div>`;

    return `
    <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;${i < rows.length - 1 ? 'border-bottom:1px solid rgba(0,0,0,0.06)' : ''}">
      <div style="width:34px;height:34px;background:rgba(0,0,0,0.06);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">
        <i class="fas ${r.icon}" style="font-size:13px;color:${iconColor}"></i>
      </div>
      <div style="flex:1">
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600">${r.label}</div>
        ${valueHtml}
      </div>
    </div>`;
  }).join('');

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
  const type = document.getElementById('e-type').value;
  const dur  = parseInt(document.getElementById('e-duration').value) || 1;
  if (!type) { document.getElementById('edit-price-preview').style.display = 'none'; return; }
  const total = (PRICES[type] || 0) * dur;
  document.getElementById('edit-price-preview').style.display = 'flex';
  document.getElementById('edit-price-preview-val').textContent =
    '$' + total.toLocaleString('es-AR') + (dur > 1 ? ` (${dur} hs — $${PRICES[type].toLocaleString('es-AR')})` : '');
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
    btn.textContent = 'Error — reintentar';
    setTimeout(() => { btn.textContent = 'Sí, eliminar'; }, 2000);
  }
}

// —.——.— NAVIGATION —.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.——.—
function setView(view) {
  currentView = view;
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
  document.getElementById('monthly-section').style.display = isMonthly ? 'block' : 'none';
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
        if (info && info.recordId === recordId) info.estadoSena = 'Recibida';
      });
    }
    if (currentDetailInfo) currentDetailInfo.estadoSena = 'Recibida';
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
  if (eBtn) { eBtn.className = 'pay-method-btn' + (method === 'Efectivo'      ? ' selected-efect'  : ''); }
  const confirmBtn = document.getElementById('btn-confirm-attendance');
  if (confirmBtn) confirmBtn.disabled = false;
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

  const btn = document.getElementById('btn-confirm-attendance');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Confirmando...';
  }

  const result = await SheetsAPI.confirmAttendance({
    recordId,
    tipoPago:     restaPagar > 0 ? selectedPayMethod : '',
    pagoRestante: restaPagar,
  });

  if (result.success) {
    const tipoPagoUsado = restaPagar > 0 ? selectedPayMethod : '';
    if (currentDetailCourt) {
      Object.values(bookingDetailsMap[currentDetailCourt] || {}).forEach(info => {
        if (info && info.recordId === recordId) {
          info.status           = 'Asistida';
          info.pagoRestante     = restaPagar;
          info.tipoPagoRestante = tipoPagoUsado;
        }
      });
    }
    if (currentDetailInfo) {
      currentDetailInfo.status           = 'Asistida';
      currentDetailInfo.pagoRestante     = restaPagar;
      currentDetailInfo.tipoPagoRestante = tipoPagoUsado;
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

function shiftMonth(delta) {
  monthlyMonth += delta;
  if (monthlyMonth > 12) { monthlyMonth = 1; monthlyYear++; }
  if (monthlyMonth < 1)  { monthlyMonth = 12; monthlyYear--; }
  loadMonthlyStats();
}

async function loadMonthlyStats() {
  const wrap = document.getElementById('monthly-wrap');
  if (!wrap) return;

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

  const [statsData, egresosData] = await Promise.all([
    SheetsAPI.getMonthlyStats(monthlyYear, monthlyMonth),
    SheetsAPI.getEgresos({ year: monthlyYear, month: monthlyMonth })
  ]);
  renderMonthlyView(statsData, egresosData);
}

function renderMonthlyView(data, egresosData) {
  const wrap = document.getElementById('monthly-wrap');
  if (!wrap) return;

  const { stats = {}, reservas = [], error: statsError } = data || {};
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
  const dailyHtml = buildDailyPlanilla(reservas, egresos, label);

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
      const statusCls = r.status === 'Asistida' ? 'asistida' : 'confirmada';
      const statusIco = r.status === 'Asistida'
        ? '<i class="fas fa-circle-check"></i> Asistida'
        : '<i class="fas fa-calendar-check"></i> Confirmada';
      const senaCls   = r.tipoSena === 'Sin seña' ? 'sin-sena'
        : r.estadoSena === 'Recibida' ? 'recibida' : 'pendiente';
      const senaLabel = r.tipoSena === 'Sin seña' ? 'Sin seña'
        : (r.sena > 0 ? '$' + r.sena.toLocaleString('es-AR') : r.tipoSena);
      const stripeClass = i % 2 !== 0 ? ' stripe' : '';

      return `
        <tr class="monthly-tr${stripeClass}">
          <td class="monthly-td">${dayLabel}</td>
          <td class="monthly-td"><span class="court-pill ${courtCls}">${r.court}</span></td>
          <td class="monthly-td" style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis">${r.name}</td>
          <td class="monthly-td">${r.time}</td>
          <td class="monthly-td">${r.duration}h</td>
          <td class="monthly-td" style="font-weight:700">${fmtCurrency(r.price)}</td>
          <td class="monthly-td"><span class="sena-pill ${senaCls}">${senaLabel}</span></td>
          <td class="monthly-td"><span class="status-pill ${statusCls}">${statusIco}</span></td>
        </tr>`;
    }).join('');

    reservasTableHtml = `
      <div class="monthly-table-card" style="margin-top:20px">
        <div class="monthly-table-header">
          <i class="fas fa-list"></i>
          <span class="mth-title">Detalle de reservas — ${label}</span>
          <span class="mth-count">${totalBookings} reserva${totalBookings !== 1 ? 's' : ''}</span>
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
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
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
        ? `<span style="color:var(--text-dim)">${eg.desc}</span>`
        : `<span style="color:#cbd5e1;font-style:italic">—</span>`;
      return `
        <tr class="monthly-tr${stripeClass}">
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
                <th class="monthly-th">Acciones</th>
              </tr>
            </thead>
            <tbody>${eRows}</tbody>
          </table>
        </div>
      </div>`;
  }

  wrap.innerHTML = navHtml + ingresosHtml + egresosHtml + netaHtml + dailyHtml + reservasTableHtml + egresosTableHtml;
}

function buildDailyPlanilla(reservas, egresos, label) {
  // Agrupar ingresos por fecha
  const incomeByDay = {};
  reservas.forEach(r => {
    if (!incomeByDay[r.date]) incomeByDay[r.date] = { totalBruta: 0 };
    incomeByDay[r.date].totalBruta += (r.price || 0);
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
      <tr class="monthly-tr${stripeClass}">
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
  if (info.status === 'Asistida') return 'asistida';
  return (info.estadoSena || 'Pendiente') === 'Recibida' ? 'occupied' : 'no-sena';
}
const STATE_LABEL = { asistida: 'Asistida', occupied: 'Señado', 'no-sena': 'Sin seña' };
const STATE_ICON  = { asistida: 'fa-circle-check', occupied: 'fa-hand-holding-dollar', 'no-sena': 'fa-clock' };

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

function computeDayTotals(bookings) {
  let ingresos = 0, transferencias = 0, efectivo = 0, aCobrar = 0, pendientes = 0, horas = 0;
  bookings.forEach(({ court, info }) => {
    const price = parseFloat(info.price) || (PRICES[court.type] || 0) * (info.duration || 1);
    const senaOk = (info.estadoSena || 'Pendiente') === 'Recibida';
    const sena   = parseFloat(info.sena) || 0;
    horas += info.duration || 1;
    if (senaOk) {
      ingresos += sena;
      if (info.tipoSena === 'Transferencia') transferencias += sena;
      else if (info.tipoSena === 'Efectivo') efectivo += sena;
    } else if (info.status !== 'Asistida') {
      pendientes++;
    }
    if (info.status === 'Asistida') {
      const resto = parseFloat(info.pagoRestante) || 0;
      ingresos += resto;
      if (info.tipoPagoRestante === 'Transferencia') transferencias += resto;
      else if (info.tipoPagoRestante === 'Efectivo') efectivo += resto;
    } else {
      aCobrar += Math.max(0, price - (senaOk ? sena : 0));
    }
  });
  return { ingresos, transferencias, efectivo, aCobrar, pendientes, horas };
}

function renderHome() {
  if (!document.getElementById('home-section')) return;
  const bookings  = getDayBookings();
  const totals    = computeDayTotals(bookings);
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
      if (!r || !r.date) return;
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

