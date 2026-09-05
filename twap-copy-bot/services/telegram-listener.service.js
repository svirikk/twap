const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/settings');
const logger = require('../utils/logger');

// ============================================================================
// TELEGRAM LISTENER — HTTP-поллінг публічної preview-сторінки t.me/s/<channel>
// Без логіну, без сесії, без API ID/HASH. Простіше за MTProto-варіант, ціна —
// затримка ≈POLL_INTERVAL_MS (Telegram не гарантує, наскільки швидко ця
// сторінка оновлюється) і те, що видно лише ~20 останніх повідомлень —
// довгий простій бота може означати непомітний пропуск сигналу.
//
// НА СТАРТІ бот НЕ обробляє історію, яку бачить на сторінці вперше — лише
// фіксує baseline (найбільший message id) і далі реагує на повідомлення
// СТРОГО новіші за момент запуску. Це навмисно: відкривати позицію по
// TWAP-сигналу, якому вже, скажімо, 10 хвилин (з попередньої історії
// сторінки), суперечить самій ідеї "максимально швидкого" копіювання.
// ============================================================================

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class TelegramListener {
  constructor() {
    this.onMessageCallback = null;
    this.pollTimer = null;
    this.lastSeenId = null;
    this.stopped = false;
  }

  setOnMessage(fn) {
    this.onMessageCallback = fn;
  }

  _url() {
    return `https://t.me/s/${config.telegram.sourceChannel}`;
  }

  async _fetchMessages() {
    const res = await axios.get(this._url(), {
      timeout: 8000,
      headers: { 'User-Agent': BROWSER_UA, 'Cache-Control': 'no-cache' }
    });

    const $ = cheerio.load(res.data);
    const messages = [];

    $('.tgme_widget_message[data-post]').each((_, el) => {
      const dataPost = $(el).attr('data-post'); // "channelname/12345"
      const idPart = dataPost ? dataPost.split('/').pop() : null;
      const id = idPart ? parseInt(idPart, 10) : null;
      if (!id) return;

      const textEl = $(el).find('.tgme_widget_message_text').first();
      if (!textEl.length) return; // повідомлення без тексту (лише медіа тощо) — не наш формат

      // <br> -> \n перед вилученням тексту, інакше багаторядкові повідомлення злипнуться в один рядок
      textEl.find('br').replaceWith('\n');
      const text = textEl.text().replace(/\u00a0/g, ' ').trim();

      const timeAttr = $(el).find('time.time').first().attr('datetime');
      const date = timeAttr ? Date.parse(timeAttr) : Date.now();

      messages.push({ id, text, date });
    });

    messages.sort((a, b) => a.id - b.id);
    return messages;
  }

  async _pollOnce() {
    let messages;
    try {
      messages = await this._fetchMessages();
    } catch (error) {
      logger.error(`[TG-LISTENER] Помилка запиту до ${this._url()}: ${error.message}`);
      return;
    }

    this._pollCount = (this._pollCount || 0) + 1;
    const maxIdOnPage = messages.length ? messages[messages.length - 1].id : null;
    logger.debug(`[TG-LISTENER] poll #${this._pollCount}: отримано ${messages.length} повідомлень зі сторінки, max_id_на_сторінці=${maxIdOnPage}, lastSeenId=${this.lastSeenId}`);

    // Heartbeat раз на ~60 полів (незалежно від DEBUG), щоб було видно живий
    // процес і те, чи max_id на сторінці взагалі рухається з часом.
    if (this._pollCount % 60 === 0) {
      logger.info(`[TG-LISTENER] Heartbeat: ${this._pollCount} полів виконано, max_id_на_сторінці=${maxIdOnPage}, lastSeenId=${this.lastSeenId}`);
    }

    if (messages.length === 0) return;

    if (this.lastSeenId === null) {
      // Перший успішний polling — фіксуємо baseline, історію не обробляємо.
      this.lastSeenId = maxIdOnPage;
      logger.info(`[TG-LISTENER] Baseline встановлено: message_id=${this.lastSeenId}. Історія на сторінці ігнорується, чекаю нові повідомлення.`);
      return;
    }

    const fresh = messages.filter(m => m.id > this.lastSeenId);
    if (fresh.length === 0) return;

    logger.info(`[TG-LISTENER] Знайдено ${fresh.length} нових повідомлень (id ${fresh[0].id}..${fresh[fresh.length - 1].id})`);
    for (const msg of fresh) {
      this.lastSeenId = Math.max(this.lastSeenId, msg.id);
      if (this.onMessageCallback) {
        try {
          this.onMessageCallback(msg);
        } catch (error) {
          logger.error(`[TG-LISTENER] Помилка обробки повідомлення ${msg.id}: ${error.message}`);
        }
      }
    }
  }

  async start() {
    logger.info(`[TG-LISTENER] Старт поллінгу ${this._url()} кожні ${config.telegram.pollIntervalMs}мс`);
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this._pollOnce();
      if (!this.stopped) this.pollTimer = setTimeout(loop, config.telegram.pollIntervalMs);
    };
    await loop();
  }

  async stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }
}

module.exports = new TelegramListener();
