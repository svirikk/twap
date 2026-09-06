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

// Повертає message_id надісланого повідомлення (для reply-tagging закриття
// до відповідного відкриття) або null, якщо сповіщення вимкнені/не вдались.
async function send(text, { replyToMessageId = null } = {}) {
  if (!bot) return null;
  try {
    const opts = { parse_mode: 'HTML' };
    if (replyToMessageId) opts.reply_to_message_id = replyToMessageId;
    const sent = await bot.sendMessage(config.notify.chatId, text, opts);
    return sent.message_id;
  } catch (error) {
    logger.error(`[NOTIFY] Send error: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// ВІДКРИТТЯ. Головне — направо видно одразу: напрямок, монета, сума в USDT.
// Контекст розміру (score) — чисто інформаційний блок унизу, ніде далі в
// коді не читається для торгових рішень (див. core/score.js).
// ---------------------------------------------------------------------
async function notifyOpened(p) {
  const emoji = p.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
  const lines = [
    `${p.dryRun ? '🧪 ' : ''}✅ <b>ПОЗИЦІЯ ВІДКРИТА</b>`,
    ``,
    `${emoji} <b>${p.symbol}</b> — сума: <b>$${p.notionalUsd.toFixed(0)}</b>`,
    ``,
    `Ціна входу: $${p.entryPrice}`,
    `Маржа: $${p.marginUsd.toFixed(2)} · Плече: ${p.leverage}x`,
    `🎯 TP: $${p.tpPrice}`
  ];

  if (p.sizeContext) {
    lines.push(``, `<i>ℹ️ ${p.sizeContext.label}</i>`);
    if (p.sizeContext.durationHours != null) {
      lines.push(`<i>⏱ Тривалість TWAP: ${p.sizeContext.durationHours.toFixed(1)}г</i>`);
    }
  }

  return send(lines.join('\n'));
}

// ---------------------------------------------------------------------
// ЗАКРИТТЯ. reply_to_message_id прив'язує це повідомлення до відповідного
// "ВІДКРИТА" в тому ж треді. Тег чітко розділяє: закрито САМИМ БОТОМ
// (по сигналу з каналу чи по TP) проти закрито ВРУЧНУ на біржі поза ботом.
// ---------------------------------------------------------------------
const CLOSE_TAGS = {
  tp: '🎯 TP',
  twap_finished: '🏁 TWAP завершився (сигнал з каналу)',
  twap_terminated: '🛑 TWAP скасовано (сигнал з каналу)',
  manual_external: '👋 Закрито вручну (поза ботом)'
};

async function notifyClosed(p) {
  const isProfit = (p.pnl ?? 0) >= 0;
  const emoji = p.pnl != null ? (isProfit ? '🟢' : '🔴') : '⚪️';
  const tag = CLOSE_TAGS[p.reason] || p.reason;
  const isManual = p.reason === 'manual_external';

  const lines = [
    `${emoji} <b>ПОЗИЦІЮ ЗАКРИТО</b> — ${tag}`,
    ``,
    `${p.symbol} · ${p.direction}`,
    `Вхід: $${p.entryPrice} → Вихід: ${p.exitPrice != null ? '$' + p.exitPrice : 'невідомо'}`,
    `PnL: ${p.pnl != null ? (p.pnl >= 0 ? '+' : '') + '$' + p.pnl.toFixed(2) : 'невідомо' + (isManual ? ' (закрито поза ботом — перевір на біржі)' : '')}`
  ];

  return send(lines.join('\n'), { replyToMessageId: p.replyToMessageId });
}

async function notifyError(context, error) {
  logger.error(`[NOTIFY] ${context}: ${error.message}`);
  await send(`❌ <b>ПОМИЛКА</b>\n\n<b>Де:</b> ${context}\n<b>Деталі:</b> ${error.message}`);
}

async function notifyStartup(text) {
  await send(text);
}

module.exports = { send, notifyOpened, notifyClosed, notifyError, notifyStartup };
