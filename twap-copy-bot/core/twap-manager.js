const store = require('../db/store');
const config = require('../config/settings');
const walletFilter = require('./wallet-filter');
const logger = require('../utils/logger');

// ============================================================================
// Обробка CREATE-повідомлення: реєструє новий TwapEvent (TwapId ще невідомий).
// ============================================================================
function handleCreate(parsed, tgMessageId) {
  if (store.isMessageProcessed(tgMessageId)) return null;
  store.markMessageProcessed(tgMessageId);

  if (!walletFilter.resolveAndTrack(parsed.wallet)) return null;

  const mexcSymbol = config.toMexcSymbol(parsed.symbol);
  const event = store.createTwapEvent({
    wallet: parsed.wallet,
    symbol: parsed.symbol,
    mexcSymbol,
    direction: parsed.direction,
    notionalUsd: parsed.notionalUsd,
    priceAtCreation: parsed.priceAtCreation,
    plannedDurationSec: parsed.plannedDurationSec,
    createdAt: parsed.createdAt,
    tgMessageId
  });

  logger.info(
    `[NEW TWAP] Wallet: ${parsed.wallet} | Symbol: ${parsed.symbol} | Direction: ${parsed.direction} | ` +
    `Size: $${parsed.notionalUsd?.toFixed(0)} | Duration: ${parsed.plannedDurationSec}s | Entry~: ${parsed.priceAtCreation}`
  );

  return event;
}

// ============================================================================
// Обробка FINISH/TERMINATED-повідомлення: matching із відкритим TwapEvent.
//
// TwapId у цьому повідомленні Є, але в CREATE його не було — тому matching
// іде за wallet+symbol серед ще ВІДКРИТИХ TwapEvent (status='position_open'),
// з дискримінацією за очікуваною кількістю токенів (notional/price з CREATE
// проти total_size_tokens з FINISH) і, за нічиєї, за часовою близькістю.
// Це саме евристика, а не гарантія — якщо той самий wallet тримає два TWAP
// однакового напрямку й майже однакового розміру на тому самому symbol
// одночасно, 100% коректний matching неможливий у принципі (FINISH-
// повідомлення напряму не каже, який саме TWAP завершився, крім TwapId,
// якого при створенні не було). У такому випадку логуємо [MATCH AMBIGUOUS]
// з усіма кандидатами, щоб можна було перевірити вручну.
// ============================================================================
function handleFinish(parsed, tgMessageId) {
  if (store.isMessageProcessed(tgMessageId)) return null;
  store.markMessageProcessed(tgMessageId);

  if (!walletFilter.resolveAndTrack(parsed.wallet)) return null;

  const candidates = store.getOpenTwapCandidates(parsed.wallet, parsed.symbol);
  if (candidates.length === 0) {
    logger.warn(
      `[MATCH] Немає відкритого TWAP для wallet=${parsed.wallet} symbol=${parsed.symbol} ` +
      `(TwapId=${parsed.twapId}, можливо вже оброблено або сигнал пропущено)`
    );
    return null;
  }

  let matched;
  if (candidates.length === 1) {
    matched = candidates[0];
  } else {
    const scored = candidates.map(c => {
      const expectedQty = c.notional_usd / c.price_at_creation;
      const sizeDiff = Math.abs(expectedQty - parsed.totalSizeTokens) / parsed.totalSizeTokens;
      return { candidate: c, sizeDiff };
    }).sort((a, b) => a.sizeDiff - b.sizeDiff);

    matched = scored[0].candidate;
    const gap = scored.length > 1 ? (scored[1].sizeDiff - scored[0].sizeDiff) : Infinity;

    if (gap < config.matching.confidenceMargin) {
      logger.warn(
        `[MATCH AMBIGUOUS] wallet=${parsed.wallet} symbol=${parsed.symbol} TwapId=${parsed.twapId} — ` +
        `${candidates.length} відкритих кандидатів, різниця score замала (${gap.toFixed(3)}). ` +
        `Обрано найближчий за розміром: twapEventId=${matched.id} (created_at=${new Date(matched.created_at).toISOString()}). ` +
        `Перевір вручну.`
      );
    }
  }

  store.updateTwapEvent(matched.id, {
    twap_id: parsed.twapId,
    total_size_tokens: parsed.totalSizeTokens
  });

  return { event: store.getTwapEvent(matched.id), finishStatus: parsed.status, executedPercent: parsed.executedPercent };
}

module.exports = { handleCreate, handleFinish };
