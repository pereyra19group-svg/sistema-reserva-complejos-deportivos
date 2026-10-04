# Simulación de jornada — sábado 3/10/2026

Entorno de prueba (no es tu Supabase real): base local con las migraciones 001–006 y el panel actual de tu carpeta. Usuarios: Seba (jefe), Lucas (turno mañana), Caro (turno tarde). El viernes 2/10 el bot de WhatsApp tomó 5 reservas (4 con seña cobrada ese día). Los Pibes FC tiene turno fijo los sábados a las 18.

**Resultado: 30 de 30 chequeos OK.**

Caja del sábado (panel = cálculo a mano = base de datos): total $432.000 · efectivo $246.000 · transferencias $186.000 · por cobrar $0.
Caja del viernes: $70.000 (señas del bot; la de Pato no cuenta porque se devolvió).

| Hora | Quién | Paso | OK | Detalle |
|---|---|---|---|---|
| 09:00 | Lucas | Ve el dashboard al llegar | ✔ | reservas del día: 6 (esperadas 6: 5 de WhatsApp + 1 turno fijo) |
| 09:00 | Lucas | Empleado no ve "Actividad" ni "Equipo" | ✔ |  |
| 09:05 | Lucas | Reserva Martín Gómez F5-2 10:00 (seña transf. pendiente, cliente elegido del autocompletado) | ✔ | ¡Reserva confirmada exitosamente! |
| 09:12 | Lucas | Reserva Escuela Fútbol Sur F7-1 11:00 x2h | ✔ | ¡Reserva confirmada exitosamente! |
| 09:20 | Lucas | La base bloquea la reserva que pisa el turno fijo | ✔ | Ese horario se superpone con otra reserva en esa cancha. |
| 09:30 | Lucas | Crea turno fijo Oficina Contable (sábados 13:00 F5-3) | ✔ | ¡Turno fijo creado! Queda reservado todas las semanas, todos los meses, hasta que lo des de baja. — repeticiones cargadas: 13 |
| 09:40 | Lucas | Link "Pedir comprobante" con número argentino correcto | ✔ | https://wa.me/5491155554444 |
| 10:05 | Lucas | Asistencia Martín, resto $35.000 transf. | ✔ | Asistida / resto 35000 |
| 11:08 | Lucas | Asistencia Escuela, resto $106.000 efectivo | ✔ | Asistida / resto 106000 |
| 14:10 | Lucas | Marca "No vino" en Oficina Contable y la cancha queda libre | ✔ |  |
| 14:25 | Lucas | Caja a mitad del día | ✔ | cobrado $171.000 |
| 15:02 | Caro | Cancela Pato (seña devuelta) y libera la F5-1 | ✔ |  |
| 15:50 | Caro | Reserva en el momento: Kevin F5-4 16:00 (sin seña, tel. de Córdoba) | ✔ | ¡Reserva confirmada exitosamente! |
| 16:05 | Caro | Asistencia Kevin, $45.000 efectivo | ✔ |  |
| 17:05 | Caro | Asistencia Nico, resto $30.000 efectivo | ✔ |  |
| 17:30 | Caro | Cancela Rama (seña retenida $25.000) | ✔ |  |
| 17:40 | Caro | Mueve a Juli de 21:00 a 22:00 | ✔ |  |
| 18:03 | Caro | Asistencia Los Pibes FC (turno fijo), $45.000 efectivo | ✔ |  |
| 19:10 | Caro | Asistencia Torneo, resto $96.000 transf. | ✔ |  |
| 19:30 | Caro | Empleado no puede eliminar (ni por la interfaz ni por la API) | ✔ | Solo un jefe puede eliminar reservas. Usá "Cancelar reserva". |
| 22:05 | Caro | Asistencia Juli 22:00, $45.000 transf. | ✔ |  |
| 23:30 | Caro | Cierre de caja coincide con el cálculo a mano | ✔ | total $432.000 · efectivo $246.000 · transf. $186.000 · por cobrar $0 |
| 23:45 | Seba | Ve el historial del día | ✔ | 16 movimientos |
| 23:46 | Seba | Filtra lo que hizo Caro | ✔ | 9 movimientos de Caro |
| 23:50 | Seba | Registra egreso y ve el control mensual | ✔ | ingresos del mes $502.000 |
| 23:55 | Seba | Edita turno fijo de Oficina Contable a las 14:00 | ✔ | Turno fijo actualizado. Las próximas fechas ya tienen el horario nuevo. |
| 23:57 | Seba | Ve la última conexión del equipo | ✔ | Carocaro@test.com Últ. vez hace 9 h Empleado Jefe Activo Dado de baja Nueva temporal Lucasemp@test.com Últ. vez hace 15  |
| 23:57 | Seba | Caja del viernes 2/10 con las señas del bot ($70.000) | ✔ | $70.000 |
| 23:58 | Seba | Sábado 10/10: turno fijo movido a las 14 y el de las 13 libre | ✔ |  |
| 23:59 | Seba | Febrero 2027: los turnos fijos siguen apareciendo | ✔ |  |
