// ============================================================================
// Діагностика: що ЗАРАЗ реально повертає t.me/s/<channel> сторінка.
// Запуск: node scripts/debug-fetch-channel.js
// Порівняй max_id і час останнього повідомлення з тим, що бачиш в самому
// Telegram-додатку прямо зараз — якщо тут старіше, це підтверджує кешування
// на боці Telegram, а не баг у нашому коді.
// ============================================================================
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/settings');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

(async () => {
  const url = `https://t.me/s/${config.telegram.sourceChannel}`;
  console.log(`Запит: ${url}\n`);

  const res = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': BROWSER_UA, 'Cache-Control': 'no-cache' }
  });

  console.log(`HTTP статус: ${res.status}`);
  console.log(`Заголовки кешування: age=${res.headers['age'] || '—'}, cache-control=${res.headers['cache-control'] || '—'}, x-cache=${res.headers['x-cache'] || '—'}\n`);

  const $ = cheerio.load(res.data);
  const messages = [];

  $('.tgme_widget_message[data-post]').each((_, el) => {
    const dataPost = $(el).attr('data-post');
    const id = dataPost ? parseInt(dataPost.split('/').pop(), 10) : null;
    if (!id) return;
    const textEl = $(el).find('.tgme_widget_message_text').first();
    textEl.find('br').replaceWith('\n');
    const text = textEl.text().trim();
    const timeAttr = $(el).find('time.time').first().attr('datetime');
    messages.push({ id, timeAttr, preview: text.slice(0, 60).replace(/\n/g, ' ') });
  });

  messages.sort((a, b) => a.id - b.id);

  console.log(`Знайдено повідомлень на сторінці: ${messages.length}\n`);
  for (const m of messages) {
    console.log(`id=${m.id}  time=${m.timeAttr}  "${m.preview}"`);
  }

  console.log(`\nMax id на сторінці ЗАРАЗ: ${messages.length ? messages[messages.length - 1].id : '—'}`);
  console.log(`Поточний час (для порівняння): ${new Date().toISOString()}`);
})().catch(err => {
  console.error(`Помилка: ${err.message}`);
  if (err.response) {
    console.error(`HTTP статус: ${err.response.status}`);
    console.error(`Тіло відповіді (перші 500 символів): ${String(err.response.data).slice(0, 500)}`);
  }
  process.exit(1);
});
