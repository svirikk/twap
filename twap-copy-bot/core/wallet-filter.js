const config = require('../config/settings');
const store = require('../db/store');
const notifier = require('../services/notifier.service');
const logger = require('../utils/logger');
const partialPatterns = require('../config/partial-wallets'); // ТИМЧАСОВО — див. коментар у самому файлі

const staticWhitelist = new Set(config.wallets);

function isWhitelisted(wallet) {
  return staticWhitelist.has((wallet || '').toLowerCase());
}

function matchesAnyPartial(wallet) {
  return partialPatterns.find(p =>
    wallet.startsWith(p.prefix.toLowerCase()) && wallet.endsWith(p.suffix.toLowerCase())
  ) || null;
}

// ============================================================================
// ГОЛОВНА ФУНКЦІЯ для рішення "чи стежимо за цим гаманцем ЗАРАЗ":
//  1. постійний whitelist (config/wallets.js) — як і раніше;
//  2. вже раніше знайдений через частковий збіг (персистентно, БД);
//  3. ЩОЙНО знайдений зараз через частковий збіг — записуємо і повідомляємо.
//
// ТИМЧАСОВО (п.3): коли всі гаманці з config/partial-wallets.js будуть
// знайдені і перенесені в config/wallets.js — прибери imports/виклики цього
// блоку і сам файл config/partial-wallets.js.
// ============================================================================
function resolveAndTrack(wallet) {
  const w = (wallet || '').toLowerCase();
  if (!w) return false;

  if (isWhitelisted(w)) return true;
  if (store.isDiscoveredWallet(w)) return true;

  const pattern = matchesAnyPartial(w);
  if (pattern) {
    store.addDiscoveredWallet(w, pattern.prefix, pattern.suffix);
    logger.info(`[WALLET] 🔍 Знайдено гаманець за частковим збігом ${pattern.prefix}.../${pattern.suffix}: ${w}`);
    notifier.notifyWalletDiscovered(w, pattern).catch(() => {});
    return true;
  }

  return false;
}

module.exports = { isWhitelisted, resolveAndTrack };
