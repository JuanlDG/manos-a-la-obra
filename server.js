const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "public", "index.html");

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

async function handle(req, res) {
  const url = req.url.split("?")[0];

  if (url === "/health") return send(res, 200, "ok", "text/plain");

  if (url === "/api/jobs" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data FROM jobs ORDER BY id");
    return send(res, 200, rows.map((r) => r.data));
  }

  const m = url.match(/^\/api\/jobs\/(\d+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PUT") {
      const job = await readBody(req);
      if (!job || typeof job !== "object" || String(job.id) !== id)
        return send(res, 400, { error: "Trabajo inválido" });
      await pool.query(
        `INSERT INTO jobs (id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
        [id, job]
      );
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
      return send(res, 200, { ok: true });
    }
  }

  if (url === "/" || url === "/index.html") {
    return send(res, 200, fs.readFileSync(FILE), "text/html; charset=utf-8");
  }
  send(res, 404, { error: "No encontrado" });
}

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS jobs (
    id BIGINT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  http
    .createServer((req, res) =>
      handle(req, res).catch((e) => {
        console.error(e);
        send(res, 500, { error: "Error del servidor" });
      })
    )
    .listen(PORT, "0.0.0.0", () => console.log(`Escuchando en puerto ${PORT}`));
})();
