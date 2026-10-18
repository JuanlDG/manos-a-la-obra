// Comparación de nombres de materiales y herramientas.
// Se usa tanto en el servidor como en el navegador, para que singular y plural
// (taladro / taladros, pincel / pinceles, lápiz / lápices) cuenten como el mismo elemento.
(function (root) {
  const clean = (s) =>
    String(s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

  // Formas posibles de una palabra en singular. Se compara contra las formas de la otra,
  // porque "cables" y "pinceles" terminan igual pero sus singulares son "cable" y "pincel".
  function forms(w) {
    const f = new Set([w]);
    if (w.length > 3) {
      if (w.endsWith("ces")) f.add(w.slice(0, -3) + "z");
      if (w.endsWith("es")) f.add(w.slice(0, -2));
      if (w.endsWith("s")) f.add(w.slice(0, -1));
    }
    return f;
  }

  function same(a, b) {
    const x = clean(a), y = clean(b);
    if (!x.length || x.length !== y.length) return false;
    return x.every((w, i) => {
      const fy = forms(y[i]);
      return [...forms(w)].some((v) => fy.has(v));
    });
  }

  // Texto para buscar mientras se escribe: cada palabra escrita debe aparecer al inicio de alguna palabra del nombre.
  function matches(name, typed) {
    const n = clean(name), t = clean(typed);
    return t.every((w) => {
      const singles = [...forms(w)];
      return n.some((nw) => singles.some((s) => nw.startsWith(s)));
    });
  }

  const api = { same, matches, clean };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Names = api;
})(typeof window !== "undefined" ? window : globalThis);
