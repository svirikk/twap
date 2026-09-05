if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WALLETS = require('./wallets');

function requireEnvForLive() {
  if (process.env.DRY_RUN === 'true') return;
  const required = ['MEXC_API_KEY', 'MEXC_API_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Відсутні обов'язкові змінні оточення: ${missing.join(', ')}`);
  }
}
requireEnvForLive();

// ============================================================================
// МАПІНГ Hyperliquid symbol -> MEXC futures contract symbol.
// За замовчуванням просто ${SYMBOL}_USDT. Винятки (якщо тікер на MEXC
// зветься інакше, чи не торгується взагалі) — додавай сюди вручну.
// ============================================================================
const SYMBOL_OVERRIDES = {
  // 'kPEPE': 'PEPE_USDT',
};

function toMexcSymbol(hlSymbol) {
  const sym = hlSymbol.toUpperCase();
  return SYMBOL_OVERRIDES[sym] || `${sym}_USDT`;
}

const config = {
  wallets: WALLETS.map(w => w.toLowerCase()),
  toMexcSymbol,

  mexc: {
    apiKey: process.env.MEXC_API_KEY,
    apiSecret: process.env.MEXC_API_SECRET,
    baseURL: process.env.MEXC_BASE_URL || 'https://api.mexc.com'
  },

  telegram: {
    // публічний канал-джерело TWAP-сигналів, без @ і без посилання
    sourceChannel: process.env.TELEGRAM_SOURCE_CHANNEL || 'TWAPx',
    // читання через публічну preview-сторінку t.me/s/<channel>, без логіну/сесії
    pollIntervalMs: parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS || '1200')
  },

  // Наші власні сповіщення про угоди (окремий бот/чат, НЕ джерело сигналів)
  notify: {
    enabled: !!(process.env.NOTIFY_BOT_TOKEN && process.env.NOTIFY_CHAT_ID),
    token: process.env.NOTIFY_BOT_TOKEN,
    chatId: process.env.NOTIFY_CHAT_ID
  },

  trading: {
    dryRun: process.env.DRY_RUN === 'true',
    marginPercent: parseFloat(process.env.MARGIN_PERCENT || '10'),   // % депозиту -> маржа
    leverage: parseInt(process.env.LEVERAGE || '50'),
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '2'),
    openType: parseInt(process.env.OPEN_TYPE || '1'),                // 1 isolated, 2 cross
    positionMode: parseInt(process.env.POSITION_MODE || '1')         // 1 hedge (ОБОВ'ЯЗКОВО для протилежних TWAP на одному symbol)
  },

  monitoring: {
    // Рідкісна звірка локального стану з реальними позиціями на біржі
    reconcileIntervalMs: parseInt(process.env.RECONCILE_INTERVAL_MS || '60000')
  },

  db: {
    // /data — очікуваний mount-point Railway Volume
    path: process.env.DB_PATH || '/data/state.db',
    // Прибирати закриті записи старші за N годин, щоб volume не роздувався
    cleanupAfterHours: parseFloat(process.env.DB_CLEANUP_AFTER_HOURS || '48'),
    cleanupIntervalMs: parseInt(process.env.DB_CLEANUP_INTERVAL_MS || '3600000')
  },

  matching: {
    // Мінімальна різниця у score між топ-2 кандидатами для впевненого matching
    // (інакше — [MATCH AMBIGUOUS] в лог і вибір найкращого з попередженням)
    confidenceMargin: parseFloat(process.env.MATCH_CONFIDENCE_MARGIN || '0.15')
  }
};

if (config.wallets.length === 0) {
  throw new Error('config/wallets.js порожній — немає жодного гаманця для відстеження');
}
if (config.trading.marginPercent <= 0 || config.trading.marginPercent > 100) {
  throw new Error('MARGIN_PERCENT має бути між 0 і 100');
}
if (config.trading.leverage <= 0 || config.trading.leverage > 125) {
  throw new Error('LEVERAGE має бути між 1 і 125');
}
if (config.trading.positionMode !== 1) {
  // eslint-disable-next-line no-console
  console.warn('[CONFIG] ⚠️ POSITION_MODE != 1 (hedge) — протилежні TWAP на одному символі працюватимуть некоректно');
}

module.exports = config;
