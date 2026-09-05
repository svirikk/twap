const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/settings');
const logger = require('../utils/logger');

// ============================================================================
// Сповіщення про НАШІ угоди в окремий чат/бот. Це не той самий канал, звідки
// читаються TWAP-сигнали (services/telegram-listener.service.js) — джерело
// і сповіщення навмисно розділені, щоб не змішувати вхід і вихід.
// Якщо NOTIFY_BOT_TOKEN/NOTIFY_CHAT_ID не задані — просто нічого не шле
// (лишаються лише консольні логи), решта бота працює як завжди.
// ============================================================================

const bot = config.notify.enabled ? new TelegramBot(config.notify.token, { polling: false }) : null;

async function send(text) {
  if (!bot) return;
  try {
    await bot.sendMessage(config.notify.chatId, text, { parse_mode: 'HTML' });
  } catch (error) {
    logger.error(`[NOTIFY] Send error: ${error.message}`);
  }
}

async function notifyOpened(p) {
  const emoji = p.direction === 'LONG' ? '📈' : '📉';
  await send(
    `✅ <b>ПОЗИЦІЮ ВІДКРИТО</b>${p.dryRun ? ' 🧪' : ''}\n\n` +
    `<b>Символ:</b> ${p.symbol}\n<b>Напрямок:</b> ${emoji} ${p.direction}\n` +
    `<b>Розмір:</b> ${p.contracts}\n<b>Ціна входу:</b> $${p.entryPrice}\n` +
    `<b>Плече:</b> ${p.leverage}x\n<b>Маржа:</b> $${p.marginUsd.toFixed(2)}\n` +
    `🎯 <b>TP:</b> $${p.tpPrice}`
  );
}

async function notifyClosed(p) {
  const isProfit = (p.pnl ?? 0) >= 0;
  const emoji = isProfit ? '🟢' : '🔴';
  const reasonLabels = { tp: 'TP', twap_finished: 'TWAP finished', twap_terminated: 'TWAP terminated', external: 'зовнішнє закриття' };
  await send(
    `${emoji} <b>ПОЗИЦІЮ ЗАКРИТО (${reasonLabels[p.reason] || p.reason})</b>\n\n` +
    `<b>Символ:</b> ${p.symbol}\n<b>Напрямок:</b> ${p.direction}\n` +
    `<b>Вхід:</b> $${p.entryPrice} → <b>Вихід:</b> $${p.exitPrice ?? '—'}\n` +
    `<b>PnL:</b> ${p.pnl != null ? (p.pnl >= 0 ? '+' : '') + '$' + p.pnl.toFixed(2) : '—'}`
  );
}

async function notifyError(context, error) {
  logger.error(`[NOTIFY] ${context}: ${error.message}`);
  await send(`❌ <b>ПОМИЛКА</b>\n\n<b>Де:</b> ${context}\n<b>Деталі:</b> ${error.message}`);
}

async function notifyStartup(text) {
  await send(text);
}

module.exports = { send, notifyOpened, notifyClosed, notifyError, notifyStartup };
