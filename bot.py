"""
Bot de WhatsApp — Complejo Doble AA
Tecnología: Green API (WhatsApp propio) + FastAPI webhook

Flujo de conversación:
  Cliente escribe → Green API notifica al webhook → bot interpreta la intención → responde

Intenciones reconocidas:
  - consulta de disponibilidad: "¿hay cancha el sábado a las 20?"
  - reserva directa: "quiero reservar lunes 19 cancha 1"
  - ver mi reserva: "¿cuándo tengo cancha?"
  - saludo / menu: hola, buenas, etc.
"""

import re
import os
import httpx
from datetime import date, timedelta
from fastapi import APIRouter, Request, Form, Response
from database import get_db

router = APIRouter()

SENIA_DEFAULT = 10_000

HORARIOS_VALIDOS = list(range(17, 24))   # 17 a 23

DIAS_ES = {
    "lunes": 0, "martes": 1, "miércoles": 2, "miercoles": 2,
    "jueves": 3, "viernes": 4, "sábado": 5, "sabado": 5, "domingo": 6,
    "hoy": -1, "mañana": -2, "manana": -2
}

HORARIO_ALIAS = {
    "mediodia": 12, "mediodía": 12,
}

def normalizar(txt: str) -> str:
    """Lowercase y sin tildes para matching."""
    t = txt.lower()
    for a, b in [("á","a"),("é","e"),("í","i"),("ó","o"),("ú","u"),("ü","u"),("ñ","n")]:
        t = t.replace(a, b)
    return t

def resolver_fecha(texto: str) -> date | None:
    """Dado un fragmento de texto, devuelve la fecha más próxima futura que coincida."""
    t = normalizar(texto)
    hoy = date.today()
    dia_hoy = hoy.weekday()  # 0=lun ... 6=dom

    for palabra, wd in DIAS_ES.items():
        if palabra in t:
            if wd == -1:
                return hoy
            if wd == -2:
                return hoy + timedelta(days=1)
            dias_hasta = (wd - dia_hoy) % 7
            if dias_hasta == 0:
                dias_hasta = 7  # próxima semana si ya pasó
            return hoy + timedelta(days=dias_hasta)

    # Intentar con número de día: "el 23", "el sábado 23"
    match = re.search(r'\b(\d{1,2})\b', t)
    if match:
        num_dia = int(match.group(1))
        for delta in range(0, 30):
            candidato = hoy + timedelta(days=delta)
            if candidato.day == num_dia:
                return candidato
    return None

def resolver_hora(texto: str) -> int | None:
    """Extrae la hora del mensaje."""
    t = normalizar(texto)
    for alias, h in HORARIO_ALIAS.items():
        if alias in t:
            return h
    match = re.search(r'\b(\d{1,2})\s*(?:hs?|horas?|:00)?\b', t)
    if match:
        h = int(match.group(1))
        if 0 <= h <= 23:
            return h
    return None

def resolver_cancha(texto: str) -> int | None:
    """Extrae el número de cancha."""
    t = normalizar(texto)
    match = re.search(r'cancha\s*([12])', t)
    if match:
        return int(match.group(1))
    if " 1" in t or "una" in t or "primer" in t:
        return 1
    if " 2" in t or "dos" in t or "segunda" in t:
        return 2
    return None

def detectar_intencion(texto: str) -> str:
    t = normalizar(texto)
    saludos = ["hola","buenas","buenos","hey","buen dia","buen día","buenas tardes","buenas noches"]
    if any(s in t for s in saludos):
        return "saludo"
    if any(p in t for p in ["reserv","alquil","quiero cancha","necesito cancha","book"]):
        return "reservar"
    if any(p in t for p in ["disponib","libre","hay cancha","hay turno","cuando hay","qué hay","que hay"]):
        return "disponibilidad"
    if any(p in t for p in ["mi reserva","mi turno","cuando tengo","tengo cancha","mis turnos"]):
        return "ver_reserva"
    if any(p in t for p in ["precio","cuanto cuesta","cuánto cuesta","valor","costo"]):
        return "precios"
    if any(p in t for p in ["cancel","baj","anular"]):
        return "cancelar"
    return "desconocido"

async def buscar_disponibilidad(fecha: date, hora: int = None) -> list[dict]:
    """Retorna los slots libres para una fecha (y hora opcional)."""
    db = await get_db()
    try:
        async with db.execute(
            "SELECT hora, cancha FROM reservas WHERE fecha=? AND estado != 'cancelado'",
            (fecha.isoformat(),)
        ) as cur:
            ocupados = {(int(r["hora"]), r["cancha"]) for r in await cur.fetchall()}
    finally:
        await db.close()

    libres = []
    horas = [hora] if hora else HORARIOS_VALIDOS
    for h in horas:
        for c in [1, 2]:
            if (h, c) not in ocupados:
                libres.append({"hora": h, "cancha": c})
    return libres

async def crear_reserva_bot(fecha: date, hora: int, cancha: int, nombre_cliente: str) -> tuple[int, bool]:
    """Crea la reserva con seña por defecto. Retorna (reserva_id, True) o (0, False)."""
    db = await get_db()
    try:
        async with db.execute(
            "SELECT id FROM reservas WHERE fecha=? AND hora=? AND cancha=? AND estado != 'cancelado'",
            (fecha.isoformat(), str(hora), cancha)
        ) as cur:
            if await cur.fetchone():
                return 0, False

        # Buscar o crear cliente
        async with db.execute(
            "SELECT id FROM clientes WHERE nombre LIKE ? LIMIT 1", (nombre_cliente,)
        ) as cur:
            cl = await cur.fetchone()
        if cl:
            cliente_id = cl["id"]
        else:
            cur2 = await db.execute("INSERT INTO clientes (nombre) VALUES (?)", (nombre_cliente,))
            cliente_id = cur2.lastrowid

        cur3 = await db.execute(
            """INSERT INTO reservas (fecha, hora, cancha, cliente_id, cliente_nombre,
               estado, monto_total, monto_senia, monto_pagado, notas)
               VALUES (?,?,?,?,?,'señado',0,0,0,'Pendiente de pago — WhatsApp')""",
            (fecha.isoformat(), str(hora), cancha, cliente_id, nombre_cliente)
        )
        reserva_id = cur3.lastrowid
        await db.commit()
        return reserva_id, True
    finally:
        await db.close()

DIAS_ES_INV = {0:"lunes",1:"martes",2:"miércoles",3:"jueves",4:"viernes",5:"sábado",6:"domingo"}
MESES_ESP = {1:"enero",2:"febrero",3:"marzo",4:"abril",5:"mayo",6:"junio",
             7:"julio",8:"agosto",9:"septiembre",10:"octubre",11:"noviembre",12:"diciembre"}

def fmt_fecha(d: date) -> str:
    return f"{DIAS_ES_INV[d.weekday()]} {d.day} de {MESES_ESP[d.month]}"


# ─── Green API: enviar mensaje ────────────────────────────────────────────────

async def enviar_mensaje_greenapi(chat_id: str, texto: str) -> None:
    """Envía un mensaje de WhatsApp usando Green API."""
    instance_id = os.getenv("GREENAPI_INSTANCE_ID", "").strip()
    token = os.getenv("GREENAPI_TOKEN", "").strip()
    if not instance_id or not token:
        print("[GreenAPI] Faltan GREENAPI_INSTANCE_ID o GREENAPI_TOKEN")
        return
    url = f"https://7107.api.greenapi.com/waInstance{instance_id}/sendMessage/{token}"
    payload = {"chatId": chat_id, "message": texto}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(url, json=payload)
        print(f"[GreenAPI] sendMessage status={res.status_code} chat={chat_id}")
    except Exception as e:
        print(f"[GreenAPI] Error enviando mensaje: {e}")


async def procesar_mensaje(body: str, from_number: str) -> str:
    """Lógica central del bot. Retorna el texto a responder."""
    intent = detectar_intencion(body)
    fecha = resolver_fecha(body)
    hora  = resolver_hora(body)
    cancha = resolver_cancha(body)

    # ── Saludo / menú ──────────────────────────────────────────────────────
    if intent == "saludo":
        return (
            "¡Hola! 👋 Bienvenido al *Complejo Doble AA* ⚽\n\n"
            "Puedo ayudarte con:\n"
            "📅 *Consultar disponibilidad* → «¿Hay cancha el sábado a las 20?»\n"
            "✅ *Reservar un turno* → «Quiero reservar el viernes 21hs cancha 1»\n"
            "💰 *Precios* → «¿Cuánto cuesta?»\n\n"
            "¿Qué necesitás? 😊"
        )

    # ── Precios ────────────────────────────────────────────────────────────
    if intent == "precios":
        return (
            "💰 *Precios — Complejo Doble AA*\n\n"
            f"🏟️ Turno de 1 hora (cualquier cancha)\n"
            f"📌 Seña para reservar: *${SENIA_DEFAULT:,}*\n\n"
            "Para consultar el precio total del turno o hacer una reserva, "
            "escribinos el día y horario que querés 📅"
        )

    # ── Disponibilidad ─────────────────────────────────────────────────────
    if intent == "disponibilidad":
        if not fecha:
            return (
                "¿Para qué día querés consultar? 📅\n"
                "Por ejemplo: «¿Hay cancha el *sábado* a las *20*?»"
            )
        libres = await buscar_disponibilidad(fecha, hora)
        nombre_dia = fmt_fecha(fecha)
        if not libres:
            msg = f"😔 No hay turnos disponibles el *{nombre_dia}*"
            if hora:
                msg = f"😔 El turno del *{nombre_dia} a las {hora}hs* está ocupado en las dos canchas."
            msg += "\n\n¿Querés consultar otro día o horario?"
            return msg

        if hora:
            resp = f"✅ Disponibilidad el *{nombre_dia} a las {hora}hs*:\n\n"
        else:
            resp = f"📅 Turnos libres el *{nombre_dia}*:\n\n"

        for slot in libres[:10]:
            resp += f"⚽ *{slot['hora']}hs — Cancha {slot['cancha']}*\n"

        resp += f"\nPara reservar escribí:\n«*Quiero el {nombre_dia} a las X hs cancha Y*»"
        return resp

    # ── Reservar ───────────────────────────────────────────────────────────
    if intent == "reservar":
        if not fecha:
            return "¿Para qué día querés reservar? 📅 (ej: «*el sábado*», «*mañana*», «*el 25*»)"
        if not hora:
            return f"¿A qué hora querés reservar el {fmt_fecha(fecha)}? (ej: «*19hs*», «*21hs*»)"

        libres = await buscar_disponibilidad(fecha, hora)
        if not libres:
            return (
                f"😔 Lo sentimos, el *{fmt_fecha(fecha)} a las {hora}hs* está ocupado.\n\n"
                "¿Querés que te muestre los horarios disponibles para ese día?\n"
                f"Respondé: «*¿Qué hay el {fmt_fecha(fecha)}?*»"
            )

        canchas_libres = [s["cancha"] for s in libres]

        if cancha and cancha not in canchas_libres:
            otras = [c for c in canchas_libres]
            msg = f"😔 La cancha {cancha} no está disponible a las {hora}hs."
            if otras:
                msg += f" Pero la cancha {otras[0]} sí está libre."
                msg += f"\n¿Querés reservar la *cancha {otras[0]}*?"
            return msg

        cancha_elegida = cancha if (cancha and cancha in canchas_libres) else canchas_libres[0]

        nombre_cliente = f"Cliente WA {from_number[-8:]}"

        reserva_id, ok = await crear_reserva_bot(fecha, hora, cancha_elegida, nombre_cliente)
        if ok:
            try:
                from mercadopago_service import crear_link_pago
                link_pago = await crear_link_pago(
                    reserva_id, nombre_cliente, fecha.isoformat(), str(hora), cancha_elegida
                )
            except Exception:
                link_pago = ""

            msg = (
                f"📋 *Reserva guardada — Complejo Doble AA*\n\n"
                f"📅 {fmt_fecha(fecha).capitalize()}\n"
                f"⏰ {hora}:00 hs\n"
                f"⚽ Cancha {cancha_elegida}\n\n"
                f"💰 Seña: *${SENIA_DEFAULT:,}*\n"
            )
            if link_pago:
                msg += (
                    f"\n💳 *Pagá tu seña acá:*\n{link_pago}\n\n"
                    "Una vez confirmado el pago recibirás la confirmación automáticamente. ✅"
                )
            else:
                msg += "\n📍 Abonala al llegar antes de tu turno."
            msg += "\n\n¡Te esperamos! 🏟️"
            return msg
        else:
            return (
                f"⚠️ El turno acaba de ser reservado por otra persona.\n"
                "¿Querés otro horario?"
            )

    # ── Ver mi reserva ─────────────────────────────────────────────────────
    if intent == "ver_reserva":
        db = await get_db()
        try:
            async with db.execute(
                """SELECT * FROM reservas WHERE cliente_nombre LIKE ? AND fecha >= ?
                   AND estado != 'cancelado' ORDER BY fecha, hora LIMIT 5""",
                (f"%{from_number[-8:]}%", date.today().isoformat())
            ) as cur:
                reservas = await cur.fetchall()
        finally:
            await db.close()

        if not reservas:
            return "No encontré reservas activas para tu número. ¿Querés hacer una reserva?"

        resp = "📋 *Tus próximas reservas:*\n\n"
        for r in reservas:
            d = date.fromisoformat(r["fecha"])
            resp += f"📅 {fmt_fecha(d).capitalize()} · {r['hora']}hs · Cancha {r['cancha']}\n"
        return resp

    # ── Desconocido ────────────────────────────────────────────────────────
    return (
        "No entendí bien tu consulta 😅\n\n"
        "Podés preguntarme:\n"
        "• «¿*Hay cancha el sábado* a las *20*?»\n"
        "• «Quiero *reservar* el *viernes* a las *21hs cancha 1*»\n"
        "• «¿*Cuánto cuesta*?»"
    )


# ─── Webhook de Green API ─────────────────────────────────────────────────────

@router.post("/webhook/greenapi")
async def greenapi_webhook(request: Request):
    """
    Green API llama a este endpoint cuando llega un mensaje de WhatsApp.
    Formato JSON esperado:
    {
      "typeWebhook": "incomingMessageReceived",
      "messageData": {
        "typeMessage": "textMessage",
        "textMessageData": {"textMessage": "..."}
      },
      "senderData": {"sender": "5491112345678@c.us"}
    }
    """
    try:
        data = await request.json()
    except Exception:
        return {"status": "ignored", "reason": "invalid JSON"}

    # Solo procesar mensajes de texto entrantes
    type_webhook = data.get("typeWebhook", "")
    if type_webhook != "incomingMessageReceived":
        return {"status": "ignored", "reason": f"typeWebhook={type_webhook}"}

    message_data = data.get("messageData", {})
    type_message = message_data.get("typeMessage", "")
    if type_message != "textMessage":
        return {"status": "ignored", "reason": f"typeMessage={type_message}"}

    text_data = message_data.get("textMessageData", {})
    body = text_data.get("textMessage", "").strip()

    sender_data = data.get("senderData", {})
    from_number = sender_data.get("sender", "")  # ej: "5491112345678@c.us"

    if not body or not from_number:
        return {"status": "ignored", "reason": "empty body or sender"}

    print(f"[GreenAPI] Mensaje de {from_number}: {body[:80]}")

    respuesta = await procesar_mensaje(body, from_number)
    await enviar_mensaje_greenapi(from_number, respuesta)

    return {"status": "ok"}


# ─── Webhook de Twilio (mantenido como respaldo) ──────────────────────────────

def twiml_response(texto: str) -> Response:
    """Genera la respuesta en formato TwiML para Twilio."""
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>{texto}</Message>
</Response>"""
    return Response(content=xml, media_type="application/xml")

@router.post("/webhook/whatsapp")
async def whatsapp_webhook(
    Body: str = Form(""),
    From: str = Form(""),
):
    """Twilio llama a este endpoint cuando llega un mensaje de WhatsApp."""
    respuesta = await procesar_mensaje(Body.strip(), From)
    return twiml_response(respuesta)
