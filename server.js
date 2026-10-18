const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "public", "index.html");
const PARROQUIA_ID = 1;

const APP_PASSWORD = process.env.APP_PASSWORD || "";
if (!APP_PASSWORD)
  console.warn("APP_PASSWORD no está definida: la app queda abierta a cualquiera con la URL.");

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

// Si Postgres se reinicia, el pool avisa con un evento "error"; sin este manejador tumba el proceso.
pool.on("error", (e) => console.error("Error en conexión idle de Postgres:", e.message));

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

// ---- Acceso con contraseña compartida (cookie firmada, sin sesiones en servidor)
const token = () =>
  crypto.createHmac("sha256", APP_PASSWORD).update("misiones-acceso").digest("hex");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookieOf = (req, name) =>
  (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find((c) => c[0] === name)?.[1] || "";
const authed = (req) => !APP_PASSWORD || same(cookieOf(req, "acceso"), token());

const failures = new Map(); // ip -> { n, until }
const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

const loginPage = (error) => `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar · Construcción Misiones</title>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Big+Shoulders+Display:wght@800&display=swap" rel="stylesheet">
<style>
:root{--paper:#F2F4F5;--ink:#11181F;--tape:#F5C400;--concrete:#C8D0DA;--danger:#B3261E;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#12181E;--ink:#EEF1F4;--concrete:#3A4856;--danger:#FF8A80;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:1rem/1.5 "Atkinson Hyperlegible",system-ui,sans-serif;padding:16px}
form{width:min(100%,380px);display:flex;flex-direction:column;gap:12px}
h1{margin:0 0 6px;font:800 clamp(2.4rem,11vw,3.4rem)/1 "Big Shoulders Display","Arial Narrow",Impact,sans-serif}
.plate{height:18px;background:repeating-linear-gradient(-45deg,var(--tape) 0 14px,#11181F 14px 28px);border-radius:2px;margin-bottom:8px}
label{font-weight:700}input{width:100%;font:inherit;color:inherit;background:transparent;border:2px solid var(--ink);border-radius:6px;padding:12px}
button{font:inherit;font-weight:700;background:var(--tape);color:#11181F;border:2px solid #11181F;border-radius:6px;padding:12px;min-height:48px;cursor:pointer}
.err{color:var(--danger);font-weight:700;margin:0}:focus-visible{outline:3px solid #1F4E79;outline-offset:2px}
</style></head><body>
<form method="post" action="/login"><div class="plate"></div><h1>Construcción Misiones</h1>
<label for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p class="err" role="alert">${error}</p>` : ""}
<button type="submit">Entrar</button></form></body></html>`;

async function handleLogin(req, res) {
  const ip = ipOf(req), f = failures.get(ip);
  if (f && f.n >= 10 && f.until > Date.now())
    return send(res, 429, loginPage("Demasiados intentos. Espera unos minutos e inténtalo de nuevo."), "text/html; charset=utf-8");
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
  const pw = new URLSearchParams(raw).get("password") || "";
  if (!same(pw, APP_PASSWORD)) {
    failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
    return send(res, 401, loginPage("Contraseña incorrecta."), "text/html; charset=utf-8");
  }
  failures.delete(ip);
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(303, {
    "Set-Cookie": `acceso=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`,
    Location: "/",
  });
  res.end();
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

async function handle(req, res) {
  const url = req.url.split("?")[0];

  if (url === "/health") return send(res, 200, "ok", "text/plain");

  if (url === "/login" && APP_PASSWORD) {
    if (req.method === "POST") return handleLogin(req, res);
    return authed(req)
      ? (res.writeHead(303, { Location: "/" }), res.end())
      : send(res, 200, loginPage(""), "text/html; charset=utf-8");
  }
  if (!authed(req)) {
    if (url.startsWith("/api/")) return send(res, 401, { error: "Falta iniciar sesión" });
    return send(res, 200, loginPage(""), "text/html; charset=utf-8");
  }

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
