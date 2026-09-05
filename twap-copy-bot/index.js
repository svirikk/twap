const config = require('./config/settings');
const logger = require('./utils/logger');

const mexc = require('./services/mexc.service');
const mexcUserStream = require('./services/mexc-user-stream.service');
const telegramListener = require('./services/telegram-listener.service');
const notifier = require('./services/notifier.service');

const messageParser = require('./core/message-parser');
const twapManager = require('./core/twap-manager');
const positionManager = require('./core/position-manager');

const BOT_BUILD = '2026-09-04-initial';

// ----------------------------------------------------------------------------
// Обробка вхідного повідомлення з TWAP-каналу.
// НАВМИСНО НЕ await-имо виклики position-manager тут: вхід має відбуватись
// максимально швидко (п.3 ТЗ), і обробка одного сигналу не повинна
// затримувати читання наступного повідомлення з каналу.
// ----------------------------------------------------------------------------
function handleIncomingMessage(msg) {
  let parsed;
  try {
    parsed = messageParser.parseMessage(msg.text, msg.date);
  } catch (error) {
    logger.error(`[PARSER] Не вдалось розпарсити повідомлення ${msg.id}: ${error.message}`);
    return;
  }

  if (parsed.type === 'create') {
    if (parsed.error) {
      logger.warn(`[PARSER] CREATE-подібне повідомлення не розпізнано повністю (${parsed.error}), msgId=${msg.id}`);
      return;
    }
    const event = twapManager.handleCreate(parsed, msg.id);
    if (event) {
      positionManager.openForTwap(event).catch(err =>
        logger.error(`[ORCHESTRATOR] openForTwap fatal (${event.id}): ${err.message}`)
      );
    }
    return;
  }

  if (parsed.type === 'finish') {
    if (parsed.error) {
      logger.warn(`[PARSER] FINISH-подібне повідомлення не розпізнано повністю (${parsed.error}), msgId=${msg.id}`);
      return;
    }
    const result = twapManager.handleFinish(parsed, msg.id);
    if (result) {
      positionManager.handleTwapClosed(result).catch(err =>
        logger.error(`[ORCHESTRATOR] handleTwapClosed fatal (${result.event.id}): ${err.message}`)
      );
    }
    return;
  }

  // Інший тип повідомлення каналу — не наш формат, ігноруємо мовчки.
}

async function start() {
  console.log('='.repeat(70));
  console.log('HYPERLIQUID -> MEXC TWAP COPY-TRADING BOT');
  console.log(`Build: ${BOT_BUILD}`);
  console.log('='.repeat(70));
  console.log(`Гаманців у whitelist: ${config.wallets.length}`);
  console.log(`Маржа: ${config.trading.marginPercent}% депозиту | Плече: ${config.trading.leverage}x | TP: +${config.trading.takeProfitPercent}%`);
  console.log(`Position mode: ${config.trading.positionMode === 1 ? 'hedge' : 'one-way'} | Open type: ${config.trading.openType === 1 ? 'isolated' : 'cross'}`);
  console.log(`DRY RUN: ${config.trading.dryRun ? 'УВІМКНЕНО' : 'вимкнено — ЖИВА ТОРГІВЛЯ'}`);
  console.log(`Джерело сигналів: Telegram канал "${config.telegram.sourceChannel}"`);
  console.log(`SQLite: ${config.db.path}`);
  console.log('='.repeat(70));

  try {
    await mexc.connect();
  } catch (error) {
    logger.error(`[MEXC] Не вдалось підключитись: ${error.message}`);
    if (!config.trading.dryRun) process.exit(1);
  }

  // Відновлення стану ПЕРЕД тим, як почати слухати нові повідомлення —
  // інакше нове й старе оброблялось би впереміш.
  await positionManager.recoverOnStartup();

  positionManager.startReconciliation();
  positionManager.startCleanupLoop();

  if (!config.trading.dryRun) {
    positionManager.wireExchangePushMonitor();
    mexcUserStream.setOnAuthFailed(() => {
      notifier.notifyError('MEXC WS user-stream auth', new Error('Не вдалось авторизуватись — перевір права API-ключа (Futures Trading)'));
    });
    mexcUserStream.connect();
  }

  telegramListener.setOnMessage(handleIncomingMessage);
  await telegramListener.start();

  await notifier.notifyStartup(
    `🚀 <b>TWAP copy-bot запущено</b>\n\nBuild: <code>${BOT_BUILD}</code>\n` +
    `Гаманців: ${config.wallets.length}\nРежим: ${config.trading.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`
  );

  const shutdown = async (signal) => {
    logger.info(`[SHUTDOWN] Отримано ${signal}, зупиняюсь...`);
    try {
      await telegramListener.stop();
      mexcUserStream.close();
      await notifier.notifyStartup('⛔ Бот зупинено');
    } catch (_) {}
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start().catch(error => {
    logger.error(`[FATAL] ${error.message}\n${error.stack}`);
    process.exit(1);
  });
}

module.exports = { start, handleIncomingMessage };
