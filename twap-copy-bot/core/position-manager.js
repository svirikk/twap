const mexc = require('../services/mexc.service');
const mexcUserStream = require('../services/mexc-user-stream.service');
const notifier = require('../services/notifier.service');
const store = require('../db/store');
const config = require('../config/settings');
const logger = require('../utils/logger');
const { floorToStep, roundToTick, isValidNumber } = require('../utils/helpers');

// ============================================================================
// TP: біржовий, прикріплений інлайн при відкритті (openMarketOrderWithProtection).
// Виявлення спрацювання — через приватний WS (push.personal.position, state=3),
// не через власний REST-поллінг ціни.
//
// Кілька TWAP одного wallet+symbol+side можуть злитись MEXC в одну позицію —
// тоді TP спрацює на всю позицію одразу, не окремо по частці кожного TWAP.
// За явним рішенням користувача це прийнятний компроміс заради простоти й
// надійності біржового тригера (замість затримки й складності власного
// REST-поллінгу ціни). Деталі — коментар над mexc.service.openMarketOrderWithProtection.
// ============================================================================

const STALE_CREATE_MS = 15000; // TWAP-сигнали старші за це при рестарті вважаються простроченими для входу

let reconcileInterval = null;

function computeSizing(balance, entryPrice, contractInfo) {
  if (!isValidNumber(balance) || balance <= 0) throw new Error(`Invalid balance: ${balance}`);
  if (!isValidNumber(entryPrice) || entryPrice <= 0) throw new Error(`Invalid entry price: ${entryPrice}`);

  const { marginPercent, leverage } = config.trading;
  const marginUsd = balance * (marginPercent / 100);
  const notionalUsd = marginUsd * leverage;

  const qtyBase = notionalUsd / entryPrice;
  let contracts = floorToStep(qtyBase / contractInfo.contractSize, contractInfo.volUnit);

  if (contracts < contractInfo.minVol) contracts = contractInfo.minVol;
  if (contracts > contractInfo.maxVol) contracts = contractInfo.maxVol;

  const actualNotionalUsd = contracts * contractInfo.contractSize * entryPrice;
  const actualMarginUsd = actualNotionalUsd / leverage;

  if (actualMarginUsd > balance) {
    throw new Error(`Недостатньо балансу навіть для мін. лоту: потрібно ${actualMarginUsd.toFixed(2)} USDT, є ${balance.toFixed(2)} USDT`);
  }

  return { contracts, marginUsd: actualMarginUsd, notionalUsd: actualNotionalUsd, leverage };
}

function computeTpPrice(entryPrice, direction, priceUnit) {
  const pct = config.trading.takeProfitPercent / 100;
  const raw = direction === 'LONG' ? entryPrice * (1 + pct) : entryPrice * (1 - pct);
  return roundToTick(raw, priceUnit);
}

async function waitForFill(orderId, attempts = 15, intervalMs = 250) {
  for (let i = 0; i < attempts; i++) {
    const order = await mexc.getOrder(orderId);
    if (order && parseFloat(order.dealVol) > 0 && (order.state === 3 || parseFloat(order.dealVol) >= parseFloat(order.vol))) {
      return order;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return mexc.getOrder(orderId);
}

// ---------------------------------------------------------------------
// Відкриття позиції по НОВОМУ TWAP-сигналу
// ---------------------------------------------------------------------
async function openForTwap(twapEvent) {
  // Ідемпотентність: якщо вже є opening/open позиція під цей twapEvent — не дублюємо
  const existing = store.getOpenPositionsForTwap(twapEvent.id);
  if (existing.length > 0) {
    logger.warn(`[POSITION] Позиція для TWAP ${twapEvent.id} вже існує (${existing[0].status}) — пропускаю повторне відкриття`);
    return;
  }

  const direction = twapEvent.direction === 'BUY' ? 'LONG' : 'SHORT';
  const mexcSymbol = twapEvent.mexc_symbol;

  let contractInfo;
  try {
    contractInfo = await mexc.getContractDetail(mexcSymbol);
  } catch (error) {
    logger.error(`[TRADE OPENED] ${mexcSymbol} — символ недоступний на MEXC: ${error.message}`);
    store.updateTwapEvent(twapEvent.id, { status: 'error' });
    await notifier.notifyError(`Символ ${mexcSymbol} недоступний на MEXC`, error);
    return;
  }

  // Локальний запис СТВОРЮЄМО ДО виклику біржі (status='opening') — щоб при
  // краші процесу між викликом і підтвердженням рестарт міг звірити стан
  // з біржею, а не загубити слід угоди (п.10 ТЗ).
  const positionRow = store.createPosition({
    twapEventId: twapEvent.id,
    symbol: twapEvent.symbol,
    mexcSymbol,
    direction,
    marginUsd: 0,
    leverage: config.trading.leverage,
    notionalUsd: 0,
    qty: 0,
    status: 'opening'
  });

  try {
    const balance = config.trading.dryRun
      ? parseFloat(process.env.DRY_RUN_BALANCE || '1000')
      : await mexc.getUSDTBalance();

    if (!balance || balance <= 0) throw new Error(`Нульовий/недоступний баланс USDT (${balance})`);

    const ticker = await mexc.getTicker(mexcSymbol);
    const entryPriceEstimate = ticker.lastPrice;
    const sizing = computeSizing(balance, entryPriceEstimate, contractInfo);

    if (config.trading.dryRun) {
      const entryPrice = roundToTick(entryPriceEstimate, contractInfo.priceUnit);
      const tpPrice = computeTpPrice(entryPrice, direction, contractInfo.priceUnit);
      store.updatePosition(positionRow.id, {
        margin_usd: sizing.marginUsd, notional_usd: sizing.notionalUsd, qty: sizing.contracts,
        entry_price: entryPrice, tp_price: tpPrice, status: 'open',
        mexc_position_id: `DRY_${positionRow.id}`, opened_at: Date.now()
      });
      store.claimTwapStatus(twapEvent.id, ['created'], 'position_open');
      logSummary('[TRADE OPENED][DRY RUN]', mexcSymbol, direction, sizing, entryPrice, tpPrice);
      await notifier.notifyOpened({ symbol: mexcSymbol, direction, ...sizing, entryPrice, tpPrice, dryRun: true });
      return;
    }

    const positionType = direction === 'LONG' ? 1 : 2;
    const side = direction === 'LONG' ? 1 : 3;

    await mexc.setLeverage({ symbol: mexcSymbol, leverage: config.trading.leverage, openType: config.trading.openType, positionType });

    const order = await mexc.openMarketOrderWithProtection({
      symbol: mexcSymbol, side, vol: sizing.contracts, leverage: config.trading.leverage,
      openType: config.trading.openType, price: entryPriceEstimate, positionMode: config.trading.positionMode,
      takeProfitPrice: computeTpPrice(entryPriceEstimate, direction, contractInfo.priceUnit)
    });

    store.updatePosition(positionRow.id, { entry_order_id: order.orderId });

    const filled = await waitForFill(order.orderId);
    if (!filled || parseFloat(filled.dealVol) <= 0) {
      throw new Error(`Ордер ${order.orderId} не заповнився (price-protection чи брак ліквідності)`);
    }

    const entryPrice = parseFloat(filled.dealAvgPrice);
    const qty = parseFloat(filled.dealVol);
    const tpPrice = computeTpPrice(entryPrice, direction, contractInfo.priceUnit);

    store.updatePosition(positionRow.id, {
      margin_usd: sizing.marginUsd, notional_usd: sizing.notionalUsd, qty,
      entry_price: entryPrice, mexc_position_id: filled.positionId, tp_price: tpPrice,
      status: 'open', opened_at: Date.now()
    });
    store.claimTwapStatus(twapEvent.id, ['created'], 'position_open');

    logSummary('[TRADE OPENED]', mexcSymbol, direction, { ...sizing, contracts: qty }, entryPrice, tpPrice);
    await notifier.notifyOpened({ symbol: mexcSymbol, direction, ...sizing, contracts: qty, entryPrice, tpPrice, dryRun: false });
  } catch (error) {
    logger.error(`[TRADE OPENED] Помилка відкриття ${mexcSymbol}: ${error.message}`);
    store.updatePosition(positionRow.id, { status: 'error' });
    store.updateTwapEvent(twapEvent.id, { status: 'error' });
    await notifier.notifyError(`Відкриття позиції ${mexcSymbol} ${direction}`, error);
  }
}

function logSummary(tag, symbol, direction, sizing, entryPrice, tpPrice) {
  logger.info(
    `${tag} Symbol: ${symbol} | Direction: ${direction} | Size: ${sizing.contracts} | ` +
    `Entry price: ${entryPrice} | Leverage: ${config.trading.leverage}x | Margin: $${sizing.marginUsd.toFixed(2)} | TP: ${tpPrice}`
  );
}

// ---------------------------------------------------------------------
// Закриття однієї позиції (reduce-only, САМЕ на її qty)
// ---------------------------------------------------------------------
async function closePosition(positionRow, reason, exitPriceHint = null) {
  if (!store.claimPositionClosing(positionRow.id)) {
    return; // вже закривається/закрито іншим шляхом (TP-loop vs finish-message race)
  }

  const twapEvent = store.getTwapEvent(positionRow.twap_event_id);

  try {
    let exitPrice, pnl;

    if (config.trading.dryRun) {
      const ticker = exitPriceHint ? null : await mexc.getTicker(positionRow.mexc_symbol);
      exitPrice = exitPriceHint || ticker.lastPrice;
      const diff = positionRow.direction === 'LONG' ? (exitPrice - positionRow.entry_price) : (positionRow.entry_price - exitPrice);
      pnl = diff * positionRow.qty;
    } else {
      // Захист від закриття більше, ніж реально лишилось на біржі (якщо
      // частину вже закрито іншим шляхом — ліквідація, ручна дія тощо)
      const exchangePositions = await mexc.getOpenPositions(positionRow.mexc_symbol);
      const side = positionRow.direction === 'LONG' ? 1 : 2;
      const existing = exchangePositions.find(p => String(p.positionId) === String(positionRow.mexc_position_id) && p.positionType === side);
      const availableVol = existing ? parseFloat(existing.holdVol) : 0;

      if (availableVol <= 0) {
        logger.warn(`[${reason.toUpperCase()}] ${positionRow.mexc_symbol}: позиція вже відсутня на біржі — фіналізую локально без реального ордера`);
        exitPrice = null;
        pnl = null;
      } else {
        const closeVol = Math.min(positionRow.qty, availableVol);
        const ticker = await mexc.getTicker(positionRow.mexc_symbol);
        const closeOrder = await mexc.closePositionMarket({
          symbol: positionRow.mexc_symbol, direction: positionRow.direction, vol: closeVol, price: ticker.lastPrice
        });
        const filled = await waitForFill(closeOrder.orderId);
        exitPrice = filled && filled.dealAvgPrice ? parseFloat(filled.dealAvgPrice) : ticker.lastPrice;
        const diff = positionRow.direction === 'LONG' ? (exitPrice - positionRow.entry_price) : (positionRow.entry_price - exitPrice);
        pnl = diff * closeVol;
      }
    }

    store.updatePosition(positionRow.id, {
      status: 'closed', close_reason: reason, exit_price: exitPrice, pnl, closed_at: Date.now()
    });

    const twapCloseStatus = reason === 'tp' ? 'closed_tp' : (reason === 'twap_terminated' ? 'closed_terminated' : 'closed_finished');
    store.claimTwapStatus(twapEvent.id, ['position_open'], twapCloseStatus);

    const logTag = reason === 'tp' ? '[TP]' : (reason === 'twap_terminated' ? '[TWAP TERMINATED]' : '[TWAP FINISHED]');
    logger.info(
      `${logTag} Symbol: ${positionRow.mexc_symbol} | TwapId: ${twapEvent.twap_id || '—'} | Entry: ${positionRow.entry_price} | ` +
      `Exit: ${exitPrice ?? '—'} | PnL: ${pnl != null ? pnl.toFixed(2) : '—'}`
    );
    await notifier.notifyClosed({ symbol: positionRow.mexc_symbol, direction: positionRow.direction, reason, entryPrice: positionRow.entry_price, exitPrice, pnl });
  } catch (error) {
    logger.error(`[CLOSE] Помилка закриття ${positionRow.mexc_symbol} (${reason}): ${error.message}`);
    store.updatePosition(positionRow.id, { status: 'error' });
    await notifier.notifyError(`Закриття позиції ${positionRow.mexc_symbol} (${reason})`, error);
  }
}

// ---------------------------------------------------------------------
// Виклик з twap-manager.handleFinish(): TWAP finished/terminated -> закрити
// відповідну позицію MARKET, незалежно від % виконання і незалежно від TP.
// Якщо позиція вже закрита по TP до цього моменту — twap-manager її вже не
// знайде серед кандидатів (статус більше не 'position_open'), тому сюди
// такий випадок і не потрапляє: ідемпотентність через сам matching-шар.
// ---------------------------------------------------------------------
async function handleTwapClosed({ event, finishStatus }) {
  const positions = store.getOpenPositionsForTwap(event.id).filter(p => p.status === 'open');
  const reason = finishStatus === 'terminated' ? 'twap_terminated' : 'twap_finished';

  if (positions.length === 0) {
    // Малоймовірна гонка: TP закрив позицію між matching і цим викликом.
    store.claimTwapStatus(event.id, ['position_open'], reason === 'twap_terminated' ? 'closed_terminated' : 'closed_finished');
    return;
  }

  for (const p of positions) {
    await closePosition(p, reason);
  }
}

// ---------------------------------------------------------------------
// Приватний WS: детекція повного закриття позиції (найчастіше — спрацював
// біржовий TP; також ліквідація чи ручна дія в UI MEXC потрапляють сюди ж,
// цей push не розрізняє причину). ПРИМІТКА: якщо кілька TWAP ділять один
// ділять один mexc_position_id, точний PnL по кожному окремому рядку тут
// оцінюється пропорційно до його qty — це наближення, а не точна цифра з
// біржі (сама біржа не розрізняє наші TWAP-легенди всередині однієї позиції).
// ---------------------------------------------------------------------
function wireExchangePushMonitor() {
  mexcUserStream.setOnPositionUpdate((data) => {
    if (data.state !== 3) return; // цікавить лише повне закриття
    const rows = store.getAllOpenPositions().filter(p => String(p.mexc_position_id) === String(data.positionId));
    if (rows.length === 0) return;

    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    const exitPrice = parseFloat(data.closeAvgPrice);
    const totalPnl = parseFloat(data.closeProfitLoss ?? data.realised ?? 0);

    logger.info(`[TP] Позиція ${data.positionId} закрита біржею (push, state=3) — найімовірніше спрацював TP; фіналізую ${rows.length} пов'язаних записів (пропорційно, якщо їх декілька на цій позиції)`);

    for (const row of rows) {
      if (!store.claimPositionClosing(row.id)) continue;
      const share = totalQty > 0 ? row.qty / totalQty : 1 / rows.length;
      const pnlShare = totalPnl * share;
      store.updatePosition(row.id, {
        status: 'closed', close_reason: 'tp', exit_price: exitPrice,
        pnl: pnlShare, closed_at: Date.now()
      });
      const twapEvent = store.getTwapEvent(row.twap_event_id);
      if (twapEvent) store.claimTwapStatus(twapEvent.id, ['position_open'], 'closed_tp');
      logger.info(`[TP] Symbol: ${row.mexc_symbol} | TwapId: ${twapEvent?.twap_id || '—'} | Entry: ${row.entry_price} | Exit: ${exitPrice} | PnL: ${pnlShare.toFixed(2)}`);
      notifier.notifyClosed({ symbol: row.mexc_symbol, direction: row.direction, reason: 'tp', entryPrice: row.entry_price, exitPrice, pnl: pnlShare }).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------
// Рідкісна звірка: сума локальних "open" qty по symbol+side vs holdVol на
// біржі. Розбіжність — це попередження для ручної перевірки, а не
// автоматичний ремонт: без додаткових даних неможливо надійно вгадати, ЯКИЙ
// саме TWAP-рядок відповідає за розбіжність, якщо їх декілька на symbol+side.
// ---------------------------------------------------------------------
async function reconcileTick() {
  if (config.trading.dryRun) return;
  const openPositions = store.getAllOpenPositions();
  if (openPositions.length === 0) return;

  const groups = new Map(); // "symbol|direction" -> rows
  for (const p of openPositions) {
    const key = `${p.mexc_symbol}|${p.direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  for (const [key, rows] of groups.entries()) {
    const [symbol, direction] = key.split('|');
    try {
      const exchangePositions = await mexc.getOpenPositions(symbol);
      const side = direction === 'LONG' ? 1 : 2;
      const existing = exchangePositions.find(p => p.positionType === side);
      const actualVol = existing ? parseFloat(existing.holdVol) : 0;
      const expectedVol = rows.reduce((s, r) => s + r.qty, 0);

      if (Math.abs(actualVol - expectedVol) > 1e-9) {
        logger.warn(
          `[RECONCILE] Розбіжність ${symbol} ${direction}: очікували ${expectedVol}, на біржі ${actualVol} ` +
          `(${rows.length} локальних відкритих записів: ${rows.map(r => r.id).join(', ')}) — потребує ручної перевірки`
        );
      }
    } catch (error) {
      logger.error(`[RECONCILE] ${symbol}: ${error.message}`);
    }
  }
}

function startReconciliation() {
  if (reconcileInterval) return;
  reconcileInterval = setInterval(() => {
    reconcileTick().catch(err => logger.error(`[RECONCILE] loop error: ${err.message}`));
  }, config.monitoring.reconcileIntervalMs);
}

// ---------------------------------------------------------------------
// Відновлення стану після рестарту процесу
// ---------------------------------------------------------------------
async function recoverOnStartup() {
  const openEvents = store.getAllOpenTwapEvents();
  logger.info(`[RECOVERY] Знайдено ${openEvents.length} незакритих TWAP-подій у БД`);

  for (const event of openEvents) {
    const positions = store.getOpenPositionsForTwap(event.id);

    if (positions.length === 0 && event.status === 'created') {
      // Позицію ще не встигли відкрити до рестарту.
      const age = Date.now() - event.created_at;
      if (age > STALE_CREATE_MS) {
        logger.warn(`[RECOVERY] TWAP ${event.id} (${event.symbol}) застарів (${Math.round(age / 1000)}с) — пропускаю вхід`);
        store.updateTwapEvent(event.id, { status: 'ignored' });
      } else {
        logger.info(`[RECOVERY] TWAP ${event.id} (${event.symbol}) свіжий — відкриваю позицію як зазвичай`);
        await openForTwap(event);
      }
      continue;
    }

    for (const p of positions) {
      if (p.status === 'opening') {
        await reconcileOpeningPosition(p);
      }
      // status === 'open' / 'closing' — далі підхоплюється TP-монітором і
      // reconcile-loop автоматично, нічого додатково робити не треба.
    }
  }
}

async function reconcileOpeningPosition(positionRow) {
  logger.warn(`[RECOVERY] Позиція ${positionRow.id} (${positionRow.mexc_symbol}) була в статусі 'opening' на момент краху — звіряю з біржею`);
  try {
    if (positionRow.entry_order_id) {
      const order = await mexc.getOrder(positionRow.entry_order_id);
      if (order && parseFloat(order.dealVol) > 0) {
        const entryPrice = parseFloat(order.dealAvgPrice);
        const tpPrice = computeTpPrice(entryPrice, positionRow.direction, 0.0001);
        store.updatePosition(positionRow.id, {
          status: 'open', entry_price: entryPrice, qty: parseFloat(order.dealVol),
          mexc_position_id: order.positionId, tp_price: tpPrice, opened_at: Date.now()
        });
        store.claimTwapStatus(positionRow.twap_event_id, ['created'], 'position_open');
        logger.info(`[RECOVERY] Позиція ${positionRow.id} підтверджена як відкрита на біржі`);
        return;
      }
    }
    logger.warn(`[RECOVERY] Позиція ${positionRow.id} не підтверджена на біржі — позначаю error`);
    store.updatePosition(positionRow.id, { status: 'error' });
    store.updateTwapEvent(positionRow.twap_event_id, { status: 'error' });
  } catch (error) {
    logger.error(`[RECOVERY] Не вдалось звірити ${positionRow.id}: ${error.message}`);
  }
}

function startCleanupLoop() {
  setInterval(() => {
    try { store.cleanupOld(); } catch (err) { logger.error(`[DB] cleanup error: ${err.message}`); }
  }, config.db.cleanupIntervalMs);
}

module.exports = {
  openForTwap, handleTwapClosed, startReconciliation,
  wireExchangePushMonitor, recoverOnStartup, startCleanupLoop, computeSizing
};
