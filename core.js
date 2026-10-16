/* Barcode tag checking logic: shared by the web page (and testable in Node). */
(function (root) {
  // ---- The stored logic: which Excel column feeds which part of the tag ----
  const FIELD_MAP = {
    "Division": "DIVISION",
    "Product": "DEPARTMENT",
    "Brand": "BRAND",
    "To Fit Size": "CAT5",
    "Color": "CAT6",
    "S-Code": "CAT3-S.CODE",
    "D-Code": "UDF9-D.CODE",
  };
  const BARCODE_COL = "ICODE", MRP_COL = "MRP", PROMO_COL = "PROMO", QTY_COL = "PO QTY", SIZE_COL = "CAT5";
  const EXPECTED_FORMAT = "Code128";
  const STATIC_TEXT = [
    "Marketed By:",
    "RGs Fashions Private Limited",
    "(Incl. of all taxes)",
    "customercare@citistyle.in",
    "+91-9874246631",
  ];
  // Tag geometry relative to the barcode top-left, in pixels at a 565px-wide barcode
  const REF_W = 565;
  const TAG_BOX = [-60, -950, 710, 700];
  const HEADER_BOX = [150, -880, 720, -720];
  const QTY_BOX = [-150, 790, 710, 1060];
  const MRP_BOX = [-30, -150, 560, -20];

  const norm = (s) => (s == null ? "" : String(s)).replace(/\s+/g, "").replace(/\.00\b/g, "").replace(/[-.]/g, "").toUpperCase();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const field = (text, label) => {
    // OCR sometimes reads the colon as another symbol or a lone 1 / I
    const m = text.match(new RegExp(esc(label) + "\\s*(?:[^A-Za-z0-9\\s]|[1Il](?=\\s))?\\s*(.+)"));
    return m ? m[1].trim() : null;
  };

  // Levenshtein distance
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Short phrases must match exactly (so "Mareted" is caught); long ones tolerate one OCR slip
  function containsText(hay, needle) {
    const h = norm(hay), n = norm(needle);
    if (h.includes(n)) return true;
    if (n.length < 18) return false;
    for (let i = 0; i + n.length - 1 <= h.length; i++)
      for (const L of [n.length - 1, n.length, n.length + 1])
        if (lev(h.substr(i, L), n) <= 1) return true;
    return false;
  }

  function parseExcel(rows) {
    const map = new Map();
    let total = 0;
    for (const raw of rows) {
      const r = {};
      for (const k of Object.keys(raw)) r[k.trim()] = typeof raw[k] === "string" ? raw[k].trim() : raw[k];
      if (!r[BARCODE_COL]) continue;
      map.set(String(r[BARCODE_COL]).trim(), r);
      total += Number(r[QTY_COL]) || 0;
    }
    return { map, total };
  }

  // barcodes: [{text, format, x, y, width}]
  // crop(box, threshold, upscale) -> image; ocr(image, psm, whitelist) -> text
  // pageText(box) -> text from the PDF text layer inside box, or null for images
  async function checkPage({ pageNo, barcodes, crop, ocr, pageText, excel, onProgress }) {
    const errors = [], seen = [];
    let i = 0;
    for (const b of barcodes) {
      i++;
      const code = b.text.trim();
      const tag = `Page ${pageNo} / ${code}`;
      const s = b.width / REF_W;
      const box = (bx) => bx.map((v, j) => Math.round((j % 2 === 0 ? b.x : b.y) + v * s));
      seen.push(code);
      if (onProgress) onProgress(`Page ${pageNo}: reading tag ${i} of ${barcodes.length} (${code})`);

      if (b.format.replace(/[\s-]/g, "") !== EXPECTED_FORMAT)
        errors.push([tag, "Barcode type", EXPECTED_FORMAT, b.format]);
      const row = excel.map.get(code);
      if (!row) { errors.push([tag, "Barcode", "an ICODE from the Excel", code]); continue; }

      const text = await ocr(await crop(box(TAG_BOX), false), "6");
      for (const [label, col] of Object.entries(FIELD_MAP)) {
        const got = field(text, label);
        if (norm(got) !== norm(row[col])) errors.push([tag, label, row[col], got ?? "not found"]);
      }
      const hdr = (await ocr(await crop(box(HEADER_BOX), true), "7")).trim();
      if (norm(hdr) !== norm(row[SIZE_COL])) errors.push([tag, "Size in header band", row[SIZE_COL], hdr || "not found"]);
      if (!text.replace(/\s/g, "").includes(code)) errors.push([tag, "Number printed under barcode", code, "not matching"]);
      const mrpRe = /MRP\W*R\s*[s5]\W*([\d,]+(?:\.\d+)?)/i;
      let m = text.match(mrpRe);
      if (!m) m = (await ocr(await crop(box(MRP_BOX), false), "7")).match(mrpRe);
      if (!m || parseFloat(m[1].replace(/,/g, "")) !== Number(row[MRP_COL]))
        errors.push([tag, "MRP", row[MRP_COL], m ? m[1] : "not found"]);
      if (row[PROMO_COL] && !norm(text).includes(norm(row[PROMO_COL])))
        errors.push([tag, "Promo word", row[PROMO_COL], "not found"]);
      for (const st of STATIC_TEXT)
        if (!containsText(text, st)) errors.push([tag, "Fixed text", st, "missing or misspelt"]);
      let q = pageText ? (pageText(box(QTY_BOX)) || "").match(/(\d+)\s*PCS/i) : null;
      if (!q) q = (await ocr(await crop(box(QTY_BOX), true, 2), "7", "0123456789PCS ")).match(/(\d+)\s*PCS/i);
      if (q && Number(q[1]) !== Number(row[QTY_COL])) errors.push([tag, "Quantity (PCS)", row[QTY_COL], q[1]]);
      if (!q) errors.push([tag, "Quantity (PCS)", row[QTY_COL], "not found under tag"]);
    }
    return { errors, seen };
  }

  function finalize(excel, seen, errors) {
    for (const code of excel.map.keys())
      if (!seen.includes(code)) errors.push(["—", "Missing tag", code, "not in artwork"]);
    for (const code of new Set(seen.filter((c, i) => seen.indexOf(c) !== i)))
      errors.push(["—", "Duplicate tag", "once", `${code} × ${seen.filter((c) => c === code).length}`]);
    return errors;
  }

  const api = { FIELD_MAP, STATIC_TEXT, parseExcel, checkPage, finalize };
  if (typeof module !== "undefined") module.exports = api; else root.TagCore = api;
})(this);
