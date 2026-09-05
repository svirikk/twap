const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('../config/settings');
const logger = require('../utils/logger');

// ============================================================================
// MEXC ПРИВАТНИЙ USER-DATA WEBSOCKET
// wss://contract.mexc.com/edge — після логіну біржа сама штовхає оновлення по
// позиціях (push.personal.position), без REST-полінгу.
//
// ЗМІНА ПРОТИ ОРИГІНАЛУ: у наданому коді reconnect зупинявся НАЗАВЖДИ після
// MAX_RECONNECTS невдач — для довготривалого сервісу на Railway це означало б
// "назавжди без live-моніторингу закриттів" при тривалому збої на боці MEXC.
// Тут — нескінченний retry з backoff, capped на MAX_RECONNECT_DELAY_MS.
// ============================================================================
const MAX_RECONNECT_DELAY_MS = 30000;

class MexcUserStream {
  constructor() {
    this.ws = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.loggedIn = false;
    this.onPositionUpdate = null;
    this.onAuthFailed = null;
    this._closedByUser = false;
  }

  setOnPositionUpdate(fn) { this.onPositionUpdate = fn; }
  setOnAuthFailed(fn) { this.onAuthFailed = fn; }

  sign(reqTime) {
    const target = `${config.mexc.apiKey}${reqTime}`;
    return crypto.createHmac('sha256', config.mexc.apiSecret).update(target).digest('hex');
  }

  connect() {
    this._closedByUser = false;
    logger.info('[WS-USER] Підключення до приватного user-data стріму MEXC...');
    this.ws = new WebSocket('wss://contract.mexc.com/edge');

    this.ws.on('open', () => {
      logger.info('[WS-USER] З\'єднання відкрито, авторизуюсь...');
      this.login();
    });

    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('error', (error) => logger.error(`[WS-USER] error: ${error.message}`));
    this.ws.on('close', () => {
      logger.warn('[WS-USER] З\'єднання закрито');
      this.loggedIn = false;
      this.stopPing();
      if (!this._closedByUser) this.reconnect();
    });
  }

  login() {
    const reqTime = Date.now().toString();
    const signature = this.sign(reqTime);
    this.ws.send(JSON.stringify({
      method: 'login',
      param: { apiKey: config.mexc.apiKey, reqTime, signature }
    }));
  }

  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 15000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw);

      if (msg.channel === 'rs.login') {
        logger.info('[WS-USER] ✅ Авторизація успішна');
        this.loggedIn = true;
        this.reconnectAttempts = 0;
        this.startPing();
        return;
      }

      if (msg.channel === 'rs.error') {
        logger.error(`[WS-USER] Помилка авторизації/команди: ${JSON.stringify(msg.data)}`);
        if (!this.loggedIn && this.onAuthFailed) this.onAuthFailed(msg.data);
        return;
      }

      if (msg.channel === 'pong') return;

      if (msg.channel === 'push.personal.position' && this.onPositionUpdate) {
        this.onPositionUpdate(msg.data);
      }
    } catch (error) {
      logger.error(`[WS-USER] parse error: ${error.message}`);
    }
  }

  reconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(3000 * this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    logger.info(`[WS-USER] Перепідключення через ${delay}мс (спроба #${this.reconnectAttempts})...`);
    setTimeout(() => this.connect(), delay);
  }

  close() {
    this._closedByUser = true;
    this.stopPing();
    if (this.ws) this.ws.close();
  }
}

module.exports = new MexcUserStream();
