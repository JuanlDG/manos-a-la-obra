const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "public", "index.html");

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    fs.readFile(FILE, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("Error");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  })
  .listen(PORT, "0.0.0.0", () => console.log(`Escuchando en puerto ${PORT}`));
