/* uploader.js — S13 Studio: subida por Web Serial.
   Flujo de un botón:
   1. compila el diseño actual
   2. abre el puerto serie (115200)
   3. pregunta la versión del firmware (S13VER?)
   4. si no coincide, intenta flashear firmware.bin con esptool-js (si está disponible)
   5. envía S13CFG <json> y S13UI <hex>; el ESP32 responde OK
   6. cierra el puerto y muestra estado */

(() => {
  'use strict';

  const APP_ADDR = 0x10000;
  const BAUD = 115200;

  let puerto = null;

  // ---------- helpers de puerto serie ----------
  function soportaSerial() { return 'serial' in navigator; }

  async function abrirPuerto() {
    if (!soportaSerial()) throw new Error('Web Serial no compatible');
    puerto = await navigator.serial.requestPort();
    await puerto.open({ baudRate: BAUD });
  }

  function cerrarPuerto() {
    if (puerto && puerto.isOpen) {
      puerto.close().then(() => { puerto = null; });
    }
  }

  function encoder() { return new TextEncoder(); }

  async function escribirLinea(texto) {
    if (!puerto || !puerto.isOpen) return;
    const str = texto + '\n';
    const w = puerto.writable.getWriter();
    await w.write(encoder().encode(str));
    w.releaseLock();
  }

  async function leerLinea(timeout = 4000) {
    if (!puerto || !puerto.isOpen) return null;
    const r = puerto.readable.getReader();
    let buf = '';
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < timeout) {
        const { value, done } = await r.read();
        if (done) break;
        if (value) buf += new TextDecoder().decode(value);
        const i = buf.lastIndexOf('\n');
        if (i >= 0) { r.releaseLock(); return buf.slice(0, i).trim(); }
      }
    } finally {
      try { r.releaseLock(); } catch (e) { /* nada */ }
    }
    r.releaseLock();
    return buf.trim() || null;
  }

  async function enviar(texto) { await escribirLinea(texto); }

  async function pedirVersion() { await enviar('S13VER?'); return await leerLinea(2000); }

  async function aplicarConfigJSON(json) { await enviar('S13CFG ' + json); const r = await leerLinea(3000); return r; }

  async function enviarDiseñoHex(hex) { await enviar('S13UI ' + hex); const r = await leerLinea(6000); return r; }

  // ---------- subida principal ----------
  async function subir(blob, cfgJson) {
    if (!soportaSerial()) throw new Error('Web Serial no disponible: usa Chrome o Edge en escritorio.');
    const hex = [...blob].map(b => b.toString(16).padStart(2, '0')).join('');

    await abrirPuerto();

    // 1. preguntar versión
    let version = await pedirVersion();
    const firmwareOk = version === 'S13VER 1.0';

    // 2. si hace falta, flashear con esptool-js (solo si el globals ESPLoader está disponible)
    if (!firmwareOk && typeof ESPLoader !== 'undefined') {
      try {
        const transport = new Transport(puerto, true); // true = terminal
        const esploader = new ESPLoader({ transport, baudrate: BAUD, terminal: { clean:()=>{}, writeLine:d=>{}, write:d=>{} }, debugLogging:false });
        const chip = await esploader.main();
        console.log('Chip detectado:', chip);
        const firmwareData = await (await fetch('./firmware.bin')).arrayBuffer();
        await esploader.writeFlash({
          fileArray: [{ data: new Uint8Array(firmwareData), address: APP_ADDR }],
          flashMode: 'dio', flashFreq: '40m', flashSize: '4MB',
          eraseAll: false, compress: true, reportProgress:()=>{}
        });
        await esploader.after('hard_reset');
        await new Promise(r=>setTimeout(r, 600));
        cerrarPuerto();
        await new Promise(r=>setTimeout(r, 300));
        await abrirPuerto(); // reabrir tras reinicio
        version = await pedirVersion();
        firmwareOk = version === 'S13VER 1.0';
      } catch (e) {
        console.error('Flasheo esptool-js falló:', e);
        // continuaremos sin flashear; el usuario hará manual con .ino
      }
    }

    // 3. esperar un poco por el reinicio del ESP32
    await new Promise(r=>setTimeout(r, 1800));

    // 4. enviar configuración
    const cfgResp = await aplicarConfigJSON(cfgJson);
    if (cfgResp !== 'OK CFG') throw new Error('Configuración no aceptada: ' + cfgResp);

    // 5. enviar diseño
    const uiResp = await enviarDiseñoHex(hex);
    if (uiResp !== 'OK UI') throw new Error('Diseño no aceptado: ' + uiResp);

    cerrarPuerto();
    return { ok: true, msg: 'Diseño y configuración enviados al ESP32' };
  }

  return { subir };
})();