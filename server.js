const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const Names = require("./public/names.js");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/names.js": ["names.js", "text/javascript; charset=utf-8"],
};

// ---- Roles
//   admin:    ADMIN_PASSWORD. Puede cambiar la bodega central (inventario) y todo lo demás.
//   usuario:  APP_PASSWORD.   Puede editar cuadrillas y pedir compras, usando solo lo que hay en la bodega.
//   visitante: sin contraseña. Solo lectura.
// Si no hay ninguna contraseña definida la app queda abierta y todos son admin (útil en local).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const USER_PASSWORD = process.env.APP_PASSWORD || "";
const OPEN = !ADMIN_PASSWORD && !USER_PASSWORD;
if (OPEN) console.warn("Sin ADMIN_PASSWORD ni APP_PASSWORD: la app queda abierta a cualquiera.");
else if (!ADMIN_PASSWORD) console.warn("Falta ADMIN_PASSWORD: nadie podrá cambiar la bodega central.");

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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
        reject(new HttpError(413, "Body demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new HttpError(400, "JSON inválido")); }
    });
  });

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const int = (v, max = 1e9) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));

// ---- Sesión: cookie "rol.firma". La firma depende de las contraseñas, así que cambiarlas cierra todas las sesiones.
const SECRET = `${ADMIN_PASSWORD}|${USER_PASSWORD}`;
const sign = (role) => crypto.createHmac("sha256", SECRET).update("misiones:" + role).digest("hex");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookieOf = (req, name) =>
  (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find((c) => c[0] === name)?.[1] || "";
function roleOf(req) {
  if (OPEN) return "admin";
  const [role, sig] = cookieOf(req, "acceso").split(".");
  return ["admin", "usuario", "visitante"].includes(role) && sig && same(sig, sign(role)) ? role : null;
}
const setCookie = (req, value, maxAge) =>
  `acceso=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` +
  (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");

const failures = new Map(); // ip -> { n, until }
const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

const loginPage = (error) => `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar · Construcción Misiones</title>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Big+Shoulders+Display:wght@800&display=swap" rel="stylesheet">
<style>
:root{--paper:#F2F4F5;--ink:#11181F;--tape:#F5C400;--concrete:#C8D0DA;--danger:#B3261E;--mute:#4A5663;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#12181E;--ink:#EEF1F4;--concrete:#3A4856;--danger:#FF8A80;--mute:#A5B1BD;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:1rem/1.5 "Atkinson Hyperlegible",system-ui,sans-serif;padding:16px}
form{width:min(100%,380px);display:flex;flex-direction:column;gap:12px}
h1{margin:0 0 6px;font:800 clamp(2.4rem,11vw,3.4rem)/1 "Big Shoulders Display","Arial Narrow",Impact,sans-serif}
.plate{height:18px;background:repeating-linear-gradient(-45deg,var(--tape) 0 14px,#11181F 14px 28px);border-radius:2px;margin-bottom:8px}
label{font-weight:700}input{width:100%;font:inherit;color:inherit;background:transparent;border:2px solid var(--ink);border-radius:6px;padding:12px}
button{font:inherit;font-weight:700;border:2px solid #11181F;border-radius:6px;padding:12px;min-height:48px;cursor:pointer}
.go{background:var(--tape);color:#11181F}.ro{background:transparent;color:var(--ink);border-color:var(--concrete)}
.err{color:var(--danger);font-weight:700;margin:0}.hint{color:var(--mute);margin:0;font-size:.92rem}:focus-visible{outline:3px solid #1F4E79;outline-offset:2px}
</style></head><body>
<form method="post" action="/login"><div class="plate"></div><h1>Construcción Misiones</h1>
<label for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus>
${error ? `<p class="err" role="alert">${error}</p>` : ""}
<button class="go" type="submit">Entrar</button>
<button class="ro" type="submit" name="visitante" value="1" formnovalidate>Entrar sin contraseña</button>
<p class="hint">Sin contraseña solo puedes mirar: no se puede cambiar nada.</p></form></body></html>`;

async function handleLogin(req, res) {
  const ip = ipOf(req), f = failures.get(ip);
  if (f && f.n >= 10 && f.until > Date.now())
    return send(res, 429, loginPage("Demasiados intentos. Espera unos minutos e inténtalo de nuevo."), "text/html; charset=utf-8");
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
  const form = new URLSearchParams(raw), pw = form.get("password") || "";
  let role = null;
  if (form.get("visitante") === "1") role = "visitante";
  else if (ADMIN_PASSWORD && same(pw, ADMIN_PASSWORD)) role = "admin";
  else if (USER_PASSWORD && same(pw, USER_PASSWORD)) role = "usuario";
  if (!role) {
    failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
    return send(res, 401, loginPage("Contraseña incorrecta."), "text/html; charset=utf-8");
  }
  failures.delete(ip);
  res.writeHead(303, { "Set-Cookie": setCookie(req, `${role}.${sign(role)}`, 60 * 60 * 24 * 30), Location: "/" });
  res.end();
}

// ---- Base de datos
// Todo lo que toca existencias pasa por una transacción con un candado, para que dos personas
// no puedan sacar a la vez la última unidad de la bodega.
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(7001)");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const allData = async (c, table) =>
  (await c.query(`SELECT data FROM ${table} ORDER BY id`)).rows.map((r) => r.data);

const KIND = { material: "material", tool: "herramienta" };
const LIST_KIND = { materials: "material", tools: "tool" };

// Cuánto de cada elemento tienen asignado las cuadrillas (opcionalmente sin contar una).
function assigned(cuadrillas, itemId, exceptId) {
  let n = 0;
  for (const c of cuadrillas) {
    if (String(c.id) === String(exceptId)) continue;
    for (const list of ["materials", "tools"])
      for (const it of c[list] || []) if (it.i === itemId) n += it.q;
  }
  return n;
}

function duplicateOf(catalog, name, exceptId) {
  return catalog.find((e) => e.id !== exceptId && Names.same(e.name, name));
}

// Valida y normaliza una cuadrilla recibida del navegador.
function cleanCuadrilla(id, b, catalog, others) {
  if (!isObj(b) || String(b.id) !== String(id)) throw new HttpError(400, "Cuadrilla inválida");
  const name = clip(b.name, 60);
  if (!name) throw new HttpError(400, "La cuadrilla necesita un nombre");
  const people = (a) => (Array.isArray(a) ? a : []).map((n) => clip(n, 60)).filter(Boolean).slice(0, 300);
  const out = {
    id: Number(id), name, address: clip(b.address, 120), lead: clip(b.lead, 60),
    motor: people(b.motor), alumnos: people(b.alumnos), materials: [], tools: [],
  };
  for (const list of ["materials", "tools"]) {
    const sum = new Map();
    for (const it of Array.isArray(b[list]) ? b[list] : []) {
      const e = catalog.find((x) => x.id === Number(it?.i));
      if (!e) throw new HttpError(400, "Ese elemento no existe en la bodega central");
      if (e.kind !== LIST_KIND[list])
        throw new HttpError(400, `“${e.name}” es ${e.kind === "tool" ? "una herramienta" : "un material"}, no ${e.kind === "tool" ? "un material" : "una herramienta"}.`);
      sum.set(e.id, (sum.get(e.id) || 0) + int(it.q));
    }
    for (const [i, q] of sum) {
      const e = catalog.find((x) => x.id === i);
      const left = e.total - assigned(others, i);
      if (q > left)
        throw new HttpError(409, `No hay suficientes “${e.name}” en la parroquia: quedan ${Math.max(0, left)}.`);
      out[list].push({ i, q });
    }
  }
  return out;
}

// La etapa que está recibiendo solicitudes (se crea sola si no hay ninguna).
async function openStage(c) {
  const etapas = await allData(c, "etapas");
  let e = etapas.find((x) => x.state === "abierta");
  if (!e) {
    e = { id: Date.now(), name: `Etapa ${etapas.length + 1}`, state: "abierta", createdAt: new Date().toISOString() };
    await c.query("INSERT INTO etapas (id, data) VALUES ($1, $2)", [e.id, e]);
  }
  return e;
}

async function handleApi(req, res, url, role) {
  const m = req.method;
  const canEdit = role === "admin" || role === "usuario";
  const need = (ok) => { if (!ok) throw new HttpError(403, "Tu rol no permite hacer cambios."); };

  if (url === "/api/me" && m === "GET") return send(res, 200, { role, open: OPEN });

  // ---- Bodega central: catálogo de materiales y herramientas con su cantidad total
  if (url === "/api/catalog" && m === "GET")
    return send(res, 200, await allData(pool, "catalog"));

  if (url === "/api/catalog" && m === "POST") {
    need(role === "admin");
    const b = await readBody(req);
    const kind = b.kind, name = clip(b.name, 60);
    if (!KIND[kind]) throw new HttpError(400, "Elige si es material o herramienta.");
    if (!Names.clean(name).length) throw new HttpError(400, "Falta el nombre.");
    return send(res, 200, await tx(async (c) => {
      const catalog = await allData(c, "catalog");
      const dup = duplicateOf(catalog, name);
      if (dup)
        throw new HttpError(409, dup.kind === kind
          ? `Ya existe “${dup.name}” en la bodega. Singular y plural cuentan como el mismo elemento.`
          : `“${dup.name}” ya existe como ${KIND[dup.kind]}. Un elemento no puede ser material y herramienta a la vez.`);
      const e = { id: Date.now(), kind, name, unit: kind === "material" ? clip(b.unit, 12) : "", total: int(b.total) };
      await c.query("INSERT INTO catalog (id, data) VALUES ($1, $2)", [e.id, e]);
      return e;
    }));
  }

  let mm = url.match(/^\/api\/catalog\/(\d+)$/);
  if (mm) {
    need(role === "admin");
    const id = Number(mm[1]);
    if (m === "PUT") {
      const b = await readBody(req);
      return send(res, 200, await tx(async (c) => {
        const catalog = await allData(c, "catalog"), e = catalog.find((x) => x.id === id);
        if (!e) throw new HttpError(404, "Ese elemento ya no existe.");
        const next = { ...e }; // el tipo (material/herramienta) no se puede cambiar
        if (b.name !== undefined) {
          next.name = clip(b.name, 60);
          if (!Names.clean(next.name).length) throw new HttpError(400, "Falta el nombre.");
          const dup = duplicateOf(catalog, next.name, id);
          if (dup) throw new HttpError(409, `Ya existe “${dup.name}” en la bodega.`);
        }
        if (b.unit !== undefined && e.kind === "material") next.unit = clip(b.unit, 12);
        if (b.total !== undefined) {
          next.total = int(b.total);
          const used = assigned(await allData(c, "cuadrillas"), id);
          if (next.total < used)
            throw new HttpError(409, `No puedes dejar “${e.name}” en ${next.total}: ${used} ya están asignados a cuadrillas.`);
        }
        await c.query("UPDATE catalog SET data = $2 WHERE id = $1", [id, next]);
        return next;
      }));
    }
    if (m === "DELETE") {
      return send(res, 200, await tx(async (c) => {
        const e = (await allData(c, "catalog")).find((x) => x.id === id);
        if (e && assigned(await allData(c, "cuadrillas"), id) > 0)
          throw new HttpError(409, `“${e.name}” está asignado a cuadrillas. Primero devuélvelo a la parroquia.`);
        await c.query("DELETE FROM catalog WHERE id = $1", [id]);
        return { ok: true };
      }));
    }
  }

  // ---- Cuadrillas
  if (url === "/api/cuadrillas" && m === "GET")
    return send(res, 200, await allData(pool, "cuadrillas"));

  mm = url.match(/^\/api\/cuadrillas\/(\d+)$/);
  if (mm) {
    need(canEdit);
    const id = mm[1];
    if (m === "PUT") {
      const b = await readBody(req);
      return send(res, 200, await tx(async (c) => {
        const cuadrillas = await allData(c, "cuadrillas");
        const data = cleanCuadrilla(id, b, await allData(c, "catalog"), cuadrillas.filter((x) => String(x.id) !== id));
        await c.query(
          `INSERT INTO cuadrillas (id, data, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`, [id, data]);
        return data;
      }));
    }
    if (m === "DELETE") {
      await pool.query("DELETE FROM cuadrillas WHERE id = $1", [id]); // lo asignado vuelve solo a la parroquia
      return send(res, 200, { ok: true });
    }
  }

  // ---- Lista de compra: solicitudes agrupadas por etapas.
  //   Una etapa abierta recibe solicitudes; el administrador aprueba o rechaza (con la cantidad aprobada)
  //   y la cierra. Lo aprobado queda como lista de compra de esa etapa y después se marca como comprado.
  const cid = clip(req.headers["x-cid"], 64); // identifica el navegador de quien pidió, para que pueda anular lo suyo
  const pub = ({ cid: owner, ...x }) => ({ ...x, mine: !!cid && owner === cid });

  if (url === "/api/compras" && m === "GET")
    return send(res, 200, {
      etapas: await allData(pool, "etapas"),
      solicitudes: (await allData(pool, "solicitudes")).map(pub),
    });

  if (url === "/api/solicitudes" && m === "POST") {
    need(canEdit);
    const b = await readBody(req);
    const author = clip(b.author, 60), name = clip(b.name, 80), unit = clip(b.unit, 12), q = int(b.q, 1e6);
    if (!author || !Names.clean(name).length || q < 1)
      throw new HttpError(400, "Faltan tu nombre, lo que necesitas o la cantidad.");
    return send(res, 200, await tx(async (c) => {
      const cu = (await allData(c, "cuadrillas")).find((x) => x.id === Number(b.cuadrilla));
      if (!cu) throw new HttpError(400, "Elige tu cuadrilla.");
      const known = (await allData(c, "catalog")).find((e) => Names.same(e.name, name));
      const etapa = await openStage(c);
      const sol = {
        id: Date.now(), etapa: etapa.id, author, cuadrilla: { id: cu.id, name: cu.name },
        name: known ? known.name : name, unit: unit || (known ? known.unit : ""), q,
        itemId: known ? known.id : null, status: "pendiente", approvedQ: null, note: "",
        bought: false, ts: new Date().toISOString(), cid,
      };
      await c.query("INSERT INTO solicitudes (id, data) VALUES ($1, $2)", [sol.id, sol]);
      return pub(sol);
    }));
  }

  if (url === "/api/solicitudes/comprado" && m === "POST") {
    need(role === "admin");
    const b = await readBody(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number);
    // Al marcar como comprado, lo comprado se suma a la bodega central; al deshacer, se resta lo mismo.
    // Si el elemento todavía no existe en la bodega, hay que decir si es material o herramienta (b.kinds[id]).
    const kinds = isObj(b.kinds) ? b.kinds : {};
    return send(res, 200, await tx(async (c) => {
      const etapas = await allData(c, "etapas");
      const catalog = await allData(c, "catalog");
      const cuadrillas = await allData(c, "cuadrillas");
      const saveItem = (e) => c.query("UPDATE catalog SET data = $2 WHERE id = $1", [e.id, e]);
      let newId = Date.now();
      const out = [];
      for (const id of ids) {
        const sol = (await c.query("SELECT data FROM solicitudes WHERE id = $1", [id])).rows[0]?.data;
        if (!sol) continue;
        const e = etapas.find((x) => x.id === sol.etapa);
        if (sol.status !== "aprobada" || e?.state !== "cerrada")
          throw new HttpError(409, "Solo se marcan como compradas las solicitudes aprobadas de una etapa cerrada.");
        const next = { ...sol };
        if (b.bought && !sol.bought) {
          let item = catalog.find((x) => Names.same(x.name, sol.name));
          if (!item) {
            const kind = kinds[id];
            if (!KIND[kind]) throw new HttpError(409, `“${sol.name}” no está en la bodega central: indica si es material o herramienta.`);
            item = { id: newId++, kind, name: sol.name, unit: kind === "material" ? sol.unit : "", total: 0 };
            catalog.push(item);
            await c.query("INSERT INTO catalog (id, data) VALUES ($1, $2)", [item.id, item]);
          } else if (item.kind === "material" && sol.unit && item.unit && Names.clean(sol.unit).join(" ") !== Names.clean(item.unit).join(" "))
            throw new HttpError(409, `“${sol.name}” se pidió en ${sol.unit} y la bodega lo cuenta en ${item.unit}. Súmalo a mano en Inventario.`);
          item.total += sol.approvedQ;
          await saveItem(item);
          next.stocked = { i: item.id, q: sol.approvedQ };
          next.bought = true; next.boughtAt = new Date().toISOString();
        } else if (!b.bought && sol.bought) {
          const item = sol.stocked && catalog.find((x) => x.id === sol.stocked.i);
          if (item) {
            if (item.total - sol.stocked.q < assigned(cuadrillas, item.id))
              throw new HttpError(409, `No se puede deshacer: “${item.name}” quedaría con menos de lo que ya tienen asignado las cuadrillas.`);
            item.total -= sol.stocked.q;
            await saveItem(item);
          }
          next.stocked = null; next.bought = false; next.boughtAt = null;
        }
        await c.query("UPDATE solicitudes SET data = $2 WHERE id = $1", [id, next]);
        out.push(pub(next));
      }
      return out;
    }));
  }

  mm = url.match(/^\/api\/solicitudes\/(\d+)$/);
  if (mm && m === "PUT") {
    need(role === "admin");
    const id = Number(mm[1]), b = await readBody(req);
    return send(res, 200, await tx(async (c) => {
      const sol = (await c.query("SELECT data FROM solicitudes WHERE id = $1", [id])).rows[0]?.data;
      if (!sol) throw new HttpError(404, "Esa solicitud ya no existe.");
      const e = (await allData(c, "etapas")).find((x) => x.id === sol.etapa);
      if (e?.state !== "abierta") throw new HttpError(409, "La etapa está cerrada: ya no se puede aprobar ni rechazar.");
      const next = { ...sol };
      if (b.status !== undefined) {
        if (!["pendiente", "aprobada", "rechazada"].includes(b.status)) throw new HttpError(400, "Estado inválido.");
        next.status = b.status;
      }
      if (next.status === "aprobada") {
        next.approvedQ = b.approvedQ !== undefined ? int(b.approvedQ, 1e6) : sol.approvedQ ?? sol.q;
        if (next.approvedQ < 1) throw new HttpError(400, "La cantidad aprobada debe ser al menos 1.");
      } else next.approvedQ = null;
      next.note = next.status === "rechazada" && b.note !== undefined ? clip(b.note, 200) : next.status === "rechazada" ? sol.note : "";
      await c.query("UPDATE solicitudes SET data = $2 WHERE id = $1", [id, next]);
      return pub(next);
    }));
  }
  if (mm && m === "DELETE") {
    need(canEdit);
    const id = Number(mm[1]);
    return send(res, 200, await tx(async (c) => {
      const sol = (await c.query("SELECT data FROM solicitudes WHERE id = $1", [id])).rows[0]?.data;
      if (!sol) return { ok: true };
      const e = (await allData(c, "etapas")).find((x) => x.id === sol.etapa);
      if (e?.state !== "abierta") throw new HttpError(409, "La etapa está cerrada: la solicitud queda como registro.");
      const own = !!cid && sol.cid === cid && sol.status === "pendiente";
      if (role !== "admin" && !own) throw new HttpError(403, "Solo puedes anular tus solicitudes pendientes.");
      await c.query("DELETE FROM solicitudes WHERE id = $1", [id]);
      return { ok: true };
    }));
  }

  if (url === "/api/etapas/cerrar" && m === "POST") {
    need(role === "admin");
    return send(res, 200, await tx(async (c) => {
      const etapa = await openStage(c);
      const sols = (await allData(c, "solicitudes")).filter((x) => x.etapa === etapa.id);
      const aprobadas = sols.filter((x) => x.status === "aprobada");
      if (!aprobadas.length) throw new HttpError(409, "No hay solicitudes aprobadas: aprueba al menos una para cerrar la etapa.");
      const closed = { ...etapa, state: "cerrada", closedAt: new Date().toISOString() };
      await c.query("UPDATE etapas SET data = $2 WHERE id = $1", [etapa.id, closed]);
      const next = await openStage(c); // la siguiente etapa; recibe las pendientes
      for (const x of sols.filter((y) => y.status === "pendiente"))
        await c.query("UPDATE solicitudes SET data = $2 WHERE id = $1", [x.id, { ...x, etapa: next.id }]);
      return {
        etapas: await allData(c, "etapas"),
        solicitudes: (await allData(c, "solicitudes")).map(pub),
      };
    }));
  }

  throw new HttpError(404, "No encontrado");
}

async function handle(req, res) {
  const url = req.url.split("?")[0];
  if (url === "/health") return send(res, 200, "ok", "text/plain");

  if (!OPEN && url === "/login") {
    if (req.method === "POST") return handleLogin(req, res);
    return roleOf(req)
      ? (res.writeHead(303, { Location: "/" }), res.end())
      : send(res, 200, loginPage(""), "text/html; charset=utf-8");
  }
  if (!OPEN && url === "/logout" && req.method === "POST") {
    res.writeHead(303, { "Set-Cookie": setCookie(req, "", 0), Location: "/" });
    return res.end();
  }

  const role = roleOf(req);
  if (!role) {
    if (url.startsWith("/api/")) return send(res, 401, { error: "Falta iniciar sesión" });
    return send(res, 200, loginPage(""), "text/html; charset=utf-8");
  }
  if (url.startsWith("/api/")) return handleApi(req, res, url, role);
  if (STATIC[url]) return send(res, 200, fs.readFileSync(path.join(PUBLIC, STATIC[url][0])), STATIC[url][1]);
  send(res, 404, { error: "No encontrado" });
}

// Pasa de la versión anterior (materiales escritos a mano en cada cuadrilla y una "parroquia" guardada
// como cuadrilla) a bodega central + asignaciones. Lo que ya estaba cargado se conserva.
async function migrate(c) {
  const done = await c.query("SELECT 1 FROM meta WHERE key = 'bodega_v2'");
  if (done.rowCount) return;
  const rows = await allData(c, "cuadrillas");
  const catalog = [];
  let nextId = Date.now();
  for (const row of rows) {
    const isOldParroquia = row.id === 1;
    for (const [list, kind] of [["materials", "material"], ["tools", "tool"]]) {
      const converted = [];
      for (const it of row[list] || []) {
        if (it.i !== undefined) { converted.push(it); continue; }
        const name = clip(it.n, 60);
        if (!name) continue;
        let e = catalog.find((x) => Names.same(x.name, name));
        if (!e) {
          e = { id: nextId++, kind, name, unit: kind === "material" ? clip(it.u, 12) : "", total: 0 };
          catalog.push(e);
        }
        const q = int(it.q);
        e.total += q;
        if (!isOldParroquia) converted.push({ i: e.id, q });
      }
      row[list] = isOldParroquia ? [] : converted;
    }
  }
  for (const e of catalog) await c.query("INSERT INTO catalog (id, data) VALUES ($1, $2)", [e.id, e]);
  for (const row of rows) {
    if (row.id === 1) await c.query("DELETE FROM cuadrillas WHERE id = 1");
    else await c.query("UPDATE cuadrillas SET data = $2 WHERE id = $1", [row.id, row]);
  }
  await c.query("INSERT INTO meta (key) VALUES ('bodega_v2')");
}

async function start() {
  await pool.query(`CREATE TABLE IF NOT EXISTS cuadrillas (
    id BIGINT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // La tabla "avisos" de versiones anteriores se deja como está (sin uso) para no perder datos.
  await pool.query(`CREATE TABLE IF NOT EXISTS etapas (id BIGINT PRIMARY KEY, data JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS solicitudes (id BIGINT PRIMARY KEY, data JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS catalog (id BIGINT PRIMARY KEY, data JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY)`);
  await tx(migrate);
  return http
    .createServer((req, res) =>
      handle(req, res).catch((e) => {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        console.error(e);
        send(res, 500, { error: "Error del servidor" });
      })
    )
    .listen(PORT, "0.0.0.0", () => console.log(`Escuchando en puerto ${PORT}`));
}

if (require.main === module) start();
module.exports = { start };
