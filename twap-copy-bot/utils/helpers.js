function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Округлення ВНИЗ до кратності step (volUnit / lot size ф'ючерсу)
function floorToStep(value, step) {
  if (!step || step <= 0) return value;
  return Math.floor(value / step) * step;
}

// Округлення ціни до кратності priceUnit (tick size)
function roundToTick(value, tick) {
  if (!tick || tick <= 0) return value;
  const decimals = Math.max(0, (tick.toString().split('.')[1] || '').length);
  return parseFloat((Math.round(value / tick) * tick).toFixed(decimals));
}

function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

// ----------------------------------------------------------------------
// НОВЕ: парсинг чисел з повідомлень TWAP-каналу
// ----------------------------------------------------------------------

// "$220.01K" -> 220010, "$24.76M" -> 24760000, "$2.02" -> 2.02, "$1,011.75" -> 1011.75
function parseMoneyShort(str) {
  if (!str) return null;
  const cleaned = str.replace(/[$,\s]/g, '');
  const m = cleaned.match(/^(-?[\d.]+)([KMB])?$/i);
  if (!m) return null;
  let value = parseFloat(m[1]);
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') value *= 1_000;
  else if (suffix === 'M') value *= 1_000_000;
  else if (suffix === 'B') value *= 1_000_000_000;
  return value;
}

// "в течении 12.2 часа" -> секунди; підтримує години/хвилини/дні (укр/рос варіанти)
function parseDurationToSeconds(str) {
  if (!str) return null;
  const m = str.match(/([\d.]+)\s*(час|часа|часов|год|години|годин|минут|минуты|хв|хвилин|день|дня|дней|дні|доба|доби)/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('час') || unit.startsWith('год')) return Math.round(value * 3600);
  if (unit.startsWith('мин') || unit.startsWith('хв')) return Math.round(value * 60);
  if (unit.startsWith('д')) return Math.round(value * 86400);
  return null;
}

// "09:41:53" (UTC, без дати) -> Date з урахуванням дня, коли повідомлення реально
// прийшло. Якщо різниця з поточним моментом > 12 годин — беремо попередню добу
// (повідомлення прийшло вже після півночі UTC, час у ньому належить вчорашній добі).
function parseTwapTimestampUtc(timeStr, receivedAtMs = Date.now()) {
  const m = timeStr.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return receivedAtMs;
  const [, h, mi, s] = m;
  const received = new Date(receivedAtMs);
  let candidate = Date.UTC(
    received.getUTCFullYear(), received.getUTCMonth(), received.getUTCDate(),
    parseInt(h), parseInt(mi), parseInt(s)
  );
  const twelveHoursMs = 12 * 3600 * 1000;
  if (Math.abs(receivedAtMs - candidate) > twelveHoursMs) {
    if (candidate > receivedAtMs) candidate -= 24 * 3600 * 1000;
    else candidate += 24 * 3600 * 1000;
  }
  return candidate;
}

function normalizeAddress(addr) {
  return (addr || '').trim().toLowerCase();
}

module.exports = {
  sleep,
  isValidNumber,
  floorToStep,
  roundToTick,
  getCurrentDate,
  parseMoneyShort,
  parseDurationToSeconds,
  parseTwapTimestampUtc,
  normalizeAddress
};
