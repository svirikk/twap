require('dotenv').config();
const mexc = require('../services/mexc.service');

(async () => {
  try {
    await mexc.connect();
    const balance = await mexc.getUSDTBalance();
    console.log(`USDT available balance: ${balance}`);
  } catch (error) {
    console.error(`Помилка: ${error.message}`);
    process.exit(1);
  }
})();
