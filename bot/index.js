/**
 * WhatsApp Bot — Complejo Doble AA
 * Usa Baileys (multi-device, sin Chromium)
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'

// ── Config ────────────────────────────────────────────────────────
const API_URL    = process.env.API_URL    || 'https://complejo-doble-aa-production.up.railway.app'
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN || ''
const ALIAS_MP   = process.env.ALIAS_MP   || 'complejo.a'
const TITULAR_MP = process.env.TITULAR_MP || 'Distriviandas SA'
const MONTO_SENIA = parseInt(process.env.MONTO_SENIA || '10000')
const HORARIOS   = [17, 18, 19, 20, 21, 22, 23]
const CANCHAS    = [1, 2]

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
  // Fecha argentina
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
  const dow = dt.getDay() // 0=dom
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

    // data = { dias: [...], reservas: [...] }
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

async function verificarPagoMP() {
  if (!MP_TOKEN) {
    console.log('⚠️  MP_ACCESS_TOKEN no configurado — aprobando pago automáticamente (modo test)')
    return true
  }
  try {
    const now = new Date()
    const since = new Date(now.getTime() - 40 * 60 * 1000) // 40 min atrás
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

    // Agrupar por hora
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
    const horaMatch = text.match(/\b(1[7-9]|2[0-3])\s*(hs|h|:00)?\b/)
    if (!horaMatch) {
      await send(`No entendí el horario. Escribí algo como *"18hs"* o *"20hs cancha 1"*.`)
      return
    }

    const hora = parseInt(horaMatch[1])
    const lower = text.toLowerCase()
    const prefCancha2 = lower.includes('cancha 2') || lower.includes('2')

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

    await send(
      `✅ *${formatDateSpanish(session.selectedDay)}* — *${hora}hs* — Cancha *${cancha}*\n\n` +
      `💵 La seña es de *$${MONTO_SENIA.toLocaleString('es-AR')}*\n\n` +
      `💳 Transferí al alias: *${ALIAS_MP}*\n` +
      `👤 Titular: ${TITULAR_MP}\n\n` +
      `Cuando lo hagas, *mandame la captura del comprobante* 📸`
    )
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
    const confirmado = await verificarPagoMP()

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

// ── Conexión WhatsApp ─────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Complejo Doble AA Bot', 'Chrome', '1.0.0']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : 500
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`🔌 Desconectado (código ${code}), reconectando: ${shouldReconnect}`)
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000)
      } else {
        console.log('❌ Sesión cerrada. Eliminá la carpeta auth_info y reiniciá para escanear el QR.')
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp — Complejo Doble AA')
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
