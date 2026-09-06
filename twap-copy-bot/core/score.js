const store = require('../db/store');

// ============================================================================
// "Score" для сповіщень — ЛИШЕ інформаційний контекст, ніде не впливає на
// логіку відкриття/закриття позицій (openForTwap/closePosition його не
// читають).
//
// Автор TWAP-каналу показує власний "рейтинг петушары" з даними, яких у нас
// немає (капіталізація, обʼєм ринку, повна історія гаманця за весь час
// тощо) — вигадувати псевдонауковий аналог такого скору було б чесно кажучи
// оманливим. Натомість беремо ОДНУ реальну метрику, яку ми справді можемо
// коректно порахувати з власної БД: наскільки цей TWAP більший/менший за
// середній розмір цього ж гаманця на цій же монеті (за останні
// DB_CLEANUP_AFTER_HOURS годин — довше історію ми не зберігаємо).
// ============================================================================

function buildSizeContext(twapEvent) {
  const stats = store.getWalletSymbolHistory(twapEvent.wallet, twapEvent.symbol, twapEvent.id);
  const durationHours = twapEvent.planned_duration_sec ? (twapEvent.planned_duration_sec / 3600) : null;

  if (!stats || !stats.cnt || !stats.avgNotional) {
    return {
      durationHours,
      label: '🆕 Перший TWAP цього гаманця на цій монеті за останній час — нема з чим порівняти'
    };
  }

  const ratio = twapEvent.notional_usd / stats.avgNotional;
  let label;
  if (ratio >= 3) {
    label = `🔥 У ${ratio.toFixed(1)}x більший за середній розмір цього гаманця на ${twapEvent.symbol}`;
  } else if (ratio <= 0.4) {
    label = `🔹 У ${(1 / ratio).toFixed(1)}x менший за середній розмір цього гаманця на ${twapEvent.symbol}`;
  } else {
    label = `Стандартний розмір для цього гаманця на ${twapEvent.symbol} (~${ratio.toFixed(1)}x середнього)`;
  }

  return { durationHours, label, ratio, sampleSize: stats.cnt };
}

module.exports = { buildSizeContext };
