const { parseMoneyShort, parseDurationToSeconds, parseTwapTimestampUtc, normalizeAddress } = require('../utils/helpers');

// ============================================================================
// Розпізнає два формати повідомлень каналу:
//  A) CREATE  — 🟩/🟥, сигнал відкриття TWAP (TwapId ЩЕ НЕВІДОМИЙ на цьому етапі)
//  B) FINISH  — ✅/❌, TWAP завершено/скасовано (тут TwapId вже є)
// Повертає { type: 'create'|'finish'|null, ...дані } — null, якщо текст не
// впізнано (лишаємо необроблено, а не кидаємо помилку — формат каналу може
// містити й інші типи повідомлень, які нас не стосуються).
// ============================================================================

function parseMessage(text, receivedAtMs = Date.now()) {
  if (!text) return { type: null };

  // КРИТИЧНО: перевіряємо finish/terminated ПЕРШИМ, незалежно від емодзі на
  // початку тексту. Причина: реальні finish/terminated повідомлення каналу,
  // судячи з усього, можуть повторно використовувати той самий заголовок
  // "$X покупка/продажа SYMBOL в течении Yч" (з тим самим 🟩/🟥ла початку),
  // що й CREATE-повідомлення про новий TWAP. Якщо перевіряти емодзі РАНІШЕ,
  // ніж "Статус: finished/terminated", бот сприймає завершення TWAP за НОВИЙ
  // TWAP і замість закриття відкриває позицію повторно — саме той баг, який
  // був знайдений у продакшені.
  if (/Статус:\s*(finished|terminated)/i.test(text) || /TWAP\s+(отменён|отменен|завершён|завершен)/i.test(text)) {
    return parseFinishMessage(text);
  }

  if (/^[🟩🟥]/.test(text.trim())) {
    return parseCreateMessage(text, receivedAtMs);
  }

  return { type: null };
}

function parseCreateMessage(text, receivedAtMs) {
  const isBuy = text.trim().startsWith('🟩');
  const isSell = text.trim().startsWith('🟥');
  if (!isBuy && !isSell) return { type: null };

  // 🟩 $220.01K покупка NEAR в течении 12.2 часа
  const headerMatch = text.match(/[🟩🟥]\s*\$?([\d.,]+[KMB]?)\s*(покупка|продажа|продаж)\s+([A-Za-z0-9]+)\s+в\s+течени[ие]\s+([\d.]+\s*\S+)/i);
  if (!headerMatch) return { type: null, error: 'header_not_matched' };

  const notionalUsd = parseMoneyShort(headerMatch[1]);
  const symbol = headerMatch[3].toUpperCase();
  const plannedDurationSec = parseDurationToSeconds(headerMatch[4]);

  const priceMatch = text.match(/Цена:\s*\$?([\d.,]+)/i);
  const walletMatch = text.match(/Субъект:\s*(0x[a-fA-F0-9]+)/i);
  const createdAtMatch = text.match(/Создан\s+в:\s*(\d{2}:\d{2}:\d{2})/i);

  if (!priceMatch || !walletMatch) return { type: null, error: 'fields_missing' };

  const priceAtCreation = parseFloat(priceMatch[1].replace(/,/g, ''));
  const createdAt = createdAtMatch
    ? parseTwapTimestampUtc(createdAtMatch[1], receivedAtMs)
    : receivedAtMs;

  return {
    type: 'create',
    direction: isBuy ? 'BUY' : 'SELL',
    symbol,
    notionalUsd,
    priceAtCreation,
    plannedDurationSec,
    wallet: normalizeAddress(walletMatch[1]),
    createdAt
  };
}

function parseFinishMessage(text) {
  const statusMatch = text.match(/Статус:\s*(finished|terminated)/i);
  const executedMatch = text.match(/Исполнено:\s*([\d.]+)\s*%/i);
  // Размер: 2293.00 / 28171.00 LIT
  const sizeMatch = text.match(/Размер:\s*([\d.,]+)\s*\/\s*([\d.,]+)\s*([A-Za-z0-9]+)/i);
  const twapIdMatch = text.match(/TwapId:\s*(\S+)/i);
  const walletMatch = text.match(/Субъект:\s*(0x[a-fA-F0-9]+)/i);

  if (!statusMatch || !sizeMatch || !walletMatch) return { type: null, error: 'fields_missing' };

  const status = statusMatch[1].toLowerCase(); // finished | terminated
  const executedPercent = executedMatch ? parseFloat(executedMatch[1]) : null;
  const totalSizeTokens = parseFloat(sizeMatch[2].replace(/,/g, ''));
  const symbol = sizeMatch[3].toUpperCase();

  return {
    type: 'finish',
    status,
    executedPercent,
    totalSizeTokens,
    symbol,
    twapId: twapIdMatch ? twapIdMatch[1] : null,
    wallet: normalizeAddress(walletMatch[1])
  };
}

module.exports = { parseMessage };
