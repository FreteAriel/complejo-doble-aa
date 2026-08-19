from fastapi import FastAPI, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from datetime import date, timedelta
import json

from database import init_db, get_db
from bot import router as bot_router
from mercadopago_service import router as mp_router, crear_link_pago

app = FastAPI(title="Complejo Doble AA")
app.include_router(bot_router)
app.include_router(mp_router)
templates = Jinja2Templates(directory="templates")

HORARIOS = ["17", "18", "19", "20", "21", "22", "23"]
CANCHAS = [1, 2]

@app.on_event("startup")
async def startup():
    await init_db()

# ─────────────────────────── PÁGINAS ───────────────────────────

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return RedirectResponse("/agenda")

@app.get("/agenda", response_class=HTMLResponse)
async def agenda_page(request: Request, semana: str = None):
    if semana is None:
        hoy = date.today()
        # Encontrar el martes de la semana actual
        dias_desde_martes = (hoy.weekday() - 1) % 7
        semana = (hoy - timedelta(days=dias_desde_martes)).isoformat()
    return templates.TemplateResponse("agenda.html", {
        "request": request,
        "semana": semana,
        "horarios": HORARIOS,
        "canchas": CANCHAS
    })

@app.get("/bufet", response_class=HTMLResponse)
async def bufet_page(request: Request):
    return templates.TemplateResponse("bufet.html", {"request": request})

@app.get("/clientes", response_class=HTMLResponse)
async def clientes_page(request: Request):
    return templates.TemplateResponse("clientes.html", {"request": request})

@app.get("/caja", response_class=HTMLResponse)
async def caja_page(request: Request):
    return templates.TemplateResponse("caja.html", {"request": request})

# ─────────────────────────── API AGENDA ───────────────────────────

@app.get("/api/agenda")
async def get_agenda(semana: str):
    """Devuelve todas las reservas de la semana (martes a domingo)."""
    inicio = date.fromisoformat(semana)
    dias = [(inicio + timedelta(days=i)).isoformat() for i in range(6)]
    db = await get_db()
    try:
        placeholders = ",".join("?" * len(dias))
        async with db.execute(
            f"SELECT * FROM reservas WHERE fecha IN ({placeholders})",
            dias
        ) as cur:
            rows = await cur.fetchall()
        reservas = [dict(r) for r in rows]
    finally:
        await db.close()
    return {"dias": dias, "reservas": reservas}

@app.post("/api/reservas")
async def crear_reserva(request: Request):
    data = await request.json()
    fecha = data.get("fecha")
    hora = data.get("hora")
    cancha = data.get("cancha")
    cliente_nombre = data.get("cliente_nombre", "").strip()
    estado = data.get("estado", "señado")
    monto_total = float(data.get("monto_total", 0))
    monto_senia = float(data.get("monto_senia", 0))
    monto_pagado = float(data.get("monto_pagado", 0))
    notas = data.get("notas", "")

    if not all([fecha, hora, cancha, cliente_nombre]):
        raise HTTPException(400, "Datos incompletos")

    db = await get_db()
    try:
        # Verificar que el turno esté libre
        async with db.execute(
            "SELECT id FROM reservas WHERE fecha=? AND hora=? AND cancha=? AND estado != 'cancelado'",
            (fecha, hora, cancha)
        ) as cur:
            existing = await cur.fetchone()
        if existing:
            raise HTTPException(409, "El turno ya está ocupado")

        # Buscar o crear cliente
        cliente_id = None
        async with db.execute(
            "SELECT id FROM clientes WHERE nombre LIKE ? LIMIT 1",
            (cliente_nombre,)
        ) as cur:
            cl = await cur.fetchone()
        if cl:
            cliente_id = cl["id"]
        else:
            cur = await db.execute(
                "INSERT INTO clientes (nombre) VALUES (?)", (cliente_nombre,)
            )
            cliente_id = cur.lastrowid

        cur = await db.execute(
            """INSERT INTO reservas (fecha, hora, cancha, cliente_id, cliente_nombre,
               estado, monto_total, monto_senia, monto_pagado, notas)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (fecha, hora, int(cancha), cliente_id, cliente_nombre,
             estado, monto_total, monto_senia, monto_pagado, notas)
        )
        reserva_id = cur.lastrowid
        await db.commit()
    finally:
        await db.close()
    return {"id": reserva_id, "ok": True}

@app.put("/api/reservas/{reserva_id}")
async def actualizar_reserva(reserva_id: int, request: Request):
    data = await request.json()
    db = await get_db()
    try:
        async with db.execute("SELECT * FROM reservas WHERE id=?", (reserva_id,)) as cur:
            r = await cur.fetchone()
        if not r:
            raise HTTPException(404, "Reserva no encontrada")
        await db.execute(
            """UPDATE reservas SET cliente_nombre=?, estado=?, monto_total=?,
               monto_senia=?, monto_pagado=?, notas=? WHERE id=?""",
            (
                data.get("cliente_nombre", r["cliente_nombre"]),
                data.get("estado", r["estado"]),
                float(data.get("monto_total", r["monto_total"])),
                float(data.get("monto_senia", r["monto_senia"])),
                float(data.get("monto_pagado", r["monto_pagado"])),
                data.get("notas", r["notas"]),
                reserva_id
            )
        )
        await db.commit()
    finally:
        await db.close()
    return {"ok": True}

@app.delete("/api/reservas/{reserva_id}")
async def cancelar_reserva(reserva_id: int):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE reservas SET estado='cancelado' WHERE id=?", (reserva_id,)
        )
        await db.commit()
    finally:
        await db.close()
    return {"ok": True}

# ─────────────────────────── API CLIENTES ───────────────────────────

@app.get("/api/clientes")
async def get_clientes(q: str = ""):
    db = await get_db()
    try:
        if q:
            async with db.execute(
                "SELECT * FROM clientes WHERE nombre LIKE ? ORDER BY nombre LIMIT 20",
                (f"%{q}%",)
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM clientes ORDER BY nombre"
            ) as cur:
                rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()

@app.get("/api/clientes/{cliente_id}/historial")
async def historial_cliente(cliente_id: int):
    db = await get_db()
    try:
        async with db.execute(
            "SELECT * FROM clientes WHERE id=?", (cliente_id,)
        ) as cur:
            cliente = await cur.fetchone()
        if not cliente:
            raise HTTPException(404, "Cliente no encontrado")
        async with db.execute(
            "SELECT * FROM reservas WHERE cliente_id=? ORDER BY fecha DESC, hora DESC LIMIT 50",
            (cliente_id,)
        ) as cur:
            reservas = await cur.fetchall()
        return {
            "cliente": dict(cliente),
            "reservas": [dict(r) for r in reservas]
        }
    finally:
        await db.close()

@app.post("/api/clientes")
async def crear_cliente(request: Request):
    data = await request.json()
    nombre = data.get("nombre", "").strip()
    if not nombre:
        raise HTTPException(400, "Nombre requerido")
    db = await get_db()
    try:
        cur = await db.execute(
            "INSERT INTO clientes (nombre, telefono, notas) VALUES (?,?,?)",
            (nombre, data.get("telefono",""), data.get("notas",""))
        )
        await db.commit()
        return {"id": cur.lastrowid, "ok": True}
    finally:
        await db.close()

@app.put("/api/clientes/{cliente_id}")
async def actualizar_cliente(cliente_id: int, request: Request):
    data = await request.json()
    db = await get_db()
    try:
        await db.execute(
            "UPDATE clientes SET nombre=?, telefono=?, notas=? WHERE id=?",
            (data.get("nombre"), data.get("telefono",""), data.get("notas",""), cliente_id)
        )
        await db.commit()
    finally:
        await db.close()
    return {"ok": True}

# ─────────────────────────── API BUFET ───────────────────────────

@app.get("/api/productos")
async def get_productos():
    db = await get_db()
    try:
        async with db.execute(
            "SELECT * FROM productos WHERE activo=1 ORDER BY categoria, nombre"
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()

@app.post("/api/productos")
async def crear_producto(request: Request):
    data = await request.json()
    db = await get_db()
    try:
        cur = await db.execute(
            "INSERT INTO productos (nombre, categoria, precio, stock) VALUES (?,?,?,?)",
            (data["nombre"], data.get("categoria","otro"),
             float(data["precio"]), int(data.get("stock",0)))
        )
        await db.commit()
        return {"id": cur.lastrowid, "ok": True}
    finally:
        await db.close()

@app.put("/api/productos/{producto_id}")
async def actualizar_producto(producto_id: int, request: Request):
    data = await request.json()
    db = await get_db()
    try:
        await db.execute(
            "UPDATE productos SET nombre=?, categoria=?, precio=?, stock=?, activo=? WHERE id=?",
            (data["nombre"], data.get("categoria","otro"),
             float(data["precio"]), int(data.get("stock",0)),
             int(data.get("activo",1)), producto_id)
        )
        await db.commit()
    finally:
        await db.close()
    return {"ok": True}

@app.post("/api/ventas")
async def registrar_venta(request: Request):
    data = await request.json()
    items = data.get("items", [])
    fecha = data.get("fecha", date.today().isoformat())
    if not items:
        raise HTTPException(400, "Sin items")
    db = await get_db()
    try:
        for item in items:
            pid = item["producto_id"]
            qty = int(item["cantidad"])
            async with db.execute("SELECT * FROM productos WHERE id=?", (pid,)) as cur:
                prod = await cur.fetchone()
            if not prod:
                continue
            total = prod["precio"] * qty
            await db.execute(
                """INSERT INTO ventas_bufet
                   (fecha, producto_id, producto_nombre, cantidad, precio_unitario, total)
                   VALUES (?,?,?,?,?,?)""",
                (fecha, pid, prod["nombre"], qty, prod["precio"], total)
            )
            # Descontar stock si corresponde
            if prod["stock"] > 0:
                await db.execute(
                    "UPDATE productos SET stock = MAX(0, stock-?) WHERE id=?",
                    (qty, pid)
                )
        await db.commit()
    finally:
        await db.close()
    return {"ok": True}

@app.get("/api/ventas")
async def get_ventas(fecha: str = None):
    if not fecha:
        fecha = date.today().isoformat()
    db = await get_db()
    try:
        async with db.execute(
            "SELECT * FROM ventas_bufet WHERE fecha=? ORDER BY creado_en DESC",
            (fecha,)
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()

# ─────────────────────────── API CAJA / REPORTES ───────────────────────────

@app.get("/api/caja")
async def resumen_caja(fecha: str = None):
    if not fecha:
        fecha = date.today().isoformat()
    db = await get_db()
    try:
        # Ingresos canchas del día
        async with db.execute(
            """SELECT COUNT(*) as total_reservas,
               SUM(monto_pagado) as cobrado,
               SUM(monto_senia) as senias,
               SUM(CASE WHEN estado='pagado' THEN 1 ELSE 0 END) as pagados,
               SUM(CASE WHEN estado='señado' THEN 1 ELSE 0 END) as seniados,
               SUM(CASE WHEN estado='no_vino' THEN 1 ELSE 0 END) as no_vinieron
               FROM reservas WHERE fecha=? AND estado != 'cancelado'""",
            (fecha,)
        ) as cur:
            canchas = dict(await cur.fetchone())

        # Ingresos bufet del día
        async with db.execute(
            """SELECT COUNT(*) as total_ventas, SUM(total) as total_bufet,
               SUM(cantidad) as total_items FROM ventas_bufet WHERE fecha=?""",
            (fecha,)
        ) as cur:
            bufet = dict(await cur.fetchone())

        # Señas pendientes de cobro (por todos los turnos futuros)
        async with db.execute(
            """SELECT SUM(monto_total - monto_pagado) as pendiente
               FROM reservas WHERE fecha >= ? AND estado IN ('señado') AND monto_total > 0""",
            (fecha,)
        ) as cur:
            row = await cur.fetchone()
            pendiente = row["pendiente"] or 0

        # Top 5 productos del día
        async with db.execute(
            """SELECT producto_nombre, SUM(cantidad) as qty, SUM(total) as total
               FROM ventas_bufet WHERE fecha=?
               GROUP BY producto_nombre ORDER BY total DESC LIMIT 5""",
            (fecha,)
        ) as cur:
            top_productos = [dict(r) for r in await cur.fetchall()]

    finally:
        await db.close()

    return {
        "fecha": fecha,
        "canchas": canchas,
        "bufet": bufet,
        "pendiente_cobro": pendiente,
        "top_productos": top_productos,
        "total_dia": (canchas.get("cobrado") or 0) + (bufet.get("total_bufet") or 0)
    }

@app.get("/api/caja/semana")
async def resumen_semana(desde: str, hasta: str):
    db = await get_db()
    try:
        async with db.execute(
            """SELECT fecha,
               SUM(monto_pagado) as canchas,
               COUNT(*) as reservas
               FROM reservas WHERE fecha BETWEEN ? AND ? AND estado != 'cancelado'
               GROUP BY fecha ORDER BY fecha""",
            (desde, hasta)
        ) as cur:
            por_dia_canchas = {r["fecha"]: dict(r) for r in await cur.fetchall()}

        async with db.execute(
            """SELECT fecha, SUM(total) as bufet FROM ventas_bufet
               WHERE fecha BETWEEN ? AND ? GROUP BY fecha""",
            (desde, hasta)
        ) as cur:
            por_dia_bufet = {r["fecha"]: r["bufet"] for r in await cur.fetchall()}

    finally:
        await db.close()

    # Combinar días
    todas_fechas = sorted(set(list(por_dia_canchas.keys()) + list(por_dia_bufet.keys())))
    resultado = []
    for f in todas_fechas:
        c = por_dia_canchas.get(f, {})
        b = por_dia_bufet.get(f, 0) or 0
        resultado.append({
            "fecha": f,
            "canchas": c.get("canchas") or 0,
            "bufet": b,
            "reservas": c.get("reservas") or 0,
            "total": (c.get("canchas") or 0) + b
        })
    return resultado
