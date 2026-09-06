// ============================================================================
// Пошук точного symbol на MEXC Futures за підрядком (для колізій тікерів —
// коли на MEXC кілька різних монет із подібною назвою).
// Запуск: node scripts/find-symbol.js PUMP
// ============================================================================
require('dotenv').config();
const mexc = require('../services/mexc.service');

const query = (process.argv[2] || '').toUpperCase();
if (!query) {
  console.error('Використання: node scripts/find-symbol.js <підрядок>, напр. node scripts/find-symbol.js PUMP');
  process.exit(1);
}

(async () => {
  const res = await mexc.request('GET', '/api/v1/contract/detail', {}, false);
  const all = res.data || [];
  const matches = all.filter(c => c.symbol && c.symbol.toUpperCase().includes(query));

  if (matches.length === 0) {
    console.log(`Нічого не знайдено за "${query}" серед ${all.length} контрактів на MEXC Futures.`);
    return;
  }

  console.log(`Знайдено ${matches.length} збіг(ів) за "${query}":\n`);
  for (const m of matches) {
    console.log(JSON.stringify(m, null, 2));
    console.log('---');
  }
})().catch(err => {
  console.error(`Помилка: ${err.message}`);
  process.exit(1);
});
