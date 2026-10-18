const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "public", "index.html");
const PARROQUIA_ID = 1;

if (!process.env.DATABASE_URL) {
  console.error("Falta la variable DATABASE_URL (conectar Postgres en Railway).");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway internal network no usa SSL; el proxy público sí.
  ssl: /proxy\.rlwy\.net|\.railway\.app/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) {
        reject(new Error("Body demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

async function handle(req, res) {
  const url = req.url.split("?")[0];

  if (url === "/health") return send(res, 200, "ok", "text/plain");

  // ---- Cuadrillas (la parroquia es la cuadrilla con id 1: bodega central)
  if (url === "/api/cuadrillas" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data FROM cuadrillas ORDER BY id");
    return send(res, 200, rows.map((r) => r.data));
  }

  let m = url.match(/^\/api\/cuadrillas\/(\d+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PUT") {
      const c = await readBody(req);
      if (!isObj(c) || String(c.id) !== id)
        return send(res, 400, { error: "Cuadrilla inválida" });
      await pool.query(
        `INSERT INTO cuadrillas (id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
        [id, c]
      );
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      if (Number(id) === PARROQUIA_ID)
        return send(res, 400, { error: "La parroquia no se puede eliminar" });
      await pool.query("DELETE FROM cuadrillas WHERE id = $1", [id]);
      return send(res, 200, { ok: true });
    }
  }

  // ---- Avisos
  if (url === "/api/avisos" && req.method === "GET") {
    const { rows } = await pool.query(
      "SELECT data FROM avisos ORDER BY id DESC LIMIT 200"
    );
    return send(res, 200, rows.map((r) => r.data));
  }
  if (url === "/api/avisos" && req.method === "POST") {
    const b = await readBody(req);
    const author = clip(b.author, 60);
    const text = clip(b.text, 1000);
    if (!author || !text)
      return send(res, 400, { error: "Faltan el nombre o el mensaje" });
    const aviso = { id: Date.now(), author, text, ts: new Date().toISOString() };
    await pool.query("INSERT INTO avisos (id, data) VALUES ($1, $2)", [
      aviso.id,
      aviso,
    ]);
    return send(res, 200, aviso);
  }
  m = url.match(/^\/api\/avisos\/(\d+)$/);
  if (m && req.method === "DELETE") {
    await pool.query("DELETE FROM avisos WHERE id = $1", [m[1]]);
    return send(res, 200, { ok: true });
  }

  if (url === "/" || url === "/index.html") {
    return send(res, 200, fs.readFileSync(FILE), "text/html; charset=utf-8");
  }
  send(res, 404, { error: "No encontrado" });
}

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS cuadrillas (
    id BIGINT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS avisos (
    id BIGINT PRIMARY KEY,
    data JSONB NOT NULL
  )`);
  await pool.query(
    `INSERT INTO cuadrillas (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [
      PARROQUIA_ID,
      {
        id: PARROQUIA_ID,
        name: "Materiales parroquia",
        address: "",
        lead: "",
        parroquia: true,
        motor: [],
        alumnos: [],
        materials: [],
        tools: [],
      },
    ]
  );
  http
    .createServer((req, res) =>
      handle(req, res).catch((e) => {
        console.error(e);
        send(res, 500, { error: "Error del servidor" });
      })
    )
    .listen(PORT, "0.0.0.0", () => console.log(`Escuchando en puerto ${PORT}`));
})();
