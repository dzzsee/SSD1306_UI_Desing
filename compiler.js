/* S13 — compilador: convierte el diseño del editor en un blob binario
   que el firmware intérprete ejecuta. También genera el .ino exportable. */

const TIPO = {
  PIXEL: 1, LINE: 2, RECT: 3, TEXT: 4,
  DISC: 5, BATTERY: 6, WXICON: 7, BITMAP: 8
};

const S13_LIMITES = { MAX_BLOB: 2048 };

function u16(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }

function compilarDiseno(state) {
  const partes = [];
  let n = 0;

  // cabecera provisional (8 bytes): "S13U", versión, nº elementos, reserva
  const cabecera = [0x53, 0x31, 0x33, 0x55, 0x01, 0x00, 0x00, 0x00];
  partes.push(cabecera);

  const emitir = (tipo, payload) => {
    partes.push([tipo, payload.length, ...payload]);
    n++;
  };

  // capa de raster (pincel libre) como un único BITMAP con su bounding box
  const bb = cajaRaster(state);
  if (bb) {
    const [x0, y0, w, h] = bb;
    const filas = Math.ceil(w / 8);
    const datos = new Array(filas * h).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (state.bitmap[(y0 + y) * 128 + (x0 + x)]) {
          datos[y * filas + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    emitir(TIPO.BITMAP, [x0, y0, w, h, ...datos]);
  }

  for (const el of state.elementos) {
    switch (el.type) {
      case 'line':    emitir(TIPO.LINE,    [el.x0, el.y0, el.x1, el.y1]); break;
      case 'rect':    emitir(TIPO.RECT,    [el.x, el.y, el.w, el.h, el.fill ? 1 : 0]); break;
      case 'disc':    emitir(TIPO.DISC,    [el.x, el.y, el.r, el.fill ? 1 : 0]); break;
      case 'text': {
        const bytes = [...new TextEncoder().encode(el.text)];
        emitir(TIPO.TEXT, [el.x, el.y, el.font, bytes.length, ...bytes]);
        break;
      }
      case 'battery': emitir(TIPO.BATTERY, [el.x, el.y, el.w, el.h]); break;
      case 'wxicon':  emitir(TIPO.WXICON,  [el.x, el.y, el.s]); break;
    }
  }

  cabecera[5] = (n >> 8) & 0xFF;
  cabecera[6] = n & 0xFF;
  return new Uint8Array(partes.flat());
}

function cajaRaster(state) {
  let x0 = 128, y0 = 64, x1 = -1, y1 = -1;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      if (state.bitmap[y * 128 + x]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

function blobAHex(blob, maxBytes = 512) {
  const n = Math.min(blob.length, maxBytes);
  const lineas = [];
  for (let i = 0; i < n; i += 16) {
    const trozo = [...blob.slice(i, i + 16)]
      .map(b => b.toString(16).padStart(2, '0'));
    const dir = i.toString(16).padStart(4, '0');
    lineas.push(dir + '  ' + trozo.join(' '));
  }
  if (blob.length > maxBytes) lineas.push('...  (' + (blob.length - maxBytes) + ' bytes más)');
  return lineas.join('\n');
}

/* ---------- configuración del dispositivo ---------- */

function jsonEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function compilarConfig(cfg) {
  return '{"ssid":"' + jsonEscape(cfg.ssid) + '","pass":"' + jsonEscape(cfg.pass) +
    '","lat":' + Number(cfg.lat) + ',"lon":' + Number(cfg.lon) +
    ',"vmin":' + Number(cfg.vmin) + ',"vmax":' + Number(cfg.vmax) +
    ',"vdiv":' + Number(cfg.vdiv) + ',"pin":' + Number(cfg.pin) +
    ',"tz":' + Number(cfg.tz) + '}';
}

/* ---------- exportación .ino ---------- */

async function generarIno(blob, cfgJson) {
  const resp = await fetch('./firmware/s13_interprete.ino');
  if (!resp.ok) throw new Error('No se encontró firmware/s13_interprete.ino');
  const tpl = await resp.text();
  const arr = [...blob].map(b => '0x' + b.toString(16).padStart(2, '0')).join(',');
  const inject =
    `// Datos generados por SSD1306 Studio\n` +
    `const uint8_t EMBEDDED_BLOB[] = {${arr}};\n` +
    `const unsigned EMBEDDED_LEN = ${blob.length};\n` +
    `const char EMBEDDED_CFG[] = "${jsonEscape(cfgJson)}";`;
  return tpl.replace('//__CONFIG__', inject);
}
