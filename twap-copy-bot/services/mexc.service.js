// ============================================================================
// MEXC FUTURES REST CLIENT
// Ядро (sign/request) взято 1:1 з наданого коду — підпис і серіалізація тіла
// там зроблені правильно (той самий bodyStr для підпису і для запиту).
//
// ЗМІНИ ПРОТИ ОРИГІНАЛУ:
//  - додано просту чергу з throttle між приватними запитами (rate-limit safety);
//  - прибрано openMarketOrderWithProtection() / placeTpSl(): цей бот керує TP
//    сам (self-managed, position-manager.js), бо кілька TWAP на одному
//    symbol+side можуть злитись MEXC в одну біржову позицію — inline/біржовий
//    TP на "всю позицію" не дає незалежного TP на кожен TWAP. Деталі — у
//    відповіді в чаті й коментарі на початку position-manager.js.
// ============================================================================

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/settings');
const logger = require('../utils/logger');

const MIN_PRIVATE_INTERVAL_MS = 120; // safety margin проти rate-limit MEXC

class MexcService {
  constructor() {
    this.baseURL = config.mexc.baseURL;
    this.apiKey = config.mexc.apiKey;
    this.apiSecret = config.mexc.apiSecret;
    this.contractCache = new Map();
    this._queueTail = Promise.resolve();
    this._lastPrivateCallAt = 0;
  }

  sign(paramString, timestamp) {
    const target = `${this.apiKey}${timestamp}${paramString}`;
    return crypto.createHmac('sha256', this.apiSecret).update(target).digest('hex');
  }

  // Черга: усі приватні виклики йдуть послідовно з мінімальним інтервалом.
  // Публічні (isPrivate=false) в чергу не ставимо — навіщо, це переважно ticker.
  _throttle() {
    this._queueTail = this._queueTail.then(async () => {
      const wait = MIN_PRIVATE_INTERVAL_MS - (Date.now() - this._lastPrivateCallAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this._lastPrivateCallAt = Date.now();
    });
    return this._queueTail;
  }

  async request(method, path, params = {}, isPrivate = true) {
    if (isPrivate) await this._throttle();

    const url = `${this.baseURL}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    let axiosConfig = { method, url, headers, timeout: 10000 };

    if (!isPrivate) {
      if (method === 'GET' && Object.keys(params).length) {
        axiosConfig.params = params;
      }
    } else {
      const timestamp = Date.now().toString();
      let paramString;

      if (method === 'GET' || method === 'DELETE') {
        const entries = Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .sort(([a], [b]) => a.localeCompare(b));
        paramString = entries.map(([k, v]) => `${k}=${v}`).join('&');
        if (paramString) axiosConfig.url = `${url}?${paramString}`;
      } else {
        const bodyStr = JSON.stringify(params);
        paramString = bodyStr;
        axiosConfig.data = bodyStr;
      }

      const signature = this.sign(paramString, timestamp);
      headers['ApiKey'] = this.apiKey;
      headers['Request-Time'] = timestamp;
      headers['Signature'] = signature;
    }

    try {
      const response = await axios(axiosConfig);
      if (response.data && response.data.success === false) {
        throw new Error(`MEXC API error [${response.data.code}]: ${response.data.message || 'unknown error'}`);
      }
      return response.data;
    } catch (error) {
      if (error.response) {
        const d = error.response.data;
        throw new Error(`MEXC HTTP ${error.response.status}: ${d?.message || JSON.stringify(d)}`);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // MARKET (public)
  // ---------------------------------------------------------------------

  async getContractDetail(symbol) {
    if (this.contractCache.has(symbol)) return this.contractCache.get(symbol);

    const res = await this.request('GET', '/api/v1/contract/detail', { symbol }, false);
    const d = res.data;
    if (!d) throw new Error(`Contract ${symbol} not found on MEXC`);

    const info = {
      symbol: d.symbol,
      contractSize: parseFloat(d.contractSize),
      priceUnit: parseFloat(d.priceUnit),
      volUnit: parseFloat(d.volUnit),
      minVol: parseFloat(d.minVol),
      maxVol: parseFloat(d.maxVol),
      minLeverage: d.minLeverage,
      maxLeverage: d.maxLeverage,
      priceScale: d.priceScale,
      apiAllowed: d.apiAllowed
    };
    this.contractCache.set(symbol, info);
    return info;
  }

  async getTicker(symbol) {
    const res = await this.request('GET', '/api/v1/contract/ticker', { symbol }, false);
    if (!res.data) throw new Error(`Ticker for ${symbol} not found`);
    return {
      lastPrice: parseFloat(res.data.lastPrice),
      bid1: parseFloat(res.data.bid1),
      ask1: parseFloat(res.data.ask1),
      fairPrice: parseFloat(res.data.fairPrice),
      timestamp: res.data.timestamp
    };
  }

  // ---------------------------------------------------------------------
  // ACCOUNT (private)
  // ---------------------------------------------------------------------

  async getUSDTBalance() {
    const res = await this.request('GET', '/api/v1/private/account/assets', {}, true);
    const list = res.data || [];
    const usdt = list.find(c => c.currency === 'USDT');
    if (!usdt) return 0;
    return parseFloat(usdt.availableBalance || '0');
  }

  // ---------------------------------------------------------------------
  // LEVERAGE
  // ---------------------------------------------------------------------

  async setLeverage({ symbol, leverage, openType, positionType, positionId = null }) {
    const params = { leverage };
    if (positionId) {
      params.positionId = positionId;
    } else {
      params.symbol = symbol;
      params.openType = openType;
      params.positionType = positionType;
    }
    return this.request('POST', '/api/v1/private/position/change_leverage', params, true);
  }

  // ---------------------------------------------------------------------
  // ORDERS
  // ---------------------------------------------------------------------

  /**
   * Ринковий вхід у позицію З інлайн TP, ОДНИМ запитом (атомарно — нема вікна
   * "позиція відкрита, але без захисту"). side: 1 = open long, 3 = open short.
   *
   * Це саме той підхід, що вже перевірений на реальних ордерах у вихідному
   * коді користувача: окремий виклик stoporder/place (placeTpSl нижче) двічі
   * падав з різними помилками ([600], потім [5001]) — документація цього
   * ендпоінту виявилась ненадійною/суперечливою. Робочий варіант — слати
   * stopLossPrice/takeProfitPrice ПРЯМО в order/create, включно з market-
   * ордером (type=5).
   *
   * TP тут прикріплений НА РІВНІ ПОЗИЦІЇ (не на конкретний обсяг угоди). Якщо
   * кілька TWAP одного wallet+symbol+side зіллються в одну біржову позицію
   * (MEXC це робить автоматично), TP спрацює на всю позицію одразу, а не
   * окремо на частку кожного TWAP. За домовленістю з користувачем — прийнятний
   * компроміс заради простоти й надійності біржового тригера (замість
   * власного REST-поллінгу ціни).
   *
   * КОМПРОМІС: інлайн-спосіб не підтримує takeProfitType=limit — TP тут
   * виконується як MARKET по спрацюванню (гарантоване виконання, можливий
   * невеликий сліпедж проти точної ціни +2%/-2%).
   */
  async openMarketOrderWithProtection({
    symbol, side, vol, leverage, openType, price, positionMode, takeProfitPrice
  }) {
    const params = { symbol, price, vol, leverage, side, type: 5, openType, positionMode, takeProfitPrice };
    const res = await this.request('POST', '/api/v1/private/order/create', params, true);
    return res.data; // { orderId, ts }
  }

  async getOrder(orderId) {
    const res = await this.request('GET', `/api/v1/private/order/get/${orderId}`, {}, true);
    return res.data;
  }

  async cancelOrders(orderIds) {
    if (!orderIds || !orderIds.length) return null;
    const res = await this.request('POST', '/api/v1/private/order/cancel', { orderIds }, true);
    return res.data;
  }

  /**
   * Reduce-only закриття по ринку. side: 2 = close short, 4 = close long.
   * vol — САМЕ той обсяг, який треба закрити (не обов'язково вся позиція
   * на біржі, якщо кілька TWAP злились в одну позицію — див. position-manager.js).
   */
  async closePositionMarket({ symbol, direction, vol, price }) {
    const side = direction === 'LONG' ? 4 : 2;
    const params = { symbol, price, vol, side, type: 5, openType: config.trading.openType };
    const res = await this.request('POST', '/api/v1/private/order/create', params, true);
    return res.data;
  }

  // ---------------------------------------------------------------------
  // POSITIONS
  // ---------------------------------------------------------------------

  async getOpenPositions(symbol = null) {
    const params = {};
    if (symbol) params.symbol = symbol;
    const res = await this.request('GET', '/api/v1/private/position/open_positions', params, true);
    return res.data || [];
  }

  async getHistoricalPositions({ symbol = null, pageNum = 1, pageSize = 20 } = {}) {
    const params = { page_num: pageNum, page_size: pageSize };
    if (symbol) params.symbol = symbol;
    const res = await this.request('GET', '/api/v1/private/position/list/history_positions', params, true);
    return res.data?.resultList || res.data || [];
  }

  async connect() {
    try {
      await this.request('GET', '/api/v1/contract/ticker', { symbol: 'BTC_USDT' }, false);
      logger.info('[MEXC] ✅ Public API reachable');
      if (!config.trading.dryRun) {
        const balance = await this.getUSDTBalance();
        logger.info(`[MEXC] ✅ Private API authenticated. USDT balance: ${balance}`);
      }
      return true;
    } catch (error) {
      logger.error(`[MEXC] Connection check failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new MexcService();
