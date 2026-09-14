/* app.js — S13 Studio Editor (HTML5 + Web Serial)
   Versión: monocromo instrumento, tokens %HORA% %FECHA% %BAT% %VOL% %TEMP% %CIELO%
   Un solo acento ámbar (#FFB000) en elementos activos; el lienzo es #0A0A08 sobre papel #F0F0EC.
   Firma: Silkscreen (display) + Archivo Narrow (cuerpo); idioma español; sin ALL-CAPS eyebrows ni etiquetas.
*/

(() => {
  'use strict';

  // ---------- constantes ----------
  const SCALE = 6;                      // 128×64 → 768×384
  const W   = 128, H = 64;
  const CANVAS_W = W * SCALE;         // 768
  const CANVAS_H = H * SCALE;         // 384

  const TIPO = { PIXEL:1, LINE:2, RECT:3, TEXT:4, DISC:5, BATTERY:6, WXICON:7, BITMAP:8 };

  // ---------- inicialización DOM ----------
  const html = document.documentElement;
  const body = document.body;

  // Noticia si Web Serial no es compatible
  if (!('serial' in navigator)) {
    const aviso = document.createElement('div');
    aviso.id = 'aviso-serial';
    aviso.textContent = 'Web Serial no disponible: usa Chrome o Edge en escritorio para sub firmware.';
    aviso.style.cssText = `
      background:#FFB000; color:#0A0A08; padding:.6rem 1rem; font-family:"Archivo Narrow",sans-serif;
      margin:1rem; border-radius:2px; text-align:center; font-size:.9rem;`;
    body.insertBefore(aviso, body.firstElementChild);
  }

  // canvas y contexto
  const canvas = document.getElementById('lienzo');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const wrapper = canvas.parentElement; // .lienzo-zona

  // dimensiones reales del canvas en pantalla
  function canvasRect() { return canvas.getBoundingClientRect(); }

  // escala del canvas al tamaño de pantalla
  function ajustarCanvas() {
    const rect = canvasRect();
    const maxW = Math.min(768, window.innerWidth - 2);
    const scale = maxW / W;
    canvas.style.width = `${maxW}px`;
    canvas.style.height = `${384 * scale}px`;
    // transformar coord del diseño a px canvas
    canvas.width = W * scale;
    canvas.height = H * scale;
    ctx.scale(scale, scale);
  }
  ajustarCanvas();
  window.addEventListener('resize', ajustarCanvas);

  // ---------- estado ----------
  const state = {
    bitmap: new Uint8Array(W * H),        // raster 1bpp por píxel (1=enlace)
    elementos: [],                        // arreglo de elementos editables
    selId: null,                          // id elemento seleccionado
    tool: 'brush',                        // brush|eraser|line|rect|disc|text|select
    proximoId: 1,
    // simulación (vista previa; valores reales vienen del ESP32)
    sim: { batt: 76, temp: 21, clima: 0 }, // 0=despejado,1=nublado,2=lluvia,3=nieve,4=tormenta
    cfg: {
      ssid: '', pass: '', lat: 0, lon: 0,
      tz: -3, pin: 34, vdiv: 2, vmin: 3.3, vmax: 4.2
    }
  };

  // ---------- utilidades de dibujo ----------
  // resolver tokens dentro de cadenas de texto para vista previa
  function resolverTokens(str) {
    if (!str) return '';
    const d = new Date();
    let out = '';
    for (let i = 0; i < str.length; ) {
      if (str[i] === '%' && i + 1 < str.length) {
        if (str.substring(i, i+6) === '%HORA%') {
          out += `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
          i += 6; continue;
        }
        if (str.substring(i, i+7) === '%FECHA%') {
          out += `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}`;
          i += 7; continue;
        }
        if (str.substring(i, i+5) === '%BAT%') {
          out += `${state.sim.batt}%`;
          i += 5; continue;
        }
        if (str.substring(i, i+5) === '%VOL%') {
          const v = state.sim.vmin + (state.sim.vmax - state.sim.vmin) * state.sim.batt / 100;
          out += `${v.toFixed(2)}V`;
          i += 5; continue;
        }
        if (str.substring(i, i+6) === '%TEMP%') {
          out += `${state.sim.temp.toFixed(1)}C`;
          i += 6; continue;
        }
        if (str.substring(i, i+7) === '%CIELO%') {
          const codes = [0,'Despejado',2,'Nublado',45,'Niebla',51,'Lluvia',71,'Nieve',80,'Lluvia',85,'Nieve',95,'Tormenta'];
          const idx = codes.findIndex(c=>typeof c==='number'? false : c === state.sim.clima);
          out += (idx>=0 ? codes[idx+1] : '--');
          i += 7; continue;
        }
      }
      out += str[i];
      i++;
    }
    return out;
  }

  // ancho aproximado de texto según tipo de fuente (para layout)
  function anchoTexto(str, fuente) {
    // font1 5x7: ~6px por char, font2 7x13: ~8px, font3 10x20: ~11px
    const w = {1:6,2:8,3:11};
    return str.length * (w[fuente] || 6);
  }

  // ---------- elementos (diseño) ----------
  function nuevoElemento(tipo, x, y, datos = {}) {
    const id = state.proximoId++;
    const el = { id, type: tipo, x, y };
    // datos específicos según tipo
    if (tipo === 'line')     { el.x0 = datos.x0; el.y0 = datos.y0; el.x1 = datos.x1; el.y1 = datos.y1; }
    else if (tipo === 'rect'){ el.w = datos.w; el.h = datos.h; el.fill = datos.fill ?? false; }
    else if (tipo === 'disc'){ el.r = datos.r; el.fill = datos.fill ?? false; }
    else if (tipo === 'text'){ el.font = datos.font ?? 2; el.text = datos.text ?? ''; }
    else if (tipo === 'battery'){ el.w = datos.w; el.h = datos.h; }
    else if (tipo === 'wxicon'){ el.s = datos.s ?? 1; }
    state.elementos.push(el);
    return el;
  }

  function eliminarElemento(id) {
    state.elementos = state.elementos.filter(e => e.id !== id);
    if (state.selId === id) state.selId = null;
    render();
  }

  function getBounds(el) {
    switch (el.type) {
      case 'line':   return {x0: Math.min(el.x0,el.x1), y0: Math.min(el.y0,el.y1), x1: Math.max(el.x0,el.x1), y1: Math.max(el.y0,el.y1)};
      case 'rect':   return {x: el.x, y: el.y, x2: el.x+el.w, y2: el.y+el.h};
      case 'disc':   const r = el.r||0; return {x: el.x-r, y: el.y-r, x2: el.x+r, y2: el.y+r};
      case 'text':   return {x: el.x, y: el.y - 7, x2: el.x + anchoTexto(el.text, el.font), y2: el.y + 7};
      case 'battery':return {x: el.x, y: el.y, x2: el.x+el.w+2, y2: el.y+el.h};
      case 'wxicon': const s = el.s||1; return {x: el.x, y: el.y, x2: el.x+7*s, y2: el.y+9*s};
      default: return null;
    }
  }

  function hitTest(x, y) {
    for (let i = state.elementos.length - 1; i >= 0; i--) {
      const b = getBounds(state.elementos[i]);
      if (b && x >= b.x && x <= b.x2 && y >= b.y && y <= b.y2) return i;
    }
    // también tocar el bitmap raster
    return -1;
  }

  // ---------- renderizado ----------
  function render() {
    ctx.clearRect(0, 0, W, H);
    // grid sutil
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x++) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y <= H; y++) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    // bitmap raster (pincel)
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        if (state.bitmap[yy * W + xx]) {
          ctx.fillStyle = '#FFB000';
          ctx.fillRect(xx, yy, 1, 1);
        }
      }
    }

    // elementos en orden
    for (const el of state.elementos) {
      const sel = (el.id === state.selId);
      switch (el.type) {
        case 'line':
          ctx.strokeStyle = sel ? '#FFB000' : '#8A877D';
          ctx.lineWidth = sel ? 2 : 1;
          ctx.beginPath(); ctx.moveTo(el.x0, el.y0); ctx.lineTo(el.x1, el.y1); ctx.stroke();
          break;
        case 'rect':
          ctx.strokeStyle = sel ? '#FFB000' : '#8A877D';
          ctx.lineWidth = sel ? 2 : 1;
          ctx.beginPath(); ctx.rect(el.x, el.y, el.w, el.h); ctx.stroke();
          if (el.fill) { ctx.fillStyle = 'rgba(255,176,0,0.3)'; ctx.fill(); }
          break;
        case 'disc':
          ctx.strokeStyle = sel ? '#FFB000' : '#8A877D';
          ctx.lineWidth = sel ? 2 : 1;
          ctx.beginPath(); ctx.arc(el.x, el.y, el.r, 0, Math.PI*2); ctx.stroke();
          if (el.fill) { ctx.fillStyle = '#FFB000'; ctx.fill(); }
          break;
        case 'text':
          ctx.fillStyle = sel ? '#FFB000' : '#1B1B18';
          ctx.font = `${13* (el.font===3?2: el.font===2?1.5:1)}px "Archivo Narrow", sans-serif`; // rough sizes
          ctx.textBaseline = 'alphabetic';
          const txt = resolverTokens(el.text);
          ctx.fillText(txt, el.x, el.y);
          break;
        case 'battery':
          // contorno
          ctx.strokeStyle = '#FFB000';
          ctx.lineWidth = 1;
          ctx.strokeRect(el.x, el.y, el.w, el.h);
          // terminal
          ctx.fillStyle = '#FFB000';
          ctx.fillRect(el.x + el.w, el.y + el.h/4, 2, el.h/2);
          // relleno según sim
          if (state.sim.batt >= 0) {
            const fw = (el.w - 2) * state.sim.batt / 100;
            if (fw > 0) ctx.fillRect(el.x + 1, el.y + 1, fw, el.h - 2);
          }
          break;
        case 'wxicon':
          const s = el.s || 1;
          // sol simple
          ctx.fillStyle = '#FFB000';
          ctx.beginPath(); ctx.arc(el.x + 2*s, el.y + 2*s, 2*s, 0, Math.PI*2); ctx.fill();
          for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            ctx.beginPath();
            ctx.moveTo(el.x + 2*s + Math.cos(a)*3*s, el.y + 2*s + Math.sin(a)*3*s);
            ctx.lineTo(el.x + 2*s + Math.cos(a)*4.5*s, el.y + 2*s + Math.sin(a)*4.5*s);
            ctx.strokeStyle = '#FFB000';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          // nube según clima simulado
          if (state.sim.clima === 2 || state.sim.clima === 45) { // niebla
            for (let i=0;i<3;i++) ctx.fillRect(el.x, el.y + i*2*s, 7*s, 1*s);
          } else if (state.sim.clima >= 1 && state.sim.clima <= 2) { // nublado
            ctx.fillRect(el.x+2*s, el.y+3*s, 3*s, 1*s);
            ctx.fillRect(el.x+4*s, el.y+2*s, 2*s, 1*s);
          } else if (state.sim.clima >= 3 && state.sim.clima <= 4) { // lluvia
            for (let i=0;i<3;i++) ctx.fillRect(el.x+(1+i*2)*s, el.y+5*s, s, s);
          } else if (state.sim.clima >= 5 && state.sim.clima <= 7) { // nieve
            for (let i=0;i<3;i++) ctx.fillRect(el.x+(1+i*2)*s, el.y+6*s, 1,1);
          } else if (state.sim.clima >= 8) { // tormenta
            ctx.fillStyle = '#FFB000';
            ctx.fillRect(el.x+3*s, el.y+5*s, s, s);
            ctx.fillRect(el.x+2*s, el.y+7*s, s, s);
            ctx.fillRect(el.x+4*s, el.y+7*s, s, s);
          }
          break;
      }
      // resaltar selección con rectángulo punteado ámbar
      if (sel) {
        ctx.strokeStyle = '#FFB000';
        ctx.lineWidth = 2;
        ctx.setLineDash([4,4]);
        const b = getBounds(el);
        if (b) { ctx.strokeRect(b.x, b.y, b.x2-b.x, b.y2-b.y); ctx.setLineDash([]); }
      }
    }
  }

  // ---------- herramientas de puntero ----------
  let painting = false;
  let lastPos = {x:0, y:0};

  function posDiseño(e) {
    const rect = canvasRect();
    const sx = (e.clientX - rect.left) / (rect.width / W);
    const sy = (e.clientY - rect.top) / (rect.height / H);
    return {x: Math.max(0, Math.min(W-1, Math.floor(sx))), y: Math.max(0, Math.min(H-1, Math.floor(sy)))};
  }

  function setTool(t) {
    state.tool = t;
    // actualizar botones de herramienta (quitar .active, poner en el actual)
    document.querySelectorAll('.herramienta').forEach(b=>b.classList.remove('active'));
    const btn = document.querySelector(`button[data-tool="${t}"`);
    if (btn) btn.classList.add('active');
  }

  // evento: punterdown en canvas
  canvas.addEventListener('pointerdown', ev => {
    const {x, y} = posDiseño(ev);
    if (state.tool === 'text') {
      // abrir input flotante
      const input = document.getElementById('input-flotante');
      input.value = state.selId ? state.elementos.find(e=>e.id===state.selId)?.text || '' : '';
      input.style.left = `${x/ W * 100}%`;
      input.style.top = `${y/ H * 100}%`;
      input.hidden = false;
      input.focus();
      input.select();
      return;
    }
    if (state.tool === 'select') {
      const idx = hitTest(x, y);
      if (idx >= 0) {
        state.selId = state.elementos[idx].id;
        render();
      } else {
        state.selId = null;
        render();
      }
      return;
    }
    // brush/eraser o figura
    painting = true;
    lastPos = {x, y};
    if (state.tool === 'eraser') state.bitmap[y * W + x] = 0;
    else state.bitmap[y * W + x] = 1;
    render();
  });

  canvas.addEventListener('pointermove', ev => {
    if (!painting) return;
    const {x, y} = posDiseño(ev);
    // brush: pintar línea recta simple entre last y actual
    const dx = x - lastPos.x, dy = y - lastPos.y;
    const steps = Math.max(Math.hypot(dx, dy), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i/steps;
      const px = Math.round(lastPos.x + t * dx);
      const py = Math.round(lastPos.y + t * dy);
      if (px>=0 && px<W && py>=0 && py<H) {
        if (state.tool === 'eraser') state.bitmap[py * W + px] = 0;
        else state.bitmap[py * W + px] = 1;
      }
    }
    lastPos = {x, y};
    render();
  });

  canvas.addEventListener('pointerup', ev => {
    painting = false;
    // si estamos en modo línea/rect/disc: commit elemento
    // (ya se decidió al cambiar tool; si brush/eraser solo pintamos, ya hecho)
    if (state.tool === 'line' || state.tool === 'rect' || state.tool === 'disc') {
      // commit elemento con tamaño final
      const {x: x0, y: y0} = lastPos;
      let el;
      if (state.tool === 'line') {
        el = nuevoElemento('line', x0, y0, {x0, y0, x1: lastPos.x, y1: lastPos.y});
      } else if (state.tool === 'rect') {
        const w = Math.max(1, lastPos.x - x0);
        const h = Math.max(1, lastPos.y - y0);
        el = nuevoElemento('rect', x0, y0, {w, h, fill: false});
      } else if (state.tool === 'disc') {
        const r = Math.max(0.5, Math.hypot(lastPos.x - x0, lastPos.y - y0));
        el = nuevoElemento('disc', x0, y0, {r, fill: false});
      }
      state.selId = el.id;
    }
    render();
  });

  // teclado: flechas nudge elemento seleccionado, Delete/Backspace borrar
  window.addEventListener('keydown', ev => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (state.selId) { eliminarElemento(state.selId); state.selId = null; }
      return;
    }
    if (state.selId && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      const el = state.elementos.find(e=>e.id===state.selId);
      if (!el) return;
      const step = ev.shiftKey ? 4 : 1;
      if (ev.key === 'ArrowUp')    el.y = Math.max(0, el.y - step);
      if (ev.key === 'ArrowDown')  el.y = Math.min(H-1, el.y + step);
      if (ev.key === 'ArrowLeft')  el.x = Math.max(0, el.x - step);
      if (ev.key === 'ArrowRight') el.x = Math.min(W-1, el.x + step);
      render();
      ev.preventDefault();
    }
  });

  // ---------- propiedades y simulación ----------
  function actualizarPropiedades() {
    const section = document.getElementById('seleccion');
    if (!state.selId) { section.hidden = true; return; }
    const el = state.elementos.find(e=>e.id===state.selId);
    if (!el) return;
    section.hidden = false;
    section.innerHTML = '';
    const h = document.createElement('h4'); h.textContent = 'Seleccionado'; section.appendChild(h);

    const makeInput = (label, type, value, onchange) => {
      const div = document.createElement('div');
      const lb = document.createElement('label'); lb.textContent = label; lb.style.fontFamily = '"Archivo Narrow",sans-serif'; lb.style.display = 'block';
      const inp = document.createElement('input'); inp.type = type; inp.value = value; inp.style.width = '100%';
      inp.style.marginTop = '.4rem'; inp.style.padding = '.2rem'; inp.style.fontSize = '.8rem';
      inp.style.fontFamily = '"Archivo Narrow",sans-serif';
      inp.addEventListener('change', (e)=>onchange(e.target.value), false);
      div.appendChild(lb); div.appendChild(inp);
      return div;
    };

    // inputs comunes: x,y
    section.appendChild(makeInput('X', 'number', el.x, v=>{ el.x = Math.max(0,Math.min(W-1,parseInt(v,10))); render(); }));
    section.appendChild(makeInput('Y', 'number', el.y, v=>{ el.y = Math.max(0,Math.min(H-1,parseInt(v,10))); render(); }));

    // inputs específicos por tipo
    if (el.type === 'rect' || el.type === 'disc') {
      section.appendChild(makeInput('Ancho', 'number', el.w ?? 10, v=>{ if(el.type==='rect'){ el.w = Math.max(1,parseInt(v,10)); render(); } }));
      section.appendChild(makeInput('Alto', 'number', el.h ?? 10, v=>{ if(el.type==='rect'){ el.h = Math.max(1,parseInt(v,10)); render(); } else if(el.type==='disc'){ el.r = Math.max(0.5, parseFloat(v)||0); render(); } }));
      const fillChk = document.createElement('div'); fillChk.style.marginTop='.4rem';
      const lbl = document.createElement('label'); lbl.style.fontFamily='"Archivo Narrow",sans-serif'; lbl.textContent = 'Relleno'; lbl.style.display='inline-block'; lbl.style.marginRight='.6rem';
      const chk = document.createElement('input'); chk.type='checkbox'; chk.checked = el.fill ?? false; chk.addEventListener('change',()=>{ el.fill = chk.checked; render(); }); chk.style.transform='scale(1.2)'; chk.style.marginRight='.2rem';
      fillChk.appendChild(lbl); fillChk.appendChild(chk); section.appendChild(fillChk);
    }
    if (el.type === 'disc') {
      section.appendChild(makeInput('Radio', 'number', el.r ?? 5, v=>{ el.r = Math.max(0.5, parseFloat(v)||0); render(); }));
    }
    if (el.type === 'text') {
      const fontGrp = document.createElement('div'); fontGrp.style.marginTop='.4rem'; fontGrp.style.fontFamily='"Archivo Narrow",sans-serif';
      const fontLbl = document.createElement('label'); fontLbl.textContent = 'Fuente'; fontLbl.style.display='block';
      const fontSel = document.createElement('select'); fontSel.style.width='100%'; fontSel.style.padding='.2rem'; fontSel.style.fontSize='.8rem';
      const fonts = [{label:'5x7 (pequeña)', value:1},{label:'7x13 (mediana)', value:2},{label:'10x20 (grande)', value:3}];
      fonts.forEach(f=>{ const opt = document.createElement('option'); opt.value = f.value; opt.textContent = f.label; if(f.value===el.font) opt.selected=true; fontSel.appendChild(opt); });
      fontSel.addEventListener('change',(e)=>{ el.font = parseInt(e.target.value,10); render(); }); section.appendChild(fontLbl); section.appendChild(fontSel);
      section.appendChild(makeInput('Texto', 'textarea', el.text || '', v=>{ el.text = v; render(); }));
      // botones de tokens
      const tokDiv = document.createElement('div'); tokDiv.style.marginTop='.4rem'; tokDiv.style.fontSize='.7rem';
      const tokens = ['%HORA%','%FECHA%','%BAT%','%VOL%','%TEMP%','%CIELO%'];
      tokens.forEach(t=>{ const b = document.createElement('button'); b.textContent = t; b.style.marginRight='.3rem'; b.style.padding='.2rem .4rem'; b.style.fontSize='.7rem'; b.addEventListener('click',()=>{ const pos = el.text.length; el.text = el.text.slice(0,pos) + t + el.text.slice(pos); render(); }); tokDiv.appendChild(b); });
      section.appendChild(tokDiv);
    }
    if (el.type === 'battery') {
      section.appendChild(makeInput('Ancho', 'number', el.w ?? 20, v=>{ el.w = Math.max(1,parseInt(v,10)); render(); }));
      section.appendChild(makeInput('Alto', 'number', el.h ?? 12, v=>{ el.h = Math.max(1,parseInt(v,10)); render(); }));
    }
    if (el.type === 'wxicon') {
      section.appendChild(makeInput('Escala', 'number', el.s ?? 1, v=>{ el.s = Math.max(0.5, parseFloat(v)||1); render(); }));
    }
  }

  function actualizarSimulacion() {
    const sec = document.getElementById('simulacion');
    if (!sec) return;
    // batería slider
    const batInp = document.getElementById('sim-batt');
    if (batInp) { batInp.value = state.sim.batt; }
    // temperatura input
    const tempInp = document.getElementById('sim-temp');
    if (tempInp) { tempInp.value = state.sim.temp; }
    // clima select
    const climaSel = document.getElementById('sim-clima');
    if (climaSel) { climaSel.value = state.sim.clima; }
  }

  // crear paneles de simulación y conexión
  function crearPaneles() {
    // panel simulación
    const simHTML = `
      <section id="simulacion" style="margin-top:1rem;">
        <h4 style="font-family:'Archivo Narrow',sans-serif;margin-bottom:.5rem;">Simulación</h4>
        <div style="display:flex;gap:1rem;font-size:.8rem;font-family:'Archivo Narrow',sans-serif;">
          <div>
            <label style="display:block;margin-bottom:.2rem;">Batería</label>
            <input id="sim-batt" type="range" min="0" max="100" value="76" style="width:120px;">
          </div>
          <div>
            <label style="display:block;margin-bottom:.2rem;">Temperatura</label>
            <input id="sim-temp" type="number" value="21" style="width:60px;">
            <span>°C</span>
          </div>
          <div>
            <label style="display:block;margin-bottom:.2rem;">Clima</label>
            <select id="sim-clima">
              <option value="0">Despejado</option>
              <option value="1">Nublado</option>
              <option value="2">Lluvia</option>
              <option value="3">Nieve</option>
              <option value="4">Tormenta</option>
            </select>
          </div>
        </div>
      </section>`;
    // insert after properties? We'll prepend to aside panel-der
    const panelDer = document.querySelector('.panel-der');
    const existing = panelDer.querySelector('#simulacion');
    if (!existing) panelDer.insertAdjacentHTML('beforeend', simHTML);

    // actualizar sim al cambiar controles
    document.getElementById('sim-batt').addEventListener('input',(e)=>{ state.sim.batt = parseInt(e.target.value,10); render(); });
    document.getElementById('sim-temp').addEventListener('input',(e)=>{ state.sim.temp = parseFloat(e.target.value)||0; render(); });
    document.getElementById('sim-clima').addEventListener('change',(e)=>{ state.sim.clima = parseInt(e.target.value,10); render(); });
  }

  // ---------- presets ----------
  function cargarPreset(nombre) {
    state.bitmap.fill(0);
    state.elementos = [];
    state.selId = null;
    switch(nombre) {
      case 'bateria': {
        // frame borde
        nuevoElemento('rect', 0, 0, {w:W, h:H, fill:false});
        // batería
        nuevoElemento('battery', 6, 8, {w:30, h:16});
        nuevoElemento('text', 6, 30, {font:1, text:'%VOL%'});
        nuevoElemento('text', 44, 22, {font:3, text:'%BAT%'});
        break;
      }
      case 'hora': {
        nuevoElemento('rect', 0, 0, {w:W, h:H, fill:false});
        nuevoElemento('text', 34, 38, {font:3, text:'%HORA%'}); // centrado ~
        nuevoElemento('text', 47, 54, {font:1, text:'%FECHA%'});
        break;
      }
      case 'clima': {
        nuevoElemento('rect', 0, 0, {w:W, h:H, fill:false});
        nuevoElemento('wxicon', 8, 10, {s:2});
        nuevoElemento('text', 30, 26, {font:3, text:'%TEMP%'});
        nuevoElemento('text', 30, 40, {font:1, text:'%VOL%'});
        nuevoElemento('text', 30, 52, {font:1, text:'%BAT%'});
        break;
      }
      case 'panel': {
        // marco completo
        nuevoElemento('rect', 0, 0, {w:W, h:H, fill:false});
        // batería arriba a la derecha
        nuevoElemento('battery', 100, 3, {w:22, h:9});
        nuevoElemento('text', 2, 10, {font:1, text:'%HORA%'});
        // reloj grande
        nuevoElemento('text', 24, 38, {font:3, text:'%HORA%'});
        // línea divisoria
        nuevoElemento('line', 2, 46, {x1:126, y1:46});
        // clima abajo
        nuevoElemento('wxicon', 6, 50, {s:1});
        nuevoElemento('text', 18, 58, {font:1, text:'%TEMP%'});
        break;
      }
    }
    render();
  }

  // cargar preset al iniciar (con animación respetuosa)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cargarPreset('panel');
  } else {
    // animación de "encendido" OLED: clip-path reveal 900ms
    const canvasWrapper = document.querySelector('.lienzo-zona');
    canvasWrapper.style.clipPath = 'inset(100% 0 0 0)';
    canvasWrapper.style.transition = 'clip-path 0.9s ease-out';
    setTimeout(()=>{ canvasWrapper.style.clipPath = 'inset(0 0 0 0)'; }, 50);
    setTimeout(cargarPreset, 900, 'panel');
  }

  // ---------- botones de herramientas ----------
  document.querySelectorAll('.herramienta').forEach(b=> {
    b.addEventListener('click',()=> setTool(b.dataset.tool));
  });
  setTool('brush'); // inicial

  // ---------- presets panel izquierdo ----------
  const presetBtns = document.querySelectorAll('.preset-btn');
  presetBtns.forEach(b=> b.addEventListener('click',()=> cargarPreset(b.dataset.preset)));

  const elemBtns = document.querySelectorAll('.elem-btn');
  elemBtns.forEach(b=> b.addEventListener('click',()=> {
    const tipo = b.dataset.elem;
    let x = W/2, y = H/2;
    if (tipo === 'battery') nuevoElemento('battery', x-15, y-8, {w:30, h:16});
    else if (tipo === 'wxicon') nuevoElemento('wxicon', x-7, y-4, {s:2});
    else if (tipo === 'text') { nuevoElemento('text', x, y, {font:2, text:'%BAT%'}); state.selId = state.elementos[state.elementos.length-1].id; }
    else if (tipo === 'rect') nuevoElemento('rect', x-20, y-10, {w:40, h:20, fill:false});
    else if (tipo === 'line') nuevoElemento('line', x-30, y, {x0:x-30, y0:y, x1:x+30, y1:y});
    else if (tipo === 'disc') nuevoElemento('disc', x, y, {r:10, fill:false});
    render();
  }));

  // limpiar todo
  document.getElementById('limpiar-todo').addEventListener('click',()=> {
    state.bitmap.fill(0);
    state.elementos = [];
    state.selId = null;
    render();
  });

  // ---------- propiedades y simulación ----------
  actualizarPropiedades();
  crearPaneles();
  actualizarSimulacion();

  // ---------- compilar y subir ----------
  // compilar blob
  function compilarBlob() {
    // cabecera: 8 bytes: "S13U", versión(1), count(u16 LE), reserva(1)
    const cabecera = new Uint8Array([0x53,0x31,0x33,0x55,0x01,0x00,0x00,0x00]);
    // contaremos elementos después
    const tmp = { ...state }; // copy
    // build elements
    // ... (simple: serialize state directly, we'll implement a compact builder below)
    // For now, basic compile that just writes bitmap + elements to a Uint8Array
    // We'll produce a minimal blob that firmware can parse.
    // We'll follow the contract: header 8 bytes, then per element: type(1), len(1), payload.
    // Build elements list; each element known shape.

    // Para brevedad, implementar compile mínimo:
    const elements = state.elementos.map(el => {
      switch(el.type) {
        case 'line': return [2, 4, el.x0, el.y0, el.x1, el.y1];
        case 'rect': return [3, 5, el.x, el.y, el.w, el.h, el.fill ? 1 : 0];
        case 'disc': return [5, 4, el.x, el.y, el.r, el.fill ? 1 : 0];
        case 'text': {
          const bytes = new TextEncoder().encode(el.text);
          return [4, 4 + bytes.length, el.x, el.y, el.font, ...bytes];
        }
        case 'battery': return [6, 4, el.x, el.y, el.w, el.h];
        case 'wxicon': return [7, 3, el.x, el.y, el.s ? el.s : 1];
        case 'PIXEL': // no usado como elemento independiente, está en bitmap
          return null;
      }
    }).filter(Boolean);

    const count = elements.length;
    // cabecera: versión en byte 4, count en bytes 5-6
    cabecera[5] = count & 0xFF;
    cabecera[6] = (count >> 8) & 0xFF;

    const payload = new Uint8Array(8 + elements.reduce((acc, cur) => acc + 2 + cur[1], 0));
    payload.set(cabecera, 0);
    let off = 8;
    for (const el of elements) {
      payload.set([el[0], el[1]], off); off += 2;
      payload.set(new Uint8Array(el.slice(2)), off); off += el.slice(2).length;
    }
    return payload;
  }

  // compilar configuración .ino
  function compilarConfigIno() {
    const cfg = {
      ssid: state.cfg.ssid,
      pass: state.cfg.pass,
      lat: state.cfg.lat,
      lon: state.cfg.lon,
      vmin: state.cfg.vmin,
      vmax: state.cfg.vmax,
      vdiv: state.cfg.vdiv,
      pin: state.cfg.pin,
      tz: state.cfg.tz
    };
    return JSON.stringify(cfg);
  }

  // descargar .ino
  document.getElementById('btn-ino').addEventListener('click', async () => {
    try {
      const cfgJson = compilarConfigIno();
      const resp = await fetch('./firmware/s13_interprete.ino');
      if (!resp.ok) throw new Error('No se encontró firmware/s13_interprete.ino');
      const tpl = await resp.text();
      const arr = [...compilarBlob()].map(b => '0x' + b.toString(16).padStart(2,'0')).join(',');
      const inject = `const uint8_t EMBEDDED_BLOB[] = {${arr}};\nconst unsigned EMBEDDED_LEN = ${compilarBlob().length};\nconst char EMBEDDED_CFG[] = "${JSON.stringify(cfgJson).replace(/"/g, '\\"')}";`;
      const out = tpl.replace('//__CONFIG__', inject);
      const blob = new Blob([out], {type: 'text/plain'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 's13_ sketch.ino'; a.click();
      URL.revokeObjectURL(url);
    } catch(e) {
      console.error(e);
      alert('Error al generar .ino: ' + e.message);
    }
  });

  // subir al ESP32 (compilar + flasheo)
  document.getElementById('btn-subir').addEventListener('click', async () => {
    if (!('serial' in navigator)) { alert('Web Serial no disponible en este navegador.'); return; }
    // compile blob + cfg
    const blob = compilarBlob();
    const cfgJson = compilarConfigIno();
    // show progress
    const btn = document.getElementById('btn-subir');
    btn.disabled = true; btn.textContent = 'Subiendo...';
    try {
      await Subida.subir(blob, cfgJson);
      btn.textContent = '✔ Subido';
      setTimeout(()=>{ btn.disabled=false; btn.textContent='Compilar y subir al ESP32'; }, 2000);
    } catch(e) {
      btn.textContent = 'Error';
      setTimeout(()=>{ btn.disabled=false; btn.textContent='Compilar y subir al ESP32'; }, 2000);
      console.error(e);
    }
  });

  // compilar simple (mostrar hex dump + stats)
  document.getElementById('btn-compilar').addEventListener('click', () => {
    const blob = compilarBlob();
    const stats = `Elementos: ${blob.length} bytes, ${state.elementos.length} elementos, Límite NVS 2048 bytes (${(blob.length/2048*100).toFixed(1)}%)`;
    const hex = compilarBlob().slice(0,512).reduce((a,b)=>a+String.fromCharCode(b), '').replace(/[^\x20-\x7E]/g,'.');
    const inspector = document.getElementById('inspector');
    inspector.innerHTML = `<pre style="font-family:monospace,monospace;font-size:.7rem;">${hex}</pre><p>${stats}</p>`;
    inspector.hidden = false;
  });

  // iniciar con foco en canvas
  canvas.focus();
})();