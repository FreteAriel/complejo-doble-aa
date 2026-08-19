# Complejo Doble AA — Sistema de Gestión

## Cómo subir a Railway

1. Abrí tu proyecto en Railway: https://el-roble-production.up.railway.app
2. En el dashboard de Railway → **Variables** → agregá estas variables de entorno:

```
BASE_URL       = https://el-roble-production.up.railway.app
DB_PATH        = doble_aa.db
MP_ACCESS_TOKEN = (tu token de MercadoPago)
TWILIO_SID     = (de console.twilio.com)
TWILIO_TOKEN   = (de console.twilio.com)
TWILIO_NUMBER  = whatsapp:+14155238886
```

3. En Railway → **Deploy** → subí estos archivos (o conectá el repositorio de GitHub)

---

## Módulos del sistema

| Módulo   | URL              | Descripción                              |
|----------|------------------|------------------------------------------|
| Agenda   | /agenda          | Reservas de canchas por semana           |
| Bufet    | /bufet           | Ventas de productos, minutas y bebidas   |
| Clientes | /clientes        | Base de datos de clientes con historial  |
| Caja     | /caja            | Resumen de ingresos diarios y semanales  |

---

## Bot de WhatsApp (Twilio)

1. Creá una cuenta en https://twilio.com
2. Activá el sandbox de WhatsApp (gratis para desarrollo)
3. En la consola de Twilio → Messaging → Try it out → WhatsApp
4. Configurá el **Webhook URL**: `https://el-roble-production.up.railway.app/webhook/whatsapp`
5. Los clientes escanean el código QR del sandbox para conectarse

### Comandos que entiende el bot:
- "hola" → menú de opciones
- "¿hay cancha el sábado a las 20?" → consulta disponibilidad
- "quiero reservar el viernes 21hs cancha 1" → crea reserva + link de pago MP
- "¿cuánto cuesta?" → muestra precios y seña
- "¿cuándo tengo cancha?" → muestra tus próximas reservas

---

## MercadoPago (pago de señas automático)

1. Entrá a https://mercadopago.com/developers
2. Creá una aplicación → copiá el **Access Token de producción**
3. Pegalo en la variable `MP_ACCESS_TOKEN` de Railway
4. Cuando el bot confirma una reserva, le manda al cliente un link de pago
5. Al pagar, MercadoPago llama al webhook → el sistema confirma automáticamente → manda WhatsApp de confirmación

---

## Seña fija
La seña siempre es **$10.000** (configurable en `bot.py` → `SENIA_DEFAULT`)
