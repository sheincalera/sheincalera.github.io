/*
 * Página oficial de la tienda. Lee data/catalogo.json (lo genera FrasisStore cada pocos minutos,
 * ver Services/LandingExportService.cs) y arma todo en el navegador: es un sitio estático, así que
 * si la tienda se queda sin internet la página sigue mostrando la última foto.
 *
 * NAVEGACIÓN (rediseño 21-nov-2026, validado con la dueña):
 *   Línea > Categoría > Tipo es la columna vertebral. Línea en pestañas, categoría en círculos con
 *   foto, tipo en chips; en escritorio además árbol en la barra lateral y menú desplegable.
 *   Los filtros (talla, color, precio, rebajas) son FACETAS DINÁMICAS: cada opción se cuenta
 *   aplicando todos los demás filtros, y solo aparece si hay prendas. Así, viendo Vestidos, solo
 *   salen tallas de vestidos.
 *
 * El precio YA VIENE resuelto en el JSON (c_product.CurrentPrice manda, ver CLAUDE.md). Aquí solo
 * se oculta una oferta cuyo offer_ends_at ya pasó entre una publicación y la siguiente.
 */
(function () {
  "use strict";

  var PAGE = 24;
  var BAG_KEY = "landing-bag-v1";
  var $ = function (id) { return document.getElementById(id); };
  var isDesktop = function () { return window.matchMedia("(min-width: 1024px)").matches; };

  // ---------------------------------------------------------------- catálogos de presentación
  // Solo cambian cómo SE VE el nombre; en el sistema siguen igual. Aprobados por la dueña.
  var LINE_ORDER = ["Dama", "Infantil", "Caballero"];
  var LINE_LABEL = { "Infantil": "Niña y Niño" };
  var CAT_MAP = {
    "VESTIDOS": ["Vestidos", 1],
    "TOP": ["Blusas y tops", 2],
    "BOTTOM": ["Pantalones y faldas", 3],
    "CONJUNTO": ["Conjuntos", 4],
    "TOP ABRIGO": ["Abrigos y chamarras", 5],
    "FULL BODY": ["Jumpsuits y enterizos", 6],
    "ROPA DEPORTIVA": ["Deportiva", 7],
    "ROPA PLAYA": ["Playa", 8],
    "ROPA INTERIOR": ["Lencería y pijamas", 9],
    "BOLSAS": ["Bolsas", 10],
    "CALZADO": ["Calzado", 11],
    "ACCESORIOS": ["Accesorios", 12],
    "ACCESORIOS CABELLO": ["Accesorios", 12]
  };
  var PRICE_BUCKETS = [
    { k: "a", label: "Hasta $150", max: 150 },
    { k: "b", label: "$151 a $300", max: 300 },
    { k: "c", label: "$301 a $500", max: 500 },
    { k: "d", label: "Más de $500", max: Infinity }
  ];
  var VIEWS = {
    promo: { label: "Promociones", icon: "i-clock" },
    "new": { label: "Novedades", icon: "i-spark" },
    pct: { label: "Mejor descuento %", icon: "i-pct", sale: true },
    save: { label: "Mayor ahorro $", icon: "i-cash", sale: true },
    asc: { label: "Menor precio", icon: "i-up" },
    desc: { label: "Mayor precio", icon: "i-down" }
  };

  var state = {
    data: null, products: [],
    line: "Dama", cat: "", type: "",
    sizes: [], colors: [], prices: [], onlyOffers: false, q: "",
    view: "new",
    filtered: [], shown: 0,
    // En móvil el árbol de categorías arranca cerrado: ahí ya están los círculos y los chips, y
    // abierto empuja Talla y Color fuera de la pantalla.
    openFacets: { cat: window.matchMedia("(min-width: 1024px)").matches, size: true, color: true, price: false },
    bag: loadBag(), current: null, currentSize: null
  };

  // ---------------------------------------------------------------- utilidades
  var mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
  function money(n) { return n % 1 === 0 ? mxn.format(n) : "$" + Number(n).toFixed(2); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }
  function titleCase(s) { return String(s || "").toLowerCase().replace(/(^|\s)\S/g, function (c) { return c.toUpperCase(); }); }
  function get(obj, path) { return path.split(".").reduce(function (o, k) { return o == null ? o : o[k]; }, obj); }
  function icon(id) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#' + id + '"/></svg>'; }
  function lineLabel(l) { return LINE_LABEL[l] || l; }
  function plural(n, s, p) { return n + " " + (n === 1 ? s : (p || s + "s")); }
  function toast(msg, actionLabel, action) {
    var t = $("toast");
    t.innerHTML = (actionLabel ? icon("i-check") : "") + "<span></span>";
    t.querySelector("span").textContent = msg;
    if (actionLabel) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = actionLabel;
      b.onclick = function () { t.hidden = true; action(); };
      t.appendChild(b);
    }
    t.hidden = true; void t.offsetWidth; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, actionLabel ? 3500 : 2200);
  }
  function waLink(text) {
    var n = state.data && state.data.store.whatsapp;
    return n ? "https://wa.me/52" + n + "?text=" + encodeURIComponent(text) : null;
  }
  function pageUrl(code) {
    return location.origin + location.pathname + (code ? "#p=" + encodeURIComponent(code) : "");
  }

  // ---------------------------------------------------------------- estadísticas (GA4)
  // El ID vive en <meta name="ga-id">. En localhost nunca se manda nada; con ?debug=1 los eventos
  // se ven en la consola.
  var GA_ID = (document.querySelector('meta[name="ga-id"]') || {}).content || "";
  var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var debug = /[?&]debug=1/.test(location.search);
  if (GA_ID && !isLocal) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_ID, { currency: "MXN" });
    var gs = document.createElement("script");
    gs.async = true;
    gs.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_ID);
    document.head.appendChild(gs);
    $("analyticsNote").hidden = false;
  }
  function track(name, params) {
    if (debug) console.log("[GA]", name, params || {});
    if (window.gtag && GA_ID && !isLocal) window.gtag("event", name, params || {});
  }
  // item_id = CÓDIGO DE BARRAS, el mismo con el que la dueña busca la prenda en el PDV.
  function gaItem(p, size) {
    var it = { item_id: p.code, item_name: p.name.slice(0, 100), item_category: p._catLabel, item_category2: p.type, price: p.price, quantity: 1 };
    if (size) it.item_variant = size;
    if (p.offer) it.discount = p._save;
    return it;
  }

  // ---------------------------------------------------------------- tallas
  // Seis sistemas de talla conviven en la tienda (letras, plus, jeans, niñas, brasier, calzado). Se
  // agrupan y ordenan para que el filtro sea legible; "U" se muestra como Unitalla.
  var LETTERS = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "0XL", "1XL", "2XL", "3XL", "4XL", "5XL"];
  var sizeCache = {};
  function sizeInfo(code) {
    if (sizeCache[code]) return sizeCache[code];
    var c = String(code || "").trim(), u = c.toUpperCase(), n = parseFloat((c.match(/\d+(\.\d+)?/) || [])[0]) || 0, r;
    if (u === "U" || /^(UNITALLA|UNICA|ÚNICA)$/.test(u)) r = { label: "Unitalla", group: "Unitalla", g: 0, o: 0 };
    else if (LETTERS.indexOf(u) >= 0) r = { label: c, group: "Ropa", g: 1, o: LETTERS.indexOf(u) };
    else if (/^JNS/i.test(c)) r = { label: c.replace(/^JNS\s*/i, ""), group: "Jeans", g: 2, o: n };
    else if (/\d\s*(-\s*\d+\s*)?(Y|M)$/i.test(c)) {
      // Rangos ("6-9 M", "2-3Y"): se ordena por el punto medio, en años.
      var meses = /M$/i.test(c), nums = (c.match(/\d+/g) || ["0"]).map(Number);
      var mid = nums.reduce(function (s, x) { return s + x; }, 0) / nums.length;
      r = { label: c.replace(/\s*Y$/i, " años").replace(/\s*M$/i, " meses"), group: "Niña y niño", g: 3, o: meses ? mid / 12 : mid };
    }
    else if (/^(BT|COPA)\b|^(AA|A|B|C|CC|D|DD|DDD)$/i.test(c)) r = { label: c, group: "Brasier", g: 4, o: n || c.charCodeAt(c.length - 1) };
    else if (/^MX/i.test(c)) r = { label: c.replace(/^MX\s*/i, ""), group: "Calzado (MX)", g: 5, o: n };
    else r = { label: c, group: "Otras", g: 9, o: n };
    r.code = c;
    return (sizeCache[code] = r);
  }
  function sortSizes(a, b) { var x = sizeInfo(a), y = sizeInfo(b); return x.g - y.g || x.o - y.o || String(a).localeCompare(String(b)); }

  // ---------------------------------------------------------------- colores
  var COLORS = {
    "negro": "#141414", "blanco": "#ffffff", "cafe": "#6f4e37", "chocolate": "#4e3227", "rosa": "#f2a7bb",
    "albaricoque": "#f3c4a0", "rojo": "#c0392b", "burdeos": "#6d1a2b", "vino": "#6d1a2b", "verde": "#2e8b57",
    "denim": "#4f6d8f", "mezclilla": "#4f6d8f", "azul marino": "#1f2a44", "marino": "#1f2a44", "morado": "#6b3fa0",
    "rosa fucsia": "#e0218a", "fucsia": "#e0218a", "gris": "#9a9a9a", "azul": "#2f6fd1", "azul rey": "#2340a8",
    "azul celeste": "#8ec5eb", "celeste": "#8ec5eb", "beige": "#e8d8be", "lila": "#c8a2c8", "lavanda": "#b9a6e0",
    "verde oscuro": "#1f4d33", "verde militar": "#556b2f", "militar": "#556b2f", "caqui": "#b9a67a", "khaki": "#b9a67a",
    "amarillo": "#f2d04b", "naranja": "#f08a24", "coral": "#f47c6a", "turquesa": "#30b5b0", "menta": "#98d7c2",
    "verde menta": "#98d7c2", "mostaza": "#d4a017", "nude": "#e3bc9a", "crema": "#f3ead8", "marfil": "#f6f0e1",
    "palo de rosa": "#d8a7a7", "rosa palo": "#e8bcbc", "salmon": "#f6a38b", "camel": "#c19a6b", "olivo": "#708238",
    "verde olivo": "#708238", "transparente": "linear-gradient(135deg,#f4f4f4,#ffffff)",
    "dorado": "linear-gradient(135deg,#8a6d1f,#e6cf7a 50%,#a8893a)",
    "plateado": "linear-gradient(135deg,#8d8d8d,#f0f0f0 50%,#a5a5a5)",
    "multicolor": "conic-gradient(#e74c3c,#f1c40f,#2ecc71,#3498db,#9b59b6,#e74c3c)",
    "animalprint": "radial-gradient(circle at 28% 30%,#3b2a1a 17%,transparent 19%),radial-gradient(circle at 70% 62%,#3b2a1a 15%,transparent 17%),radial-gradient(circle at 66% 22%,#3b2a1a 9%,transparent 11%),#c8a165",
    "animal print": "radial-gradient(circle at 28% 30%,#3b2a1a 17%,transparent 19%),radial-gradient(circle at 70% 62%,#3b2a1a 15%,transparent 17%),#c8a165"
  };
  var COLOR_KEYS = Object.keys(COLORS).sort(function (a, b) { return b.length - a.length; });
  function solid(n) {
    if (COLORS[n]) return COLORS[n];
    for (var i = 0; i < COLOR_KEYS.length; i++) if (n.indexOf(COLOR_KEYS[i]) >= 0) return COLORS[COLOR_KEYS[i]];
    return null;
  }
  function swatch(name) {
    var n = norm(name);
    if (COLORS[n]) return COLORS[n];
    // "Blanco y Negro", "Azul y blanco": mitad y mitad.
    var parts = n.split(/\s+y\s+|\s*\/\s*/);
    if (parts.length > 1) {
      var a = solid(parts[0]), b = solid(parts[1]);
      if (a && b && a.indexOf("gradient") < 0 && b.indexOf("gradient") < 0) return "linear-gradient(135deg," + a + " 50%," + b + " 50%)";
    }
    return solid(n) || "#cfc8bb";
  }

  // ---------------------------------------------------------------- ventanas y botón "Atrás"
  // En el celular, el botón Atrás debe CERRAR la ficha/bolsa/filtros, no sacar a la clienta de la
  // página. Cada ventana abierta deja una entrada en el historial; Atrás la consume.
  var stack = [];
  function el(id) { return $(id); }
  function showOv(id) {
    var e = el(id);
    if (e.tagName === "DIALOG") { if (!e.open) e.showModal(); }
    else { e.classList.add("open"); document.body.classList.add("no-scroll"); }
  }
  function hideOv(id) {
    var e = el(id);
    if (e.tagName === "DIALOG") { if (e.open) { e._hiding = true; e.close(); } }
    else { e.classList.remove("open"); document.body.classList.remove("no-scroll"); }
    var i = stack.lastIndexOf(id); if (i >= 0) stack.splice(i, 1);
    if (id === "productSheet" && location.hash.indexOf("#p=") === 0) history.replaceState(history.state, "", location.pathname + location.search);
  }
  function openOv(id, url) {
    if (stack.indexOf(id) >= 0) return;
    showOv(id);
    stack.push(id);
    history.pushState({ ov: id }, "", url || location.href);
  }
  function closeOv(id) {
    if (stack.indexOf(id) < 0) { hideOv(id); return; }
    if (history.state && history.state.ov === id) history.back(); // popstate la cierra
    else hideOv(id);
  }
  window.addEventListener("popstate", function () {
    while (stack.length && !(history.state && history.state.ov === stack[stack.length - 1])) hideOv(stack[stack.length - 1]);
  });
  document.querySelectorAll("dialog").forEach(function (d) {
    d.addEventListener("click", function (e) {
      if (e.target === d || e.target.closest("[data-close]")) closeOv(d.id);
    });
    // Esc nativo: el diálogo ya se cerró solo; hay que consumir su entrada del historial.
    d.addEventListener("close", function () {
      if (d._hiding) { d._hiding = false; return; }
      var i = stack.lastIndexOf(d.id);
      if (i >= 0) { stack.splice(i, 1); if (history.state && history.state.ov === d.id) history.back(); }
    });
  });

  // ---------------------------------------------------------------- carga
  fetch("data/catalogo.json?v=" + Math.floor(Date.now() / 60000), { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(function () {
      $("loading").hidden = true;
      $("resultsTitle").textContent = "No pudimos cargar el catálogo";
      $("resultsCount").textContent = "Escríbenos por WhatsApp y con gusto te atendemos.";
    });

  function lista(name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    return (m && m.content ? m.content.split(";") : []).map(function (s) { return norm(s); }).filter(Boolean);
  }

  function init(data) {
    state.data = data;
    var now = Date.now();
    var ocultarCat = lista("ocultar-categorias"), ocultarTipo = lista("ocultar-tipos");

    state.products = (data.products || []).filter(function (p) {
      return ocultarCat.indexOf(norm(p.category)) < 0 && ocultarTipo.indexOf(norm(p.type)) < 0;
    }).map(function (p) {
      if (p.offer && p.offer_ends_at && Date.parse(p.offer_ends_at) <= now && p.regular_price) {
        p = Object.assign({}, p, { price: p.regular_price, regular_price: null, offer: null, offer_ends_at: null });
      }
      var key = String(p.category || "").toUpperCase().trim();
      var cm = CAT_MAP[key];
      p.line = p.line || "Dama";
      p._catLabel = cm ? cm[0] : (key ? titleCase(key) : "Otros");
      p._catOrder = cm ? cm[1] : 50;
      p._pct = p.regular_price && p.regular_price > p.price ? Math.round((1 - p.price / p.regular_price) * 100) : 0;
      p._save = p.regular_price && p.regular_price > p.price ? Math.round(p.regular_price - p.price) : 0;
      p._timed = p.offer && p.offer_ends_at ? Date.parse(p.offer_ends_at) : 0;
      p._color = p.color ? p.color.trim() : "";
      p._bucket = PRICE_BUCKETS.filter(function (b) { return p.price <= b.max; })[0].k;
      p._sizeCodes = p.sizes.map(function (s) { return s.code; }).sort(sortSizes);
      p._search = norm([p.name, p.code, p.type, p._catLabel, p._color, p.description || ""].join(" "));
      p._arr = (p.arrived_at || "") + String(1e7 + p.id);
      return p;
    });

    // Promociones con vigencia arriba; si no hay, lo más nuevo.
    state.view = state.products.some(function (p) { return p._timed; }) ? "promo" : "new";
    // Dama abre por defecto (si existe), salvo que la URL diga otra.
    if (!lineCounts()[state.line]) state.line = lines()[0] || "";
    readParams();

    bindText();
    setupWhatsApp();
    setupSocials();
    refresh(false);
    renderBag();
    $("loading").hidden = true;

    var gen = new Date(data.generated_at);
    $("updated").textContent = "Existencias actualizadas: " +
      gen.toLocaleString("es-MX", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

    // Enlace directo a una prenda (#p=CÓDIGO): lo que se comparte en redes abre la ficha.
    var m = location.hash.match(/^#p=(.+)$/);
    if (m) {
      history.replaceState(null, "", location.pathname + location.search);
      openProduct(decodeURIComponent(m[1]), true);
    }
  }

  // Enlaces a una sección: ?linea=Infantil&cat=Vestidos&tipo=...&vista=pct (para redes sociales).
  function readParams() {
    var q = new URLSearchParams(location.search);
    var line = q.get("linea"), cat = q.get("cat"), tipo = q.get("tipo"), vista = q.get("vista");
    if (line) {
      var l = LINE_ORDER.concat(Object.keys(lineCounts())).filter(function (x) { return norm(x) === norm(line) || norm(lineLabel(x)) === norm(line); })[0];
      if (l) state.line = l;
    }
    if (cat) { var c = state.products.filter(function (p) { return norm(p._catLabel) === norm(cat); })[0]; if (c) state.cat = c._catLabel; }
    if (tipo) { var t = state.products.filter(function (p) { return norm(p.type) === norm(tipo); })[0]; if (t) { state.type = t.type; state.cat = t._catLabel; } }
    if (vista && VIEWS[vista]) state.view = vista;
  }

  function bindText() {
    document.querySelectorAll("[data-bind]").forEach(function (e) {
      var v = get(state.data, e.getAttribute("data-bind"));
      if (v == null || v === "") { if (e.hasAttribute("data-hide-empty")) e.hidden = true; return; }
      e.textContent = v;
    });
    document.title = (state.data.store.name || "Tienda") + " · Novedades en tienda";
  }
  function setupWhatsApp() {
    var link = waLink("¡Hola! Vi su página y quiero información.");
    document.querySelectorAll("[data-wa-general]").forEach(function (a) { if (link) a.href = link; else a.hidden = true; });
    if (!link) document.querySelectorAll(".wa-only").forEach(function (a) { a.hidden = true; });
    if (state.data.store.maps_url) { $("mapsLink").href = state.data.store.maps_url; $("mapsLink").hidden = false; }
  }
  function setupSocials() {
    var s = state.data.store, html = "";
    [["facebook_url", "i-fb", "Facebook"], ["instagram_url", "i-ig", "Instagram"], ["tiktok_url", "i-tt", "TikTok"]].forEach(function (x) {
      if (s[x[0]]) html += '<a href="' + esc(s[x[0]]) + '" target="_blank" rel="noopener" aria-label="' + x[2] + '">' + icon(x[1]) + "</a>";
    });
    $("socials").innerHTML = html;
  }

  // ---------------------------------------------------------------- filtrado por facetas
  // matches(p, skip): ¿la prenda pasa todos los filtros MENOS el de la faceta "skip"? Contar cada
  // opción así es lo que hace que los filtros sean dinámicos sin quedarse en cero al elegir.
  function words() { return state.q ? norm(state.q).split(/\s+/) : []; }
  function matches(p, skip, ignoreLine) {
    if (!ignoreLine && p.line !== state.line) return false;
    if (skip !== "cat" && state.cat && p._catLabel !== state.cat) return false;
    if (skip !== "cat" && skip !== "type" && state.type && p.type !== state.type) return false;
    if (skip !== "size" && state.sizes.length && !p._sizeCodes.some(function (c) { return state.sizes.indexOf(c) >= 0; })) return false;
    if (skip !== "color" && state.colors.length && state.colors.indexOf(p._color) < 0) return false;
    if (skip !== "price" && state.prices.length && state.prices.indexOf(p._bucket) < 0) return false;
    if (skip !== "offer" && skip !== "view" && (state.onlyOffers || (VIEWS[state.view] && VIEWS[state.view].sale)) && !p.offer) return false;
    var w = words();
    for (var i = 0; i < w.length; i++) if (p._search.indexOf(w[i]) < 0) return false;
    return true;
  }
  function countBy(skip, keyFn) {
    var m = {};
    state.products.forEach(function (p) {
      if (!matches(p, skip)) return;
      var keys = keyFn(p);
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { if (k !== "" && k != null) m[k] = (m[k] || 0) + 1; });
    });
    return m;
  }
  function lineCounts() {
    var m = {};
    state.products.forEach(function (p) { m[p.line] = (m[p.line] || 0) + 1; });
    return m;
  }
  function lines() {
    var c = lineCounts();
    return Object.keys(c).sort(function (a, b) {
      var ia = LINE_ORDER.indexOf(a), ib = LINE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || c[b] - c[a];
    });
  }
  // Árbol completo de la línea (sin filtros): para el menú y el desplegable.
  function treeOf(line) {
    var cats = {};
    state.products.forEach(function (p) {
      if (p.line !== line) return;
      var c = cats[p._catLabel] || (cats[p._catLabel] = { label: p._catLabel, order: p._catOrder, n: 0, types: {} });
      c.n++;
      c.types[p.type] = (c.types[p.type] || 0) + 1;
    });
    return Object.keys(cats).map(function (k) { return cats[k]; }).sort(function (a, b) { return a.order - b.order || b.n - a.n; });
  }

  function sorted(list) {
    var byNew = function (a, b) { return a._arr < b._arr ? 1 : a._arr > b._arr ? -1 : 0; };
    var f = {
      promo: function (a, b) { return (a._timed ? 0 : 1) - (b._timed ? 0 : 1) || (a._timed - b._timed) || byNew(a, b); },
      "new": byNew,
      pct: function (a, b) { return b._pct - a._pct || b._save - a._save || byNew(a, b); },
      save: function (a, b) { return b._save - a._save || b._pct - a._pct || byNew(a, b); },
      asc: function (a, b) { return a.price - b.price || byNew(a, b); },
      desc: function (a, b) { return b.price - a.price || byNew(a, b); }
    }[state.view] || byNew;
    return list.slice().sort(f);
  }

  // ---------------------------------------------------------------- render general
  function refresh(scroll) {
    state.filtered = sorted(state.products.filter(function (p) { return matches(p); }));
    renderLines();
    renderMainNav();
    renderHero();
    renderCatTiles();
    renderHead();
    renderTypeChips();
    renderViews();
    renderFacets();
    renderApplied();
    renderMenuTree();
    state.shown = 0;
    $("grid").innerHTML = "";
    $("empty").hidden = state.filtered.length > 0;
    if (!state.filtered.length) renderEmptyHint();
    more();
    if (scroll) goResults();
  }

  function goResults() {
    var t = $("crumbs").getBoundingClientRect().top + window.scrollY - (isDesktop() ? 80 : 72);
    if (Math.abs(window.scrollY - t) > 40) window.scrollTo({ top: t, behavior: "smooth" });
  }

  function setLine(l) {
    if (state.line === l) return;
    state.line = l; state.cat = ""; state.type = ""; state.sizes = []; state.colors = []; state.prices = [];
    track("select_content", { content_type: "linea", item_id: l });
  }
  function setCat(c, t) {
    state.cat = c || ""; state.type = t || "";
    // Las tallas de otra categoría casi nunca existen en la nueva: se limpian para no dejar en cero.
    state.sizes = [];
    if (c) track("select_content", { content_type: t ? "tipo" : "categoria", item_id: t || c });
  }

  function renderLines() {
    var c = lineCounts();
    var html = lines().map(function (l) {
      return '<button class="line-tab" role="tab" aria-selected="' + (l === state.line) + '" data-line="' + esc(l) + '">' +
        esc(lineLabel(l)) + "<small>" + c[l] + "</small></button>";
    }).join("");
    $("lineTabsMobile").innerHTML = html;
    $("lineTabsMenu").innerHTML = html;
  }
  function onLineClick(e) {
    var b = e.target.closest(".line-tab"); if (!b) return;
    setLine(b.getAttribute("data-line"));
    refresh(false);
  }
  $("lineTabsMobile").addEventListener("click", onLineClick);
  $("lineTabsMenu").addEventListener("click", onLineClick);

  // Escritorio: líneas con panel de categorías > tipos (como las departamentales).
  function renderMainNav() {
    var c = lineCounts();
    $("mainNav").innerHTML = lines().map(function (l) {
      var cols = treeOf(l).map(function (cat) {
        var types = Object.keys(cat.types).sort(function (a, b) { return cat.types[b] - cat.types[a]; });
        return '<div class="mega-col"><b data-nav="' + esc(l) + '|' + esc(cat.label) + '|">' + esc(cat.label) + "</b>" +
          types.map(function (t) { return '<button type="button" data-nav="' + esc(l) + "|" + esc(cat.label) + "|" + esc(t) + '">' + esc(t) + "</button>"; }).join("") +
          "</div>";
      }).join("");
      return '<div class="nav-item"><button type="button" class="nav-link' + (l === state.line ? " on" : "") + '" data-nav="' + esc(l) + '||">' +
        esc(lineLabel(l)) + "<small>" + c[l] + '</small></button><div class="mega">' + cols + "</div></div>";
    }).join("");
  }
  $("mainNav").addEventListener("click", function (e) {
    var b = e.target.closest("[data-nav]"); if (!b) return;
    var parts = b.getAttribute("data-nav").split("|");
    setLine(parts[0]); setCat(parts[1], parts[2]);
    if (document.activeElement) document.activeElement.blur(); // cierra el panel
    refresh(true);
  });

  // ---------------------------------------------------------------- portada
  function renderHero() {
    var inLine = state.products.filter(function (p) { return p.line === state.line; });
    var timed = inLine.filter(function (p) { return p._timed; });
    var camp = state.data.campaign || {};
    var campEnd = camp.ends_at ? Date.parse(camp.ends_at) : 0;
    var campActive = camp.title && campEnd > Date.now();
    var hero = $("hero"), rail;

    if (timed.length) {
      hero.classList.add("promo");
      $("heroEyebrow").textContent = "Promoción vigente";
      $("heroTitle").textContent = campActive ? camp.title : "Precios especiales por tiempo limitado";
      rail = timed.slice().sort(function (a, b) { return a._timed - b._timed || b._pct - a._pct; }).slice(0, 12);
      startCountdown(Math.min.apply(null, timed.map(function (p) { return p._timed; })));
      $("heroAll").setAttribute("data-view", "promo");
    } else {
      hero.classList.remove("promo");
      var newest = inLine.slice().sort(function (a, b) { return a._arr < b._arr ? 1 : -1; });
      var weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      $("heroEyebrow").textContent = "Recién llegado";
      $("heroTitle").textContent = newest[0] && newest[0].arrived_at >= weekAgo ? "Lo nuevo de la semana" : "Lo más reciente";
      rail = newest.filter(function (p) { return p.image; }).slice(0, 12);
      startCountdown(0);
      $("heroAll").setAttribute("data-view", "new");
    }
    $("heroRail").innerHTML = rail.map(function (p) { return card(p, true); }).join("");
    hero.hidden = rail.length === 0;
  }
  var cdTimer;
  function startCountdown(end) {
    clearInterval(cdTimer);
    var box = $("countdown");
    if (!end) { box.hidden = true; return; }
    function tick() {
      var s = Math.floor((end - Date.now()) / 1000);
      if (s <= 0) { box.hidden = true; clearInterval(cdTimer); return; }
      box.hidden = false;
      var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
      $("cdText").textContent = (d ? d + "d " : "") + String(h).padStart(2, "0") + "h " + String(m).padStart(2, "0") + "m" + (d ? "" : " " + String(s % 60).padStart(2, "0") + "s");
    }
    tick();
    cdTimer = setInterval(tick, 1000);
  }
  $("heroAll").addEventListener("click", function () {
    setCat("", "");
    state.view = this.getAttribute("data-view");
    refresh(true);
  });

  // ---------------------------------------------------------------- categorías con foto
  function renderCatTiles() {
    var counts = countBy("cat", function (p) { return p._catLabel; });
    var cats = treeOf(state.line);
    var total = state.products.filter(function (p) { return matches(p, "cat"); }).length;
    var sale = state.products.filter(function (p) { return p.line === state.line && p.offer; }).length;
    var html = '<button type="button" class="cat-tile' + (!state.cat ? " on" : "") + '" data-cat="">' +
      '<div class="ring special">' + icon("i-spark") + "</div><span>Todo<small>" + total + "</small></span></button>";
    if (sale) html += '<button type="button" class="cat-tile" data-sale="1"><div class="ring sale">%</div><span>Rebajas<small>' + sale + "</small></span></button>";
    cats.forEach(function (c) {
      var n = counts[c.label] || 0;
      if (!n && state.cat !== c.label) return;
      var photo = state.products.filter(function (p) { return p.line === state.line && p._catLabel === c.label && p.image; })
        .sort(function (a, b) { return a._arr < b._arr ? 1 : -1; })[0];
      html += '<button type="button" class="cat-tile' + (state.cat === c.label ? " on" : "") + '" data-cat="' + esc(c.label) + '">' +
        '<div class="ring">' + (photo ? '<img src="' + esc(photo.image) + '" alt="" data-ph="' + esc(c.label.charAt(0)) + '" loading="lazy" referrerpolicy="no-referrer">' : '<div class="ph">' + esc(c.label.charAt(0)) + "</div>") +
        "</div><span>" + esc(c.label) + "<small>" + n + "</small></span></button>";
    });
    $("catTiles").innerHTML = html;
  }
  $("catTiles").addEventListener("click", function (e) {
    var b = e.target.closest(".cat-tile"); if (!b) return;
    if (b.hasAttribute("data-sale")) { setCat("", ""); state.view = "pct"; track("select_content", { content_type: "vista", item_id: "rebajas" }); }
    else setCat(b.getAttribute("data-cat"), "");
    refresh(true);
  });

  // ---------------------------------------------------------------- encabezado de resultados
  function renderHead() {
    var parts = ['<button type="button" data-crumb="line">' + esc(lineLabel(state.line)) + "</button>"];
    if (state.cat) parts.push('<button type="button" data-crumb="cat">' + esc(state.cat) + "</button>");
    if (state.type) parts.push('<span class="here">' + esc(state.type) + "</span>");
    $("crumbs").innerHTML = parts.join('<span class="sep">/</span>');
    var title = state.type || state.cat || (state.q ? "Resultados" : (VIEWS[state.view].sale ? "Rebajas" : lineLabel(state.line)));
    $("resultsTitle").textContent = title;
    $("resultsCount").textContent = plural(state.filtered.length, "prenda") + (state.q ? ' para "' + state.q + '"' : "");
  }
  $("crumbs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-crumb]"); if (!b) return;
    if (b.getAttribute("data-crumb") === "line") setCat("", ""); else setCat(state.cat, "");
    refresh(false);
  });

  function renderTypeChips() {
    if (!state.cat) { $("typeChips").innerHTML = ""; return; }
    var counts = countBy("type", function (p) { return p._catLabel === state.cat ? p.type : null; });
    var types = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (state.type && types.indexOf(state.type) < 0) types.unshift(state.type);
    if (types.length < 2 && !state.type) { $("typeChips").innerHTML = ""; return; }
    var all = types.reduce(function (s, t) { return s + (counts[t] || 0); }, 0);
    $("typeChips").innerHTML = '<button type="button" class="chip' + (!state.type ? " on" : "") + '" data-type="">Todo <small>' + all + "</small></button>" +
      types.map(function (t) {
        return '<button type="button" class="chip' + (state.type === t ? " on" : "") + '" data-type="' + esc(t) + '">' + esc(t) + " <small>" + (counts[t] || 0) + "</small></button>";
      }).join("");
  }
  $("typeChips").addEventListener("click", function (e) {
    var b = e.target.closest(".chip"); if (!b) return;
    setCat(state.cat, b.getAttribute("data-type"));
    refresh(false);
  });

  // Vistas visuales: reemplazan el desplegable de "ordenar". Cada una dice cuántas prendas trae.
  function renderViews() {
    var base = state.products.filter(function (p) { return matches(p, "view"); });
    var nOffer = base.filter(function (p) { return p.offer; }).length;
    var nTimed = base.filter(function (p) { return p._timed; }).length;
    var nNew = base.filter(function (p) { return p.is_new; }).length;
    var order = (nTimed ? ["promo"] : []).concat(["new", "pct", "save", "asc", "desc"]);
    $("views").innerHTML = order.map(function (k) {
      var v = VIEWS[k], n = k === "promo" ? nTimed : k === "new" ? nNew : v.sale ? nOffer : null;
      if (v.sale && !nOffer && state.view !== k) return "";
      return '<button type="button" class="view' + (v.sale ? " v-sale" : "") + (state.view === k ? " on" : "") + '" data-view="' + k + '" role="tab" aria-selected="' + (state.view === k) + '">' +
        icon(v.icon) + esc(v.label) + (n ? " <small>" + n + "</small>" : "") + "</button>";
    }).join("");
    var on = $("views").querySelector(".on");
    if (on && on.scrollIntoView && !isDesktop()) {
      var box = $("views"), l = on.offsetLeft - box.offsetLeft;
      if (l < box.scrollLeft || l + on.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = l - 12;
    }
  }
  $("views").addEventListener("click", function (e) {
    var b = e.target.closest(".view"); if (!b) return;
    state.view = b.getAttribute("data-view");
    track("select_content", { content_type: "vista", item_id: state.view });
    refresh(false);
    goResults();
  });

  // ---------------------------------------------------------------- facetas (barra lateral / panel)
  function facet(id, title, sel, body) {
    return '<details class="facet" data-facet="' + id + '"' + (state.openFacets[id] ? " open" : "") + "><summary>" + esc(title) +
      (sel ? '<span class="sel">' + esc(sel) + "</span>" : "") + '</summary><div class="facet-body">' + body + "</div></details>";
  }
  function renderFacets() {
    var body = $("filtersBody"), keep = body.scrollTop, html = "";

    // 1. Categorías > Tipos (la jerarquía también vive aquí)
    var catCounts = countBy("cat", function (p) { return p._catLabel; });
    var typeCounts = countBy("type", function (p) { return p._catLabel === state.cat ? p.type : null; });
    var totalLine = Object.keys(catCounts).reduce(function (s, k) { return s + catCounts[k]; }, 0);
    var tree = '<ul class="tree"><li class="all' + (!state.cat ? " on" : "") + '"><button type="button" data-tcat="">Todo ' + esc(lineLabel(state.line)) + " <small>" + totalLine + "</small></button></li>";
    treeOf(state.line).forEach(function (c) {
      var n = catCounts[c.label] || 0;
      if (!n && state.cat !== c.label) return;
      var on = state.cat === c.label;
      tree += '<li class="' + (on ? "on" : "") + '"><button type="button" data-tcat="' + esc(c.label) + '">' + esc(c.label) + " <small>" + n + "</small></button>";
      if (on) {
        var types = Object.keys(typeCounts).sort(function (a, b) { return typeCounts[b] - typeCounts[a]; });
        if (types.length > 1 || state.type) {
          tree += '<ul class="sub">' + types.map(function (t) {
            return '<li><button type="button" class="' + (state.type === t ? "on" : "") + '" data-tcat="' + esc(c.label) + '" data-ttype="' + esc(t) + '">' + esc(t) + " <small>" + typeCounts[t] + "</small></button></li>";
          }).join("") + "</ul>";
        }
      }
      tree += "</li>";
    });
    tree += "</ul>";
    html += facet("cat", lineLabel(state.line), state.type || state.cat, tree);

    // 2. Rebajas
    var offerN = state.products.filter(function (p) { return matches(p, "offer") && p.offer; }).length;
    if (offerN || state.onlyOffers) {
      html += '<div class="facet"><button type="button" class="toggle-row" id="tOffers" aria-pressed="' + state.onlyOffers + '"><span>Solo rebajas <small>' + offerN + '</small></span><span class="switch"></span></button></div>';
    }

    // 3. Talla: solo las que existen en lo que se está viendo, agrupadas por sistema
    var sizeCounts = countBy("size", function (p) { return p._sizeCodes; });
    var codes = Object.keys(sizeCounts);
    state.sizes.forEach(function (s) { if (codes.indexOf(s) < 0) codes.push(s); });
    codes.sort(sortSizes);
    if (codes.length) {
      var groups = [], gmap = {};
      codes.forEach(function (c) {
        var g = sizeInfo(c).group;
        if (!gmap[g]) { gmap[g] = []; groups.push(g); }
        gmap[g].push(c);
      });
      var sizesHtml = groups.map(function (g) {
        return '<div class="size-group">' + (groups.length > 1 ? "<p>" + esc(g) + "</p>" : "") + '<div class="size-grid">' +
          gmap[g].map(function (c) {
            var on = state.sizes.indexOf(c) >= 0;
            return '<button type="button" class="size-btn' + (on ? " on" : "") + '" data-size="' + esc(c) + '" aria-pressed="' + on + '" title="' + (sizeCounts[c] || 0) + ' prendas">' +
              esc(sizeInfo(c).label) + "</button>";
          }).join("") + "</div></div>";
      }).join("");
      html += facet("size", "Talla", state.sizes.map(function (c) { return sizeInfo(c).label; }).join(", "), sizesHtml);
    }

    // 4. Color
    var colorCounts = countBy("color", function (p) { return p._color; });
    var colors = Object.keys(colorCounts);
    state.colors.forEach(function (c) { if (colors.indexOf(c) < 0) colors.push(c); });
    colors.sort(function (a, b) { return (colorCounts[b] || 0) - (colorCounts[a] || 0); });
    if (colors.length) {
      html += facet("color", "Color", state.colors.join(", "), '<div class="color-grid">' + colors.map(function (c) {
        var on = state.colors.indexOf(c) >= 0;
        return '<button type="button" class="color-btn' + (on ? " on" : "") + '" data-color="' + esc(c) + '" aria-pressed="' + on + '">' +
          '<span class="sw" style="background:' + swatch(c) + '"></span>' + esc(c) + " <small>" + (colorCounts[c] || 0) + "</small></button>";
      }).join("") + "</div>");
    }

    // 5. Precio
    var priceCounts = countBy("price", function (p) { return p._bucket; });
    html += facet("price", "Precio", PRICE_BUCKETS.filter(function (b) { return state.prices.indexOf(b.k) >= 0; }).map(function (b) { return b.label; }).join(", "),
      '<div class="opt-list">' + PRICE_BUCKETS.map(function (b) {
        var n = priceCounts[b.k] || 0, on = state.prices.indexOf(b.k) >= 0;
        if (!n && !on) return "";
        return '<button type="button" class="opt' + (on ? " on" : "") + '" data-price="' + b.k + '" aria-pressed="' + on + '"><span class="box">' + icon("i-check") + "</span>" + esc(b.label) + " <small>" + n + "</small></button>";
      }).join("") + "</div>");

    body.innerHTML = html;
    body.scrollTop = keep;

    var nf = state.sizes.length + state.colors.length + state.prices.length + (state.onlyOffers ? 1 : 0);
    $("filterBadge").hidden = !nf;
    $("filterBadge").textContent = nf;
    $("applyFilters").textContent = "Ver " + plural(state.filtered.length, "prenda");
  }
  $("filtersBody").addEventListener("toggle", function (e) {
    var d = e.target.closest("[data-facet]"); if (d) state.openFacets[d.getAttribute("data-facet")] = d.open;
  }, true);
  function toggleIn(arr, v) { var i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); return i < 0; }
  $("filtersBody").addEventListener("click", function (e) {
    var b;
    if ((b = e.target.closest("[data-tcat]"))) {
      var c = b.getAttribute("data-tcat"), t = b.getAttribute("data-ttype") || "";
      if (!t && c === state.cat && !state.type) c = ""; // segundo toque en la categoría = volver a "Todo"
      setCat(c, t);
    } else if ((b = e.target.closest("[data-size]"))) {
      if (toggleIn(state.sizes, b.getAttribute("data-size"))) track("select_content", { content_type: "talla", item_id: b.getAttribute("data-size") });
    } else if ((b = e.target.closest("[data-color]"))) {
      if (toggleIn(state.colors, b.getAttribute("data-color"))) track("select_content", { content_type: "color", item_id: b.getAttribute("data-color") });
    } else if ((b = e.target.closest("[data-price]"))) {
      toggleIn(state.prices, b.getAttribute("data-price"));
    } else if ((b = e.target.closest("#tOffers"))) {
      state.onlyOffers = !state.onlyOffers;
      if (!state.onlyOffers && VIEWS[state.view].sale) state.view = "new";
    } else return;
    refresh(false);
    if (isDesktop()) goResults();
  });

  // Chips de filtros aplicados, quitables uno a uno.
  function renderApplied() {
    var a = [];
    state.sizes.forEach(function (s) { a.push(["size", s, "Talla " + sizeInfo(s).label]); });
    state.colors.forEach(function (c) { a.push(["color", c, c]); });
    state.prices.forEach(function (k) { a.push(["price", k, PRICE_BUCKETS.filter(function (b) { return b.k === k; })[0].label]); });
    if (state.onlyOffers) a.push(["offer", "", "Solo rebajas"]);
    if (state.q) a.push(["q", "", '"' + state.q + '"']);
    $("applied").innerHTML = a.map(function (x) {
      return '<button type="button" data-rm="' + x[0] + '" data-v="' + esc(x[1]) + '">' + esc(x[2]) + icon("i-x") + "</button>";
    }).join("") + (a.length > 1 ? '<button type="button" class="clear-all" data-rm="all">Limpiar todo</button>' : "");
  }
  $("applied").addEventListener("click", function (e) {
    var b = e.target.closest("[data-rm]"); if (!b) return;
    var k = b.getAttribute("data-rm"), v = b.getAttribute("data-v");
    if (k === "all") clearFilters();
    else if (k === "size") toggleIn(state.sizes, v);
    else if (k === "color") toggleIn(state.colors, v);
    else if (k === "price") toggleIn(state.prices, v);
    else if (k === "offer") { state.onlyOffers = false; if (VIEWS[state.view].sale) state.view = "new"; }
    else if (k === "q") setQuery("");
    refresh(false);
  });
  function clearFilters() {
    state.sizes = []; state.colors = []; state.prices = []; state.onlyOffers = false;
    if (VIEWS[state.view].sale) state.view = "new";
    setQuery("");
  }
  $("clearFilters").addEventListener("click", function () { clearFilters(); setCat("", ""); refresh(true); });
  $("clearAllMobile").addEventListener("click", function () { clearFilters(); refresh(false); });

  function renderEmptyHint() {
    // Si lo que busca está en otra línea, decirlo en vez de dejarla en un callejón sin salida.
    var other = {};
    if (state.q) state.products.forEach(function (p) {
      if (p.line !== state.line && words().every(function (w) { return p._search.indexOf(w) >= 0; })) other[p.line] = (other[p.line] || 0) + 1;
    });
    var ks = Object.keys(other);
    $("emptyHint").innerHTML = ks.length
      ? "Pero encontramos: " + ks.map(function (l) { return '<button type="button" class="link-btn" data-goline="' + esc(l) + '">' + plural(other[l], "prenda") + " en " + esc(lineLabel(l)) + "</button>"; }).join(" ")
      : "Prueba quitando algún filtro o escríbenos: te decimos qué tenemos.";
  }
  $("emptyHint").addEventListener("click", function (e) {
    var b = e.target.closest("[data-goline]"); if (!b) return;
    var q = state.q; setLine(b.getAttribute("data-goline")); setQuery(q); refresh(true);
  });

  // Panel de filtros en móvil
  $("openFilters").addEventListener("click", function () { openOv("filters"); });
  $("closeFilters").addEventListener("click", function () { closeOv("filters"); });
  $("applyFilters").addEventListener("click", function () { closeOv("filters"); setTimeout(goResults, 50); });
  window.matchMedia("(min-width: 1024px)").addEventListener("change", function (m) { if (m.matches && stack.indexOf("filters") >= 0) closeOv("filters"); });

  // ---------------------------------------------------------------- menú móvil
  var menuOpenCat = null;
  function renderMenuTree() {
    var tree = treeOf(state.line);
    var sale = state.products.filter(function (p) { return p.line === state.line && p.offer; }).length;
    var html = '<div class="quick"><button type="button" class="chip" data-mview="new">' + icon("i-spark") + " Novedades</button>" +
      (sale ? '<button type="button" class="chip" data-mview="pct">% Rebajas <small>' + sale + "</small></button>" : "") + "</div>";
    html += '<ul class="tree">' + tree.map(function (c) {
      var open = menuOpenCat === c.label;
      var types = Object.keys(c.types).sort(function (a, b) { return c.types[b] - c.types[a]; });
      return '<li class="' + (open ? "open" : "") + '"><button type="button" data-mcat="' + esc(c.label) + '" aria-expanded="' + open + '"><span>' + esc(c.label) + " <small>" + c.n + "</small></span>" + icon("i-chev") + "</button>" +
        (open ? '<ul class="sub"><li><button type="button" data-mgo="' + esc(c.label) + '|"><b>Ver todo ' + esc(c.label) + "</b> <small>" + c.n + "</small></button></li>" +
          types.map(function (t) { return '<li><button type="button" data-mgo="' + esc(c.label) + "|" + esc(t) + '">' + esc(t) + " <small>" + c.types[t] + "</small></button></li>"; }).join("") + "</ul>" : "") +
        "</li>";
    }).join("") + "</ul>";
    $("menuTree").innerHTML = html;
  }
  $("openMenu").addEventListener("click", function () { menuOpenCat = state.cat || null; renderMenuTree(); openOv("menuDrawer"); });
  $("menuTree").addEventListener("click", function (e) {
    var b;
    if ((b = e.target.closest("[data-mcat]"))) {
      var c = b.getAttribute("data-mcat");
      menuOpenCat = menuOpenCat === c ? null : c;
      renderMenuTree();
      return;
    }
    if ((b = e.target.closest("[data-mgo]"))) {
      var parts = b.getAttribute("data-mgo").split("|");
      setCat(parts[0], parts[1]);
    } else if ((b = e.target.closest("[data-mview]"))) {
      setCat("", ""); state.view = b.getAttribute("data-mview");
    } else return;
    closeOv("menuDrawer");
    refresh(false);
    setTimeout(goResults, 80);
  });

  // ---------------------------------------------------------------- búsqueda
  var qTimer, gaQTimer;
  function setQuery(v) { state.q = v; $("qMobile").value = v; $("qDesktop").value = v; }
  function onSearch(e) {
    var v = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(function () {
      var was = state.q;
      setQuery(v.trim());
      if (state.q && !was) setCat("", ""); // buscar es buscar en toda la línea
      refresh(false);
    }, 200);
    clearTimeout(gaQTimer);
    gaQTimer = setTimeout(function () {
      var term = v.trim();
      if (term.length >= 3) track("search", { search_term: term.slice(0, 60), results: state.filtered.length });
    }, 1500);
  }
  $("qMobile").addEventListener("input", onSearch);
  $("qDesktop").addEventListener("input", onSearch);
  [$("qMobile"), $("qDesktop")].forEach(function (i) {
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") { i.blur(); goResults(); } });
  });
  $("openSearch").addEventListener("click", function () {
    var box = $("searchMobile"), open = box.hidden;
    box.hidden = !open;
    this.setAttribute("aria-expanded", open);
    if (open) $("qMobile").focus();
  });
  $("brandLink").addEventListener("click", function (e) {
    e.preventDefault();
    clearFilters(); setCat("", "");
    state.view = state.products.some(function (p) { return p._timed; }) ? "promo" : "new";
    refresh(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // ---------------------------------------------------------------- tarjetas
  function imgTag(p) {
    if (!p.image) return '<div class="ph">' + esc((p.type || "?").charAt(0)) + "</div>";
    return '<img src="' + esc(p.image) + '" alt="' + esc(p.name) + '" data-ph="' + esc((p.type || "?").charAt(0)) +
      '" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
  }
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (img.tagName !== "IMG" || !img.hasAttribute("data-ph")) return;
    var ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = img.getAttribute("data-ph");
    img.replaceWith(ph);
  }, true);

  function timeLeft(ts) {
    var h = Math.floor((ts - Date.now()) / 36e5);
    return h >= 48 ? Math.floor(h / 24) + " días" : h >= 1 ? h + " h" : "minutos";
  }
  function tagsHtml(p) {
    var t = "";
    if (p.offer) {
      // En la vista "Mayor ahorro $" la etiqueta habla en pesos; en las demás, en porcentaje.
      if (state.view === "save" && p._save) t += '<span class="tag tag-sale">Ahorras ' + money(p._save) + "</span>";
      else if (p._pct >= 5) t += '<span class="tag tag-sale">-' + p._pct + "%</span>";
      if (p.offer === "clearance") t += '<span class="tag tag-sale">Rebaja</span>';
    }
    if (p._timed) t += '<span class="tag tag-timer">Termina en ' + timeLeft(p._timed) + "</span>";
    else if (p.is_new) t += '<span class="tag tag-new">Nuevo</span>';
    return t;
  }
  function priceHtml(p, big) {
    return '<div class="price' + (p.offer ? " offer" : "") + '"><span class="now">' + money(p.price) + "</span>" +
      (p.regular_price ? "<s>" + money(p.regular_price) + "</s>" : "") +
      (big && p._save ? '<span class="save">Ahorras ' + money(p._save) + (p._pct >= 5 ? " (-" + p._pct + "%)" : "") + "</span>" : "") + "</div>";
  }
  function sizesText(p) {
    var l = p._sizeCodes.map(function (c) { return sizeInfo(c).label; });
    return l.length > 4 ? l.slice(0, 4).join(" · ") + " +" + (l.length - 4) : l.join(" · ");
  }
  function card(p, compact) {
    return '<button type="button" class="card" data-code="' + esc(p.code) + '">' +
      '<div class="card-media">' + imgTag(p) + '<div class="tags">' + tagsHtml(p) + "</div></div>" +
      '<div class="card-body">' +
      '<p class="card-name" title="' + esc(p.name) + '">' + esc(p.name) + "</p>" +
      priceHtml(p) +
      (compact ? "" : '<span class="card-meta">Cód. ' + esc(p.code) + (p._sizeCodes.length ? " · " + esc(sizesText(p)) : "") + "</span>") +
      "</div></button>";
  }
  function more() {
    var next = state.filtered.slice(state.shown, state.shown + PAGE);
    if (!next.length) return;
    $("grid").insertAdjacentHTML("beforeend", next.map(function (p) { return card(p); }).join(""));
    state.shown += next.length;
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (e) { if (e[0].isIntersecting && state.data) more(); }, { rootMargin: "900px" }).observe($("sentinel"));
  }
  document.addEventListener("click", function (e) {
    var c = e.target.closest(".card"); if (!c) return;
    openProduct(c.getAttribute("data-code"));
  });

  // ---------------------------------------------------------------- ficha
  function findByCode(code) {
    for (var i = 0; i < state.products.length; i++) if (state.products[i].code === code) return state.products[i];
    return null;
  }
  function openProduct(code, fromHash) {
    var p = findByCode(code);
    if (!p) { if (fromHash) toast("Esa prenda ya no está disponible. Mira lo que sigue en tienda."); return; }
    state.current = p;
    state.currentSize = p.sizes.length === 1 ? p.sizes[0].code : null;

    var img = $("pImg");
    img.src = p.image_full || p.image || "";
    img.alt = p.name;
    img.hidden = !(p.image_full || p.image);
    $("pCrumb").textContent = [lineLabel(p.line), p._catLabel, p.type].filter(Boolean).join(" · ");
    $("pTitle").textContent = p.name;
    $("pPrice").innerHTML = priceHtml(p, true);
    if (p._timed) {
      $("pEnds").hidden = false;
      $("pEnds").textContent = "Precio especial hasta el " + new Date(p._timed).toLocaleString("es-MX", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
    } else $("pEnds").hidden = true;
    $("pUnique").hidden = p.stock !== 1;
    var facts = [["Código", p.code]];
    if (p._color) facts.push(["Color", p._color]);
    if (p.arrived_at) facts.push(["Llegó", new Date(p.arrived_at + "T12:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "long" })]);
    $("pFacts").innerHTML = facts.map(function (f) { return "<dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd>"; }).join("");
    $("pDesc").hidden = !p.description;
    $("pDesc").textContent = p.description || "";
    renderSizes();

    // "También te puede gustar": mismo tipo (o categoría) y línea, lo más nuevo.
    var sim = state.products.filter(function (x) { return x !== p && x.line === p.line && x.type === p.type && x.image; });
    if (sim.length < 4) sim = sim.concat(state.products.filter(function (x) { return x !== p && x.line === p.line && x._catLabel === p._catLabel && x.type !== p.type && x.image; }));
    sim = sim.sort(function (a, b) { return a._arr < b._arr ? 1 : -1; }).slice(0, 10);
    $("pSimilar").innerHTML = sim.map(function (x) { return card(x, true); }).join("");
    $("pSimilarWrap").hidden = !sim.length;

    var url = location.pathname + location.search + "#p=" + encodeURIComponent(p.code);
    if (stack.indexOf("productSheet") >= 0) {
      history.replaceState({ ov: "productSheet" }, "", url);
      $("productSheet").querySelector(".sheet-in").scrollTop = 0;
    } else openOv("productSheet", url);
    track("view_item", { currency: "MXN", value: p.price, items: [gaItem(p)], from_link: !!fromHash });
  }

  function renderSizes() {
    var p = state.current;
    var codes = p.sizes.slice().sort(function (a, b) { return sortSizes(a.code, b.code); });
    $("pSizes").innerHTML = codes.map(function (s) {
      return '<button type="button" class="size-opt" role="radio" aria-checked="' + (state.currentSize === s.code) +
        '" data-size="' + esc(s.code) + '" title="' + esc(s.name) + '">' + esc(sizeInfo(s.code).label) + "</button>";
      // Sin "última" por talla: en una boutique casi todo es de una pieza y salía en todas.
    }).join("");
    $("pSizeHint").textContent = state.currentSize ? "· " + sizeInfo(state.currentSize).label : "· elige una";
    updateProductWa();
  }
  $("pSizes").addEventListener("click", function (e) {
    var b = e.target.closest(".size-opt"); if (!b) return;
    state.currentSize = b.getAttribute("data-size");
    renderSizes();
  });

  function itemLine(p, size) {
    return "• " + p.name.slice(0, 70) + " — Código " + p.code + (size ? ", talla " + sizeInfo(size).label : "") + " — " + money(p.price);
  }
  function updateProductWa() {
    var p = state.current;
    var link = waLink("¡Hola! Me interesa esta prenda:\n" + itemLine(p, state.currentSize) +
      (state.currentSize ? "\n¿Sigue disponible?" : "\n¿Qué tallas tienen?") + "\n" + pageUrl(p.code));
    var a = $("pWa");
    if (link) { a.href = link; a.hidden = false; } else a.hidden = true;
  }

  $("pAdd").addEventListener("click", function () {
    var p = state.current;
    if (!state.currentSize && p.sizes.length > 1) {
      toast("Elige tu talla");
      if ($("pSizes").animate) $("pSizes").animate([{ transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "none" }], 200);
      return;
    }
    var size = state.currentSize || (p.sizes[0] && p.sizes[0].code) || "";
    if (state.bag.some(function (i) { return i.code === p.code && i.size === size; })) { toast("Ya está en tu bolsa"); return; }
    state.bag.push({ code: p.code, size: size });
    saveBag(); renderBag();
    track("add_to_cart", { currency: "MXN", value: p.price, items: [gaItem(p, size)] });

    var btn = $("pAdd");
    btn.classList.add("added");
    btn.innerHTML = icon("i-check") + " ¡Agregada!";
    setTimeout(function () {
      closeOv("productSheet");
      btn.classList.remove("added");
      btn.textContent = "Agregar a mi bolsa";
      var bag = $("openBag");
      bag.classList.remove("bump"); void bag.offsetWidth; bag.classList.add("bump");
      toast("Agregada a tu bolsa · " + plural(state.bag.length, "prenda"), "Ver bolsa", function () { renderBag(); openOv("bagDrawer"); });
    }, 650);
  });

  $("pShare").addEventListener("click", function () {
    var p = state.current, url = pageUrl(p.code);
    track("share", { method: navigator.share ? "nativo" : "copiar_enlace", content_type: "prenda", item_id: p.code });
    var text = p.name + " — " + money(p.price) + (p.regular_price ? " (antes " + money(p.regular_price) + ")" : "");
    if (navigator.share) navigator.share({ title: state.data.store.name || "", text: text, url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text + "\n" + url).then(function () { toast("Enlace copiado"); });
  });

  // ---------------------------------------------------------------- bolsa
  function loadBag() { try { return JSON.parse(localStorage.getItem(BAG_KEY)) || []; } catch (e) { return []; } }
  function saveBag() { try { localStorage.setItem(BAG_KEY, JSON.stringify(state.bag)); } catch (e) { /* modo privado */ } }

  function renderBag() {
    if (!state.data) return;
    var items = state.bag.map(function (i) { return { i: i, p: findByCode(i.code) }; }).filter(function (x) { return x.p; });
    if (items.length !== state.bag.length) { state.bag = items.map(function (x) { return x.i; }); saveBag(); }
    var n = items.length;
    $("bagCount").hidden = n === 0;
    $("bagCount").textContent = n;
    $("bagClear").hidden = n === 0;
    $("bagItems").innerHTML = n ? items.map(function (x, idx) {
      return '<div class="bag-item">' + imgTag(x.p) +
        '<div><p class="bi-name" title="' + esc(x.p.name) + '">' + esc(x.p.name) + "</p>" +
        '<p class="bi-meta">Código ' + esc(x.p.code) + (x.i.size ? " · Talla " + esc(sizeInfo(x.i.size).label) : "") + "</p>" +
        '<p class="bi-price">' + money(x.p.price) + "</p></div>" +
        '<button type="button" class="bag-remove" data-idx="' + idx + '" aria-label="Quitar ' + esc(x.p.name) + '">' + icon("i-trash") + "<span>Quitar</span></button></div>";
    }).join("") : '<p class="bag-empty">Tu bolsa está vacía.<br>Toca una prenda para agregarla.</p>';
    var total = items.reduce(function (s, x) { return s + x.p.price; }, 0);
    $("bagTotal").textContent = money(total);
    var a = $("bagSend");
    if (!n) { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); a.style.opacity = ".5"; return; }
    var link = waLink("¡Hola! Quiero apartar estas prendas:\n" + items.map(function (x) { return itemLine(x.p, x.i.size); }).join("\n") +
      "\n\nTotal: " + money(total) + "\nLas recojo en tienda.");
    if (link) { a.href = link; a.removeAttribute("aria-disabled"); a.style.opacity = ""; }
  }
  $("bagItems").addEventListener("click", function (e) {
    var b = e.target.closest(".bag-remove"); if (!b) return;
    var row = b.closest(".bag-item"), idx = +b.getAttribute("data-idx");
    var q = state.bag[idx] && findByCode(state.bag[idx].code);
    if (q) track("remove_from_cart", { currency: "MXN", value: q.price, items: [gaItem(q, state.bag[idx].size)] });
    row.classList.add("leaving");
    setTimeout(function () { state.bag.splice(idx, 1); saveBag(); renderBag(); }, 220);
  });
  $("bagClear").addEventListener("click", function () {
    if (!confirm("¿Quitar todas las prendas de tu bolsa?")) return;
    state.bag = []; saveBag(); renderBag(); toast("Bolsa vacía");
  });
  $("openBag").addEventListener("click", function () { renderBag(); openOv("bagDrawer"); });

  // ---------------------------------------------------------------- contacto (lo que más importa medir)
  $("bagSend").addEventListener("click", function () {
    if (!this.getAttribute("href")) return;
    var items = state.bag.map(function (i) { var p = findByCode(i.code); return p ? gaItem(p, i.size) : null; }).filter(Boolean);
    track("generate_lead", { currency: "MXN", value: items.reduce(function (s, it) { return s + it.price; }, 0), lead_source: "bolsa", items: items });
  });
  $("pWa").addEventListener("click", function () {
    var p = state.current; if (!p) return;
    track("generate_lead", { currency: "MXN", value: p.price, lead_source: "prenda", items: [gaItem(p, state.currentSize)] });
  });
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-wa-general]");
    if (a) track("contact", { method: "whatsapp", location: a.classList.contains("fab") ? "flotante" : (a.closest(".header") ? "barra" : a.closest(".drawer") ? "menu" : "pie") });
    var s = e.target.closest("#socials a, #mapsLink");
    if (s) track("click_social", { network: s.id === "mapsLink" ? "maps" : s.getAttribute("aria-label") });
  });
})();
