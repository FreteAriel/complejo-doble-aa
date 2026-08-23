
"""
Integración con MercadoPago para cobro de señas.

Flujo:
1. Bot crea una "preferencia de pago" (link de pago) por $10.000 para la reserva
2. Le manda el link al cliente por WhatsApp
3. Cliente paga → MercadoPago llama al webhook /webhook/mercadopago
4. Sistema verifica el pago y actualiza la reserva a "señado" con monto_senia=$10.000
5. Bot manda mensaje de confirmación al cliente

Configuración en .env (Railway environment variables):
  MP_ACCESS_TOKEN = tu Access Token de MercadoPago
  BASE_URL        = URL pública del proyecto en Railway (ej: https://xxx.railway.app)
  TWILIO_SID      = Account SID de Twilio
  TWILIO_TOKEN    = Auth Token de Twilio
  TWILIO_NUMBER   = Número de WhatsApp de Twilio (ej: whatsapp:+14155238886)
"""

import os
import json
import httpx
from fastapi import APIRouter, Request, Response, HTTPException
from database import get_db
from datetime import date

router = APIRouter()

MP_ACCESS_TOKEN = os.getenv("MP_ACCESS_TOKEN", "")
BASE_URL        = os.getenv("BASE_URL", "http://localhost:8000")
TWILIO_SID      = os.getenv("TWILIO_SID", "")
TWILIO_TOKEN    = os.getenv("TWILIO_TOKEN", "")
TWILIO_NUMBER   = os.getenv("TWILIO_NUMBER", "")

SENIA = 10_000
DIAS_ES = {0:"lunes",1:"martes",2:"miércoles",3:"jueves",4:"viernes",5:"sábado",6:"domingo"}
MESES_ESP = {1:"enero",2:"febrero",3:"marzo",4:"abril",5:"mayo",6:"junio",
             7:"julio",8:"agosto",9:"septiembre",10:"octubre",11:"noviembre",12:"diciembre"}

def fmt_fecha(d: date) -> str:
    return f"{DIAS_ES[d.weekday()]} {d.day} de {MESES_ESP[d.month]}"


async def crear_link_pago(reserva_id: int, cliente_nombre: str, fecha: str, hora: str, cancha: int) -> str:
    """Crea una preferencia de pago en MercadoPago y devuelve la URL de pago."""
    if not MP_ACCESS_TOKEN:
        return ""

    d = date.fromisoformat(fecha)
    descripcion = f"Seña cancha {cancha} — {fmt_fecha(d)} {hora}hs · Complejo Doble AA"

    payload = {
        "items": [{
            "title": descripcion,
            "quantity": 1,
            "unit_price": float(SENIA),
            "currency_id": "ARS"
        }],
        "external_reference": str(reserva_id),
        "notification_url": f"{BASE_URL}/webhook/mercadopago",
        "back_urls": {
            "success": f"{BASE_URL}/pago-exitoso",
            "failure": f"{BASE_URL}/pago-fallido",
            "pending": f"{BASE_URL}/pago-pendiente"
        },
        "auto_return": "approved",
        "statement_descriptor": "COMPLEJO DOBLE AA",
        "payer": {"name": cliente_nombre}
    }

    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://api.mercadopago.com/checkout/preferences",
            headers={
                "Authorization": f"Bearer {MP_ACCESS_TOKEN}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=15
        )
        data = res.json()
        # En producción usar "init_point"; en sandbox usar "sandbox_init_point"
        return data.get("init_point") or data.get("sandbox_init_point") or ""


async def verificar_pago_mp(payment_id: str) -> dict | None:
    """Consulta a MercadoPago si un pago fue aprobado. Retorna el pago o None."""
    if not MP_ACCESS_TOKEN:
        return None
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"https://api.mercadopago.com/v1/payments/{payment_id}",
            headers={"Authorization": f"Bearer {MP_ACCESS_TOKEN}"},
            timeout=15
        )
        if res.status_code != 200:
            return None
        return res.json()


async def enviar_whatsapp(to: str, mensaje: str):
    """Envía un mensaje de WhatsApp via Twilio."""
    if not TWILIO_SID or not TWILIO_TOKEN:
        return
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json",
            auth=(TWILIO_SID, TWILIO_TOKEN),
            data={
                "From": TWILIO_NUMBER,
                "To": f"whatsapp:{to}" if not to.startswith("whatsapp:") else to,
                "Body": mensaje
            },
            timeout=15
        )


# ─── Webhook de MercadoPago ───────────────────────────────────────────────────

@router.post("/webhook/mercadopago")
async def mercadopago_webhook(request: Request):
    """MercadoPago llama a este endpoint cuando se procesa un pago."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    tipo = body.get("type") or body.get("topic")
    if tipo not in ("payment", "merchant_order"):
        return Response(status_code=200)

    data_id = body.get("data", {}).get("id") or body.get("id")
    if not data_id:
        return Response(status_code=200)

    # Obtener detalles del pago
    pago = await verificar_pago_mp(str(data_id))
    if not pago:
        return Response(status_code=200)

    estado_pago = pago.get("status")
    reserva_id  = pago.get("external_reference")
    monto       = pago.get("transaction_amount", 0)

    if estado_pago != "approved" or not reserva_id:
        return Response(status_code=200)

    # Actualizar reserva en la base de datos
    db = await get_db()
    try:
        async with db.execute(
            "SELECT * FROM reservas WHERE id=?", (reserva_id,)
        ) as cur:
            reserva = await cur.fetchone()

        if not reserva:
            return Response(status_code=200)

        await db.execute(
            """UPDATE reservas SET estado='señado', monto_senia=?, notas=
               COALESCE(notas,'') || ' | Seña MP pago_id=' || ? WHERE id=?""",
            (float(monto), str(data_id), reserva_id)
        )
        await db.commit()

        # Recuperar número de WhatsApp del cliente
        async with db.execute(
            "SELECT telefono FROM clientes WHERE id=?", (reserva["cliente_id"],)
        ) as cur:
            cl = await cur.fetchone()
        telefono = cl["telefono"] if cl else None

        # Mandar mensaje de confirmación al cliente
        if telefono:
            d = date.fromisoformat(reserva["fecha"])
            nombre = reserva["cliente_nombre"].split()[0].title()  # primer nombre
            msg = (
                f"✅ *¡Seña confirmada, {nombre}!*\n\n"
                f"📅 Tenés reservado:\n"
                f"   ⏰ {reserva['hora']}hs\n"
                f"   ⚽ Cancha {reserva['cancha']}\n"
                f"   📆 {fmt_fecha(d).capitalize()}\n\n"
                f"💰 Señaste con *${int(monto):,}*\n\n"
                f"¡Gracias, te esperamos! 🏟️\n*Complejo Doble AA*"
            )
            await enviar_whatsapp(telefono, msg)

    finally:
        await db.close()

    return Response(status_code=200)


# ─── Páginas de retorno de MercadoPago ───────────────────────────────────────

@router.get("/pago-exitoso")
async def pago_exitoso():
    return Response(
        content="<html><body style='font-family:sans-serif;text-align:center;padding:40px'>"
                "<h2>✅ ¡Pago recibido!</h2>"
                "<p>Tu seña fue procesada correctamente. Recibirás un mensaje de WhatsApp con la confirmación.</p>"
                "<p><strong>Complejo Doble AA</strong></p></body></html>",
        media_type="text/html"
    )

@router.get("/pago-fallido")
async def pago_fallido():
    return Response(
        content="<html><body style='font-family:sans-serif;text-align:center;padding:40px'>"
                "<h2>❌ El pago no pudo procesarse</h2>"
                "<p>Por favor intentá nuevamente o contactate con nosotros por WhatsApp.</p>"
                "<p><strong>Complejo Doble AA</strong></p></body></html>",
        media_type="text/html"
    )

@router.get("/pago-pendiente")
async def pago_pendiente():
    return Response(
        content="<html><body style='font-family:sans-serif;text-align:center;padding:40px'>"
                "<h2>⏳ Pago en proceso</h2>"
                "<p>Tu pago está siendo verificado. Te avisaremos por WhatsApp cuando se confirme.</p>"
                "<p><strong>Complejo Doble AA</strong></p></body></html>",
        media_type="text/html"
    )
