const config = require('../config/settings');

const whitelist = new Set(config.wallets);

function isWhitelisted(wallet) {
  return whitelist.has((wallet || '').toLowerCase());
}

module.exports = { isWhitelisted };
