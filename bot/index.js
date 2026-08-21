/**
 * WhatsApp Bot — Complejo Doble AA
 * Usa Baileys (multi-device, sin Chromium)
 *
 * AUTENTICACIÓN EN RAILWAY:
 *   1. Montá un Volume en Railway apuntando a /app/auth_info
 *   2. Seteá la variable BOT_PHONE_NUMBER con el número del bot (ej: 5491112345678)
 *   3. Al primer arranque aparece en los logs: 🔑 CÓDIGO DE VINCULACIÓN: XXXX-XXXX
 *   4. Ingresalo en WhatsApp → Dispositivos vinculados → Vincular con número de teléfono
 *   5. La sesión queda guardada en el Volume y no hace falta repetir el proceso
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import QRCode from 'qrcode'
import http from 'http'

// ── Config ────────────────────────────────────────────────────────
const API_URL     = process.env.API_URL    || 'https://complejo-doble-aa-production.up.railway.app'
const MP_TOKEN    = process.env.MP_ACCESS_TOKEN || ''
const ALIAS_MP    = process.env.ALIAS_MP   || 'complejo.a'
const TITULAR_MP  = process.env.TITULAR_MP || 'Distriviandas SA'
const MONTO_SENIA = parseInt(process.env.MONTO_SENIA || '10000')
// Número del bot SIN + ni espacios, ej: 5491127471538
// Necesario solo para el primer arranque (vinculación)
const BOT_PHONE   = process.env.BOT_PHONE_NUMBER || ''

const HORARIOS = [17, 18, 19, 20, 21, 22, 23]
const CANCHAS  = [1, 2]
const PORT = process.env.PORT || 3000

// ── Servidor QR ───────────────────────────────────────────────────
// Sirve el QR como imagen PNG para escanear con el celular
let qrPngBuffer = null
const qrServer = http.createServer(async (req, res) => {
  if (qrPngBuffer) {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(qrPngBuffer)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h2>⏳ Esperando QR... refrescá en unos segundos</h2>')
  }
})
qrServer.listen(PORT, () => {
  console.log(`🌐 Servidor QR escuchando en puerto ${PORT}`)
})

// ── Difusión automática ────────────────────────────────────────────
// Horas en que se mandan mensajes a clientes (hora Argentina, UTC-3)
const HORAS_DIFUSION = (process.env.HORAS_DIFUSION || '10,13')
  .split(',').map(h => parseInt(h.trim()))

// Mensaje configurable por variable de entorno, o el default
const MENSAJE_DIFUSION = process.env.MENSAJE_DIFUSION ||
  `¡Hola! 👋 Soy el bot del *Complejo Doble AA*.\n\n` +
  `⚽ Tenemos turnos disponibles para hoy y esta semana.\n` +
  `¿Te anotamos? Escribime el día y el horario que preferís.\n\n` +
  `_(Respondé *STOP* si no querés recibir más mensajes)_`

// Registro para no mandar 2 veces en el mismo día/hora
const difusionEnviada = new Set() // "YYYY-MM-DD_HH"

// ── Estado por usuario ────────────────────────────────────────────
// states: INIT | AWAITING_DAY | SHOWING_AVAILABILITY | AWAITING_PAYMENT | AWAITING_NAME | DONE
const sessions = {}

function getSession(jid) {
  if (!sessions[jid]) {
    sessions[jid] = {
      state: 'INIT',
      selectedDay: null,
      selectedHour: null,
      selectedCancha: null,
      paymentRetries: 0
    }
  }
  return sessions[jid]
}

function resetSession(jid) {
  sessions[jid] = {
    state: 'INIT',
    selectedDay: null,
    selectedHour: null,
    selectedCancha: null,
    paymentRetries: 0
  }
}

// ── Helpers de fecha ──────────────────────────────────────────────
function getSaludo() {
  // Argentina UTC-3
  const h = (new Date().getUTCHours() - 3 + 24) % 24
  if (h >= 6  && h < 13) return 'Buenos días'
  if (h >= 13 && h < 20) return 'Buenas tardes'
  return 'Buenas noches'
}

function hoy() {
  const d = new Date(new Date().getTime() - 3 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

function tomorrow() {
  const d = new Date(new Date().getTime() - 3 * 60 * 60 * 1000)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

function parseFechaFromText(text) {
  const lower = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (lower.includes('hoy'))    return hoy()
  if (lower.includes('manana') || lower.includes('mañana')) return tomorrow()

  const diasMap = {
    'lunes':    1, 'martes': 2, 'miercoles': 3, 'miércoles': 3,
    'jueves':   4, 'viernes': 5, 'sabado': 6, 'sábado': 6, 'domingo': 0
  }
  for (const [nombre, num] of Object.entries(diasMap)) {
    if (lower.includes(nombre)) {
      const d = new Date(new Date().getTime() - 3 * 60 * 60 * 1000)
      const current = d.getDay()
      let diff = num - current
      if (diff <= 0) diff += 7
      d.setDate(d.getDate() + diff)
      return d.toISOString().slice(0, 10)
    }
  }
  // Formato DD/MM
  const m = text.match(/(\d{1,2})[\/\-](\d{1,2})/)
  if (m) {
    const d = new Date()
    const año = d.getFullYear()
    return `${año}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`
  }
  return null
}

function formatDateSpanish(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, mo - 1, d)
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado']
  const meses = ['enero','febrero','marzo','abril','mayo','junio',
                 'julio','agosto','septiembre','octubre','noviembre','diciembre']
  return `${dias[dt.getDay()]} ${d} de ${meses[mo - 1]}`
}

function getLunesDe(fechaStr) {
  const [y, mo, d] = fechaStr.split('-').map(Number)
  const dt = new Date(y, mo - 1, d)
  const dow = dt.getDay()
  const diasDesdeLunes = (dow + 6) % 7
  dt.setDate(dt.getDate() - diasDesdeLunes)
  return dt.toISOString().slice(0, 10)
}

// ── API calls ─────────────────────────────────────────────────────
async function getDisponibilidad(fecha) {
  try {
    const lunes = getLunesDe(fecha)
    const res = await fetch(`${API_URL}/api/agenda?semana=${lunes}`)
    const data = await res.json()

    const ocupados = new Set()
    for (const r of (data.reservas || [])) {
      if (r.fecha === fecha && r.estado !== 'cancelado') {
        ocupados.add(`${r.hora}-${r.cancha}`)
      }
    }

    const libres = []
    for (const hora of HORARIOS) {
      for (const cancha of CANCHAS) {
        if (!ocupados.has(`${hora}-${cancha}`)) {
          libres.push({ hora, cancha })
        }
      }
    }
    return libres
  } catch (e) {
    console.error('Error getDisponibilidad:', e)
    return null
  }
}

async function crearLinkPago(jid, hora, cancha, fecha) {
  if (!MP_TOKEN) return null
  try {
    const externalRef = `wa_${jid.replace('@s.whatsapp.net', '')}_${hora}_${cancha}`
    const body = {
      items: [{
        title: `Seña cancha ${cancha} — ${hora}hs ${formatDateSpanish(fecha)}`,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: MONTO_SENIA
      }],
      external_reference: externalRef,
      statement_descriptor: 'Complejo Doble AA'
    }
    const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (data.init_point) {
      console.log(`✅ Link de pago creado para ${jid}: ${data.init_point}`)
      return { url: data.init_point, ref: externalRef }
    }
    console.error('Error MP preferences:', JSON.stringify(data))
    return null
  } catch (e) {
    console.error('Error crearLinkPago:', e)
    return null
  }
}

async function verificarPagoMP(externalRef) {
  if (!MP_TOKEN) {
    console.log('⚠️  MP_ACCESS_TOKEN no configurado — aprobando pago automáticamente (modo test)')
    return true
  }
  try {
    if (externalRef) {
      const url = `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(externalRef)}&status=approved`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${MP_TOKEN}` } })
      const data = await res.json()
      console.log(`🔍 Verificando pago por ref ${externalRef}: ${data.results?.length || 0} resultados`)
      return !!(data.results && data.results.length > 0)
    }
    // Fallback por monto si no hay referencia
    const now = new Date()
    const since = new Date(now.getTime() - 6 * 60 * 60 * 1000)
    const url = `https://api.mercadopago.com/v1/payments/search?status=approved&sort=date_created&criteria=desc&range=date_created&begin_date=${since.toISOString()}&end_date=${now.toISOString()}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${MP_TOKEN}` } })
    const data = await res.json()
    if (data.results && data.results.length > 0) {
      const match = data.results.find(p => Math.abs(p.transaction_amount - MONTO_SENIA) < 500)
      return !!match
    }
    return false
  } catch (e) {
    console.error('Error verificarPagoMP:', e)
    return false
  }
}

async function crearReserva(fecha, hora, cancha, clienteNombre) {
  try {
    const res = await fetch(`${API_URL}/api/reservas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fecha,
        hora: String(hora),
        cancha,
        cliente_nombre: clienteNombre,
        estado: 'señado',
        monto_senia: MONTO_SENIA,
        monto_total: MONTO_SENIA,
        monto_pagado: MONTO_SENIA,
        notas: 'Reserva via WhatsApp Bot'
      })
    })
    return res.ok
  } catch (e) {
    console.error('Error crearReserva:', e)
    return false
  }
}

// ── Procesador de mensajes ────────────────────────────────────────
async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid
  if (!jid || jid.includes('@broadcast') || jid.endsWith('@g.us')) return
  if (msg.key.fromMe) return

  const text = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    ''
  ).trim()

  const hasImage = !!(msg.message?.imageMessage)
  const session = getSession(jid)

  const send = async (txt) => {
    await sock.sendMessage(jid, { text: txt })
  }

  // Comando STOP — opt-out de difusión
  if (text.toLowerCase() === 'stop') {
    stopList.add(jid)
    await send('✅ Listo, no te vamos a mandar más mensajes de difusión.\nSi querés reservar una cancha, escribinos cuando quieras.')
    return
  }

  // Comando reset
  if (text.toLowerCase() === '/reset' || text.toLowerCase() === 'cancelar') {
    resetSession(jid)
    await send('🔄 Reiniciado. ¡Hola de nuevo!')
    session.state = 'AWAITING_DAY'
    await send(`${getSaludo()} 👋 Soy el bot del *Complejo Doble AA*.\n\n¿Querés saber la disponibilidad para *hoy*, *mañana* u otro día? (ej: "lunes", "martes 25/8")`)
    return
  }

  // ── INIT / DONE → bienvenida ──────────────────────────────────
  if (session.state === 'INIT' || session.state === 'DONE') {
    session.state = 'AWAITING_DAY'
    await send(
      `${getSaludo()} 👋 Soy el bot del *Complejo Doble AA*.\n\n` +
      `¿Querés saber la disponibilidad para *hoy*, *mañana* u otro día?\n` +
      `_(Escribí "hoy", "mañana", "lunes", "martes", etc.)_`
    )
    return
  }

  // ── AWAITING_DAY → interpreta el día ─────────────────────────
  if (session.state === 'AWAITING_DAY') {
    const fecha = parseFechaFromText(text)
    if (!fecha) {
      await send(`No entendí el día 🤔 Escribí por ejemplo: *hoy*, *mañana*, *lunes*, *sábado*, o una fecha como *25/8*.`)
      return
    }

    session.selectedDay = fecha
    session.state = 'SHOWING_AVAILABILITY'

    await send(`⏳ Consultando disponibilidad para el *${formatDateSpanish(fecha)}*...`)
    const libres = await getDisponibilidad(fecha)

    if (!libres || libres.length === 0) {
      await send(`😔 No hay turnos disponibles para el *${formatDateSpanish(fecha)}*.\n\n¿Querés consultar otro día?`)
      session.state = 'AWAITING_DAY'
      return
    }

    const byHora = {}
    libres.forEach(({ hora, cancha }) => {
      if (!byHora[hora]) byHora[hora] = []
      byHora[hora].push(cancha)
    })

    let resp = `✅ Turnos disponibles — *${formatDateSpanish(fecha)}*:\n\n`
    Object.keys(byHora).sort((a, b) => a - b).forEach(hora => {
      const cs = byHora[hora].sort()
      resp += `🕐 *${hora}hs* — Cancha ${cs.join(' y ')}\n`
    })
    resp += `\n¿Qué horario querés? (ej: *"18hs"*, *"19hs cancha 2"*)`
    await send(resp)
    return
  }

  // ── SHOWING_AVAILABILITY → elige horario ─────────────────────
  if (session.state === 'SHOWING_AVAILABILITY') {
    const horaMatch = text.match(/(1[7-9]|2[0-3])(?::00)?\s*(?:hs|horas?|h)?/)
    if (!horaMatch) {
      await send(`No entendí el horario. Escribí algo como *"18hs"* o *"20hs cancha 1"*.`)
      return
    }

    const hora = parseInt(horaMatch[1])
    const lower = text.toLowerCase()
    const prefCancha2 = lower.includes('cancha 2') || /cancha\s*2/.test(lower)

    const libres = await getDisponibilidad(session.selectedDay)
    const slotsHora = libres?.filter(s => s.hora === hora)

    if (!slotsHora || slotsHora.length === 0) {
      await send(`❌ Ese horario ya no está disponible. Elegí otro.`)
      return
    }

    let cancha = slotsHora[0].cancha
    if (prefCancha2 && slotsHora.find(s => s.cancha === 2)) cancha = 2

    session.selectedHour   = hora
    session.selectedCancha = cancha
    session.state = 'AWAITING_PAYMENT'

    const linkPago = await crearLinkPago(jid, hora, cancha, session.selectedDay)
    if (linkPago) {
      session.paymentRef = linkPago.ref
      await send(
        `✅ *${formatDateSpanish(session.selectedDay)}* — *${hora}hs* — Cancha *${cancha}*\n\n` +
        `💵 La seña es de *$${MONTO_SENIA.toLocaleString('es-AR')}*\n\n` +
        `💳 Pagá la seña acá (tarjeta, débito o saldo MP):\n${linkPago.url}\n\n` +
        `Cuando pagaste, escribí *"listo"* y verifico automáticamente ✅`
      )
    } else {
      await send(
        `✅ *${formatDateSpanish(session.selectedDay)}* — *${hora}hs* — Cancha *${cancha}*\n\n` +
        `💵 La seña es de *$${MONTO_SENIA.toLocaleString('es-AR')}*\n\n` +
        `💳 Transferí al alias: *${ALIAS_MP}*\n` +
        `👤 Titular: ${TITULAR_MP}\n\n` +
        `Cuando lo hagas, *mandame la captura del comprobante* 📸`
      )
    }
    return
  }

  // ── AWAITING_PAYMENT → espera captura ────────────────────────
  if (session.state === 'AWAITING_PAYMENT') {
    if (!hasImage && !text.toLowerCase().includes('listo') && !text.toLowerCase().includes('pague') && !text.toLowerCase().includes('ya pague') && !text.toLowerCase().includes('ya pagué') && !text.toLowerCase().includes('pagado')) {
      await send(
        `Mandame la *captura del comprobante* de pago 📸\n` +
        `_(alias: *${ALIAS_MP}* — $${MONTO_SENIA.toLocaleString('es-AR')})_`
      )
      return
    }

    await send(`⏳ Verificando el pago con MercadoPago...`)
    const confirmado = await verificarPagoMP(session.paymentRef || null)

    if (confirmado) {
      session.state = 'AWAITING_NAME'
      await send(`✅ *¡Pago confirmado!* 🎉\n\n¿A nombre de quién hacemos la reserva?`)
    } else {
      session.paymentRetries = (session.paymentRetries || 0) + 1
      if (session.paymentRetries >= 3) {
        await send(
          `⚠️ No encontré el pago aún. A veces tarda unos minutos en acreditarse.\n\n` +
          `Si ya pagaste, escribí *"ya pagué"* para reintentar, o contactate directamente:\n📞 *11 2747-1538*`
        )
      } else {
        await send(`⚠️ No encontré el pago todavía. Puede tardar unos minutos. Mandá la captura de nuevo cuando acredite.`)
      }
    }
    return
  }

  // ── AWAITING_NAME → nombre del cliente ───────────────────────
  if (session.state === 'AWAITING_NAME') {
    if (text.length < 2) {
      await send(`¿Tu nombre completo?`)
      return
    }

    const nombre = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    const diaStr = formatDateSpanish(session.selectedDay)

    const ok = await crearReserva(
      session.selectedDay,
      session.selectedHour,
      session.selectedCancha,
      nombre
    )

    if (ok) {
      session.state = 'DONE'
      await send(
        `🏆 *¡Reserva confirmada!*\n\n` +
        `👤 *${nombre}*\n` +
        `📅 ${diaStr} a las *${session.selectedHour}hs*\n` +
        `🏟️ Cancha *${session.selectedCancha}*\n` +
        `💵 Seña: *$${MONTO_SENIA.toLocaleString('es-AR')}*\n\n` +
        `¡Te esperamos en *Complejo Doble AA*! ⚽🥅`
      )
    } else {
      await send(
        `❌ Hubo un problema al registrar la reserva. El turno puede que ya esté tomado.\n` +
        `Contactate directamente: 📞 *11 2747-1538*`
      )
      resetSession(jid)
    }
    return
  }
}

// ── Lista STOP (opt-out de difusión) ─────────────────────────────
const stopList = new Set() // jids que no quieren recibir difusiones

// ── Difusión automática ───────────────────────────────────────────
async function obtenerClientesConTelefono() {
  try {
    const res = await fetch(`${API_URL}/api/clientes`)
    if (!res.ok) return []
    const clientes = await res.json()
    // Solo los que tienen teléfono cargado
    return clientes.filter(c => c.telefono && c.telefono.trim() !== '')
  } catch (e) {
    console.error('Error obteniendo clientes:', e.message)
    return []
  }
}

function formatearJid(telefono) {
  // Limpiar el número: solo dígitos, agregar @s.whatsapp.net
  const limpio = telefono.replace(/\D/g, '')
  // Si empieza con 0 (ej: 011...), quitarlo y agregar 54 (Argentina)
  let numero = limpio
  if (numero.startsWith('0')) numero = '54' + numero.slice(1)
  // Si no tiene código de país (menos de 11 dígitos), asumir Argentina
  if (numero.length <= 10) numero = '54' + numero
  // WhatsApp Argentina: el 9 va después del 54 para celulares
  // ej: 54 9 11 2747-1538 → 5491127471538
  return `${numero}@s.whatsapp.net`
}

// ── Consulta turnos libres de hoy ─────────────────────────────────
async function getTurnosLibresHoy() {
  try {
    const ahora = new Date(new Date().getTime() - 3 * 60 * 60 * 1000)
    const fecha = ahora.toISOString().slice(0, 10)
    const horaActual = ahora.getUTCHours()

    const lunes = getLunesDe(fecha)
    const res = await fetch(`${API_URL}/api/agenda?semana=${lunes}`)
    if (!res.ok) return []
    const data = await res.json()

    const ocupados = new Set()
    for (const r of (data.reservas || [])) {
      if (r.fecha === fecha && r.estado !== 'cancelado') {
        ocupados.add(`${r.hora}-${r.cancha}`)
      }
    }

    // Solo horarios FUTUROS a partir de la hora actual + 1
    const libres = []
    for (const hora of HORARIOS) {
      if (hora <= horaActual) continue  // Ya pasó o es la hora actual
      for (const cancha of CANCHAS) {
        if (!ocupados.has(`${hora}-${cancha}`)) {
          libres.push({ hora, cancha })
        }
      }
    }
    return libres
  } catch (e) {
    console.error('Error consultando disponibilidad:', e.message)
    return []
  }
}

// ── Envío masivo a clientes ───────────────────────────────────────
async function enviarAClientes(sock, mensaje) {
  const clientes = await obtenerClientesConTelefono()
  if (clientes.length === 0) {
    console.log('📣 No hay clientes con teléfono. Cargalos en panel → Clientes.')
    return
  }

  let enviados = 0, omitidos = 0, errores = 0

  for (const cliente of clientes) {
    const jid = formatearJid(cliente.telefono)
    if (stopList.has(jid)) { omitidos++; continue }

    try {
      const nombre = cliente.nombre.split(' ')[0]
      await sock.sendMessage(jid, { text: `Hola *${nombre}*! ${mensaje}` })
      enviados++
      // Pausa anti-spam: 2 a 4 segundos entre mensajes
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000))
    } catch (e) {
      console.error(`Error enviando a ${cliente.nombre}:`, e.message)
      errores++
    }
  }
  return { enviados, omitidos, errores }
}

// ── Difusión principal ────────────────────────────────────────────
async function enviarDifusion(sock) {
  // Hora actual Argentina (UTC-3)
  const ahora = new Date(new Date().getTime() - 3 * 60 * 60 * 1000)
  const hora  = ahora.getUTCHours()
  const fecha = ahora.toISOString().slice(0, 10)
  const clave = `${fecha}_${hora}`

  // ── Difusión general: 10hs y 13hs ───────────────────────────────
  if (HORAS_DIFUSION.includes(hora) && !difusionEnviada.has(clave)) {
    difusionEnviada.add(clave)
    console.log(`📣 Difusión general de las ${hora}hs...`)
    const r = await enviarAClientes(sock, MENSAJE_DIFUSION)
    console.log(`📣 ${hora}hs — ✅ ${r.enviados} enviados | ⛔ ${r.omitidos} opt-out | ❌ ${r.errores} errores`)
    return
  }

  // ── Difusión de disponibilidad: 16hs ────────────────────────────
  if (hora === 16 && !difusionEnviada.has(clave)) {
    const libres = await getTurnosLibresHoy()
    if (libres.length === 0) {
      console.log('📣 16hs: No hay turnos libres esta noche, sin difusión.')
      difusionEnviada.add(clave)
      return
    }

    // Agrupar por hora
    const byHora = {}
    libres.forEach(({ hora, cancha }) => {
      if (!byHora[hora]) byHora[hora] = []
      byHora[hora].push(cancha)
    })

    let detalle = ''
    Object.keys(byHora).sort((a,b) => a-b).forEach(h => {
      const cs = byHora[h].sort()
      detalle += `⚽ *${h}hs* — Cancha ${cs.join(' y ')}\n`
    })

    const mensaje =
      `🔔 *¡Turnos disponibles para esta noche!*\n\n` +
      detalle +
      `\n¿Te anotamos? Escribime el horario que querés.\n` +
      `_(Respondé *STOP* para no recibir más mensajes)_`

    difusionEnviada.add(clave)
    console.log(`📣 Difusión de disponibilidad 16hs — ${libres.length} turnos libres...`)
    const r = await enviarAClientes(sock, mensaje)
    console.log(`📣 16hs — ✅ ${r.enviados} enviados | ⛔ ${r.omitidos} opt-out | ❌ ${r.errores} errores`)
  }
}

function iniciarSchedulerDifusion(sock) {
  // Revisar cada minuto si es hora de mandar
  setInterval(() => enviarDifusion(sock), 60 * 1000)
  console.log(`⏰ Scheduler activo — difusión: ${HORAS_DIFUSION.join('hs, ')}hs | disponibilidad: 16hs (Argentina)`)
}

// ── Conexión WhatsApp ─────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Complejo Doble AA Bot', 'Chrome', '1.0.0']
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Eventos de conexión ───────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // Generar QR como PNG y servirlo en el servidor web
    if (qr) {
      try {
        qrPngBuffer = await QRCode.toBuffer(qr, { scale: 8 })
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('📷 QR listo — abrí la URL pública del bot en el navegador')
        console.log('   Luego escaneá con WhatsApp → Dispositivos vinculados → Vincular dispositivo')
        console.log('   ⏰ Expira en 60s — si expira, refrescá la página')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      } catch (e) {
        console.error('Error generando QR:', e.message)
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : 500
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`🔌 Desconectado (código ${code}), reconectando: ${shouldReconnect}`)
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000)
      } else {
        console.log('❌ Sesión cerrada (logout). Eliminá la carpeta auth_info del Volume y redesplegá.')
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp — Complejo Doble AA')
      iniciarSchedulerDifusion(sock)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg)
      } catch (e) {
        console.error('Error al procesar mensaje:', e)
      }
    }
  })
}

console.log('🤖 Iniciando bot Complejo Doble AA...')
console.log(`📡 API: ${API_URL}`)
connectToWhatsApp()
