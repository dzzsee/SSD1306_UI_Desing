/*
  S13 Intérprete — firmware para ESP32 + SSD1306 (I2C, 128x64)

  Recibe un "diseño" compilado desde la web (secuencia de comandos de
  dibujo) por puerto serie y lo guarda en memoria NVS. Lo ejecuta en
  bucle resolviendo datos dinámicos: batería (ADC), hora (NTP) y
  clima (Open-Meteo).

  Protocolo serie a 115200 baudios:
    S13VER?\n        -> S13VER 1.0
    S13CFG <json>\n  -> OK CFG | ERR CFG   (wifi, ubicación, batería)
    S13UI <hex>\n    -> OK UI  | ERR UI    (diseño compilado)
    S13RESET\n       -> reinicia el ESP32

  Librería requerida: U8g2 (gestor de librerías de Arduino).
  Conexión típica del SSD1306: SDA -> GPIO21, SCL -> GPIO22.
  Divisor de voltaje de la batería conectado a GPIO34.

  Comandos del diseño (formato TLV, payload tras tipo y longitud):
    1 PIXEL   x,y
    2 LINE    x0,y0,x1,y1
    3 RECT    x,y,w,h,relleno
    4 TEXT    x,y,fuente,longitud,bytes   (fuente 1/2/3)
    5 DISC    x,y,r,relleno
    6 BATTERY x,y,w,h   (icono dinámico según voltaje de celda)
    7 WXICON  x,y,escala (icono dinámico según clima)
    8 BITMAP  x,y,w,h,datos 1bpp por filas

  Tokens que el firmware sustituye en textos:
    %HORA% %FECHA% %BAT% %VOL% %TEMP%
*/

#include <U8g2lib.h>
#include <Wire.h>
#include <Preferences.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>

//__CONFIG__

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
Preferences prefs;

#define MAX_BLOB 2048
#define MAX_CFG  512

uint8_t  uiBlob[MAX_BLOB];
uint16_t blobLen = 0;
char     cfgJson[MAX_CFG] = "";

char    apSsid[33] = "";
char    apPass[65] = "";
float   cfgLat = 0, cfgLon = 0;
float   cfgVmin = 3.3f, cfgVmax = 4.2f;
int     cfgVdiv = 2;
int     adcPin  = 34;
int     tzOff   = -3;

float battPct = -1, battVolt = -1;
float tempC = NAN;
int   wxCode = -1;
bool  wifiOk = false;

unsigned long tBatt = 0, tWx = 0, tReloj = 0;

const char* NTP_HOST = "pool.ntp.org";

/* ---------- utilidades ---------- */

bool startsWith(const char* s, const char* p) {
  return strncmp(s, p, strlen(p)) == 0;
}

int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Campo "clave":valor numérico en JSON plano
float jsonNum(const char* json, const char* clave, float def) {
  char pat[24];
  snprintf(pat, sizeof(pat), "\"%s\":", clave);
  const char* p = strstr(json, pat);
  if (!p) return def;
  return atof(p + strlen(pat));
}

// Campo "clave":"texto" en JSON plano
void jsonStr(const char* json, const char* clave, char* out, size_t outLen) {
  out[0] = '\0';
  char pat[24];
  snprintf(pat, sizeof(pat), "\"%s\":\"", clave);
  const char* p = strstr(json, pat);
  if (!p) return;
  p += strlen(pat);
  const char* e = strchr(p, '"');
  if (!e) return;
  size_t n = min((size_t)(e - p), outLen - 1);
  memcpy(out, p, n);
  out[n] = '\0';
}

/* ---------- carga y guardado ---------- */

void cargarNVS() {
  prefs.begin("s13", true);
  size_t n = prefs.getBytesLength("ui");
  if (n > 0 && n <= MAX_BLOB) {
    prefs.getBytes("ui", uiBlob, n);
    blobLen = n;
  }
  String c = prefs.getString("cfg", "");
  if (c.length() > 0 && c.length() < MAX_CFG) {
    c.toCharArray(cfgJson, MAX_CFG);
  }
  prefs.end();

  if (blobLen == 0 && EMBEDDED_LEN > 0) {
    memcpy(uiBlob, EMBEDDED_BLOB, EMBEDDED_LEN);
    blobLen = EMBEDDED_LEN;
  }
  if (cfgJson[0] == '\0' && EMBEDDED_CFG[0] != '\0') {
    strncpy(cfgJson, EMBEDDED_CFG, MAX_CFG - 1);
    cfgJson[MAX_CFG - 1] = '\0';
  }
}

void guardarUI(const uint8_t* data, uint16_t len) {
  prefs.begin("s13", false);
  prefs.putBytes("ui", data, len);
  prefs.end();
  memcpy(uiBlob, data, len);
  blobLen = len;
}

void guardarCfg(const char* json) {
  prefs.begin("s13", false);
  prefs.putString("cfg", json);
  prefs.end();
  strncpy(cfgJson, json, MAX_CFG - 1);
  cfgJson[MAX_CFG - 1] = '\0';
}

/* ---------- configuración ---------- */

void aplicarConfig() {
  if (cfgJson[0] == '\0') return;
  jsonStr(cfgJson, "ssid", apSsid, sizeof(apSsid));
  jsonStr(cfgJson, "pass", apPass, sizeof(apPass));
  cfgLat  = jsonNum(cfgJson, "lat",  cfgLat);
  cfgLon  = jsonNum(cfgJson, "lon",  cfgLon);
  cfgVmin = jsonNum(cfgJson, "vmin", cfgVmin);
  cfgVmax = jsonNum(cfgJson, "vmax", cfgVmax);
  cfgVdiv = (int)jsonNum(cfgJson, "vdiv", cfgVdiv);
  adcPin  = (int)jsonNum(cfgJson, "pin",  adcPin);
  tzOff   = (int)jsonNum(cfgJson, "tz",   tzOff);
  if (cfgVdiv < 1) cfgVdiv = 1;
}

/* ---------- wifi ---------- */

void conectarWifi() {
  if (apSsid[0] == '\0') return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(apSsid, apPass);
}

void configurarHora() {
  configTime(tzOff * 3600, 0, NTP_HOST);
}

/* ---------- sensores ---------- */

void leerBateria() {
  uint32_t acc = 0;
  for (int i = 0; i < 32; i++) {
    acc += analogRead(adcPin);
    delayMicroseconds(200);
  }
  float raw = acc / 32.0f;
  battVolt = (raw * 3.3f / 4095.0f) * cfgVdiv;
  if (battVolt < 0.2f) {          // sin señal: nada conectado
    battVolt = -1;
    battPct = -1;
    return;
  }
  float p = (battVolt - cfgVmin) / (cfgVmax - cfgVmin) * 100.0f;
  battPct = constrain(p, 0.0f, 100.0f);
}

// Devuelve texto corto en español para un código de clima Open-Meteo
const char* textoClima(int code) {
  if (code < 0) return "--";
  if (code == 0) return "Despejado";
  if (code <= 3) return "Nublado";
  if (code <= 48) return "Niebla";
  if (code <= 67) return "Lluvia";
  if (code <= 77) return "Nieve";
  if (code <= 82) return "Lluvia";
  if (code <= 86) return "Nieve";
  if (code <= 99) return "Tormenta";
  return "--";
}

void leerClima() {
  if (!wifiOk || cfgLat == 0 && cfgLon == 0) return;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  char url[160];
  snprintf(url, sizeof(url),
    "https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f&current=temperature_2m,weather_code",
    cfgLat, cfgLon);
  if (!http.begin(client, url)) return;
  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    int iT = body.indexOf("\"temperature_2m\":");
    int iC = body.indexOf("\"weather_code\":");
    if (iT >= 0) tempC = body.substring(iT + 17, body.indexOf(',', iT)).toFloat();
    if (iC >= 0) wxCode = body.substring(iC + 15, body.indexOf('}', iC)).toInt();
  }
  http.end();
}

/* ---------- dibujo ---------- */

const uint8_t* fuenteDe(int f) {
  switch (f) {
    case 2:  return u8g2_font_7x13B_tr;
    case 3:  return u8g2_font_10x20_tr;
    default: return u8g2_font_5x7_tr;
  }
}

// Sustituye tokens dinámicos y dibuja el texto
void dibujarTexto(int x, int y, int fuente, const char* data, int len) {
  char buf[64];
  int o = 0;
  for (int i = 0; i < len && o < (int)sizeof(buf) - 1; i++) {
    if (data[i] == '%' && i + 1 < len) {
      if (startsWith(data + i, "%HORA%") && strlen(data + i) >= 6) {
        struct tm tm;
        if (wifiOk && getLocalTime(&tm, 10)) {
          o += snprintf(buf + o, sizeof(buf) - o, "%02d:%02d", tm.tm_hour, tm.tm_min);
        } else {
          o += snprintf(buf + o, sizeof(buf) - o, "--:--");
        }
        i += 5;
        continue;
      }
      if (startsWith(data + i, "%FECHA%") && strlen(data + i) >= 7) {
        struct tm tm;
        if (wifiOk && getLocalTime(&tm, 10)) {
          o += snprintf(buf + o, sizeof(buf) - o, "%02d/%02d", tm.tm_mday, tm.tm_mon + 1);
        } else {
          o += snprintf(buf + o, sizeof(buf) - o, "--/--");
        }
        i += 6;
        continue;
      }
      if (startsWith(data + i, "%BAT%") && strlen(data + i) >= 5) {
        if (battPct >= 0) o += snprintf(buf + o, sizeof(buf) - o, "%d%%", (int)battPct);
        else              o += snprintf(buf + o, sizeof(buf) - o, "--%%");
        i += 4;
        continue;
      }
      if (startsWith(data + i, "%VOL%") && strlen(data + i) >= 5) {
        if (battVolt >= 0) o += snprintf(buf + o, sizeof(buf) - o, "%.2fV", battVolt);
        else               o += snprintf(buf + o, sizeof(buf) - o, "--V");
        i += 4;
        continue;
      }
      if (startsWith(data + i, "%TEMP%") && strlen(data + i) >= 6) {
        if (!isnan(tempC)) o += snprintf(buf + o, sizeof(buf) - o, "%.0fC", tempC);
        else               o += snprintf(buf + o, sizeof(buf) - o, "--C");
        i += 5;
        continue;
      }
      if (startsWith(data + i, "%CIELO%") && strlen(data + i) >= 7) {
        if (wifiOk && wxCode >= 0) {
          o += snprintf(buf + o, sizeof(buf) - o, "%s", textoClima(wxCode));
        } else {
          o += snprintf(buf + o, sizeof(buf) - o, "--");
        }
        i += 6;
        continue;
      }
    }
    buf[o++] = data[i];
  }
  buf[o] = '\0';
  u8g2.setFont(fuenteDe(fuente));
  u8g2.drawStr(x, y, buf);
}

// Batería: contorno + terminal + relleno proporcional al voltaje
void dibujarBateria(int x, int y, int w, int h) {
  u8g2.drawFrame(x, y, w, h);
  u8g2.drawBox(x + w, y + h / 4, 2, h / 2);
  if (battPct >= 0) {
    int fw = (int)((w - 2) * battPct / 100.0f);
    if (fw > 0) u8g2.drawBox(x + 1, y + 1, fw, h - 2);
  }
}

// Icono de clima según código Open-Meteo, en (x,y) con escala s
void dibujarWxIcon(int x, int y, int s) {
  int code = wxCode;
  // sol
  if (code <= 1) {
    u8g2.drawDisc(x + 2 * s, y + 2 * s, 2 * s);
    for (int i = 0; i < 8; i++) {
      float a = i * PI / 4.0f;
      u8g2.drawLine(
        x + 2 * s + round(cos(a) * 3 * s), y + 2 * s + round(sin(a) * 3 * s),
        x + 2 * s + round(cos(a) * 4.5f * s), y + 2 * s + round(sin(a) * 4.5f * s));
    }
    return;
  }
  // nube base
  bool nieve = (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
  bool lluvia = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
  bool tormenta = code >= 95;
  bool niebla = code == 45 || code == 48;
  if (niebla) {
    for (int i = 0; i < 3; i++)
      u8g2.drawHLine(x, y + i * 2 * s, 7 * s);
    return;
  }
  u8g2.drawDisc(x + 2 * s, y + 2 * s, 2 * s);
  u8g2.drawDisc(x + 4 * s, y + 3 * s, 2 * s);
  u8g2.drawBox(x + 2 * s, y + 3 * s, 3 * s, 1 * s);
  if (lluvia || tormenta) {
    for (int i = 0; i < 3; i++)
      u8g2.drawLine(x + (1 + i * 2) * s, y + 5 * s, x + (1 + i * 2) * s - s, y + 7 * s);
  }
  if (nieve) {
    for (int i = 0; i < 3; i++)
      u8g2.drawPixel(x + (1 + i * 2) * s, y + 6 * s);
  }
  if (tormenta) {
    u8g2.drawLine(x + 3 * s, y + 5 * s, x + 2 * s, y + 7 * s);
    u8g2.drawLine(x + 2 * s, y + 7 * s, x + 4 * s, y + 7 * s);
    u8g2.drawLine(x + 4 * s, y + 7 * s, x + 3 * s, y + 9 * s);
  }
}

void dibujarDiseno() {
  u8g2.clearBuffer();
  uint16_t p = 8; // salta cabecera
  uint16_t n = (uiBlob[5] << 8) | uiBlob[6];
  while (p + 2 <= blobLen && n > 0) {
    uint8_t tipo = uiBlob[p];
    uint8_t len = uiBlob[p + 1];
    const uint8_t* d = uiBlob + p + 2;
    if (p + 2 + len > blobLen) break;
    switch (tipo) {
      case 1: // PIXEL
        u8g2.drawPixel(d[0], d[1]);
        break;
      case 2: // LINE
        u8g2.drawLine(d[0], d[1], d[2], d[3]);
        break;
      case 3: // RECT
        if (d[4]) u8g2.drawBox(d[0], d[1], d[2], d[3]);
        else      u8g2.drawFrame(d[0], d[1], d[2], d[3]);
        break;
      case 4: // TEXT
        dibujarTexto(d[0], d[1], d[2], (const char*)(d + 4), len - 4);
        break;
      case 5: // DISC
        if (d[3]) u8g2.drawDisc(d[0], d[1], d[2]);
        else      u8g2.drawCircle(d[0], d[1], d[2]);
        break;
      case 6: // BATTERY
        dibujarBateria(d[0], d[1], d[2], d[3]);
        break;
      case 7: // WXICON
        dibujarWxIcon(d[0], d[1], d[2] ? d[2] : 1);
        break;
      case 8: { // BITMAP
        uint8_t w = d[2], h = d[3];
        const uint8_t* bits = d + 4;
        for (uint8_t yy = 0; yy < h; yy++)
          for (uint8_t xx = 0; xx < w; xx++)
            if (bits[yy * ((w + 7) / 8) + (xx >> 3)] & (0x80 >> (xx & 7)))
              u8g2.drawPixel(d[0] + xx, d[1] + yy);
        break;
      }
    }
    p += 2 + len;
    n--;
  }
  u8g2.sendBuffer();
}

void pantallaEspera() {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_7x13B_tr);
  u8g2.drawStr(14, 30, "Sin diseno");
  u8g2.setFont(u8g2_font_5x7_tr);
  u8g2.drawStr(14, 44, "Abre la web y");
  u8g2.drawStr(14, 53, "sube uno");
  u8g2.sendBuffer();
}

/* ---------- serie ---------- */

char lineaSerie[4200];
int  idxSerie = 0;

void procesarLinea(char* l) {
  if (startsWith(l, "S13VER?")) {
    Serial.println("S13VER 1.0");
  } else if (startsWith(l, "S13CFG ")) {
    if (strlen(l) < 8 || strlen(l) - 7 >= MAX_CFG) { Serial.println("ERR CFG"); return; }
    guardarCfg(l + 7);
    aplicarConfig();
    if (apSsid[0]) conectarWifi();
    Serial.println("OK CFG");
  } else if (startsWith(l, "S13UI ")) {
    const char* hex = l + 6;
    size_t n = strlen(hex);
    if (n < 16 || n % 2 != 0 || n / 2 > MAX_BLOB) { Serial.println("ERR UI"); return; }
    uint8_t tmp[MAX_BLOB];
    for (size_t i = 0; i < n / 2; i++) {
      int hi = hexVal(hex[2 * i]), lo = hexVal(hex[2 * i + 1]);
      if (hi < 0 || lo < 0) { Serial.println("ERR UI"); return; }
      tmp[i] = (hi << 4) | lo;
    }
    if (memcmp(tmp, "S13U", 4) != 0) { Serial.println("ERR UI"); return; }
    guardarUI(tmp, n / 2);
    Serial.println("OK UI");
  } else if (startsWith(l, "S13RESET")) {
    Serial.println("OK RESET");
    delay(100);
    ESP.restart();
  }
}

void atenderSerie() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      lineaSerie[idxSerie] = '\0';
      if (idxSerie > 0) procesarLinea(lineaSerie);
      idxSerie = 0;
    } else if (c != '\r' && idxSerie < (int)sizeof(lineaSerie) - 1) {
      lineaSerie[idxSerie++] = c;
    }
  }
}

/* ---------- principal ---------- */

void setup() {
  Serial.begin(115200);
  u8g2.begin();
  cargarNVS();
  aplicarConfig();
  conectarWifi();
  pantallaEspera();
  tBatt = tWx = tReloj = millis();
}

void loop() {
  atenderSerie();

  unsigned long ahora = millis();
  if (ahora - tBatt > 500) {
    tBatt = ahora;
    leerBateria();
  }
  if (ahora - tReloj > 1000) {
    tReloj = ahora;
    if (WiFi.status() == WL_CONNECTED) {
      if (!wifiOk) {
        wifiOk = true;
        configurarHora();
        tWx = 0;
      }
    } else {
      wifiOk = false;
    }
  }
  if (wifiOk && ahora - tWx > 15UL * 60UL * 1000UL) {
    tWx = ahora;
    leerClima();
  }

  if (blobLen > 0) dibujarDiseno();
}
