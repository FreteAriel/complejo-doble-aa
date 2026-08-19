import aiosqlite
import os

DB_PATH = os.getenv("DB_PATH", "doble_aa.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    telefono TEXT,
    notas TEXT,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,          -- YYYY-MM-DD
    hora TEXT NOT NULL,           -- "17", "18", ... "23"
    cancha INTEGER NOT NULL,      -- 1 o 2
    cliente_id INTEGER,
    cliente_nombre TEXT NOT NULL,
    estado TEXT DEFAULT 'señado', -- libre / señado / pagado / no_vino / cancelado
    monto_total REAL DEFAULT 0,
    monto_senia REAL DEFAULT 0,
    monto_pagado REAL DEFAULT 0,
    notas TEXT,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    categoria TEXT DEFAULT 'otro',  -- bebida / minuta / snack / otro
    precio REAL NOT NULL,
    stock INTEGER DEFAULT 0,
    activo INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ventas_bufet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    producto_id INTEGER,
    producto_nombre TEXT NOT NULL,
    cantidad INTEGER NOT NULL DEFAULT 1,
    precio_unitario REAL NOT NULL,
    total REAL NOT NULL,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    apellido TEXT DEFAULT '',
    email TEXT UNIQUE NOT NULL,
    clave_hash TEXT NOT NULL,
    es_admin INTEGER DEFAULT 0,
    permisos TEXT DEFAULT '[]',
    activo INTEGER DEFAULT 1,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL DEFAULT ''
);
"""

async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)
        await db.commit()
        # Productos de ejemplo si la tabla está vacía
        async with db.execute("SELECT COUNT(*) FROM productos") as cur:
            count = (await cur.fetchone())[0]
        if count == 0:
            productos_iniciales = [
                ("Coca Cola 500ml", "bebida", 2000, 20),
                ("Agua Mineral", "bebida", 1200, 30),
                ("Gatorade", "bebida", 2500, 15),
                ("Cerveza 500ml", "bebida", 3500, 24),
                ("Milanesa en pan", "minuta", 5000, 0),
                ("Choripan", "minuta", 4500, 0),
                ("Lomito", "minuta", 7000, 0),
                ("Sandwich vegetal", "minuta", 4000, 0),
                ("Papas fritas", "snack", 3000, 0),
                ("Alfajor", "snack", 1500, 20),
                ("Maní", "snack", 1000, 30),
            ]
            await db.executemany(
                "INSERT INTO productos (nombre, categoria, precio, stock) VALUES (?,?,?,?)",
                productos_iniciales
            )
            await db.commit()
