const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/settings');
const logger = require('../utils/logger');

const dir = path.dirname(config.db.path);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(config.db.path);
db.pragma('journal_mode = WAL'); // безпечніше при рестарті/крашi процесу

db.exec(`
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS twap_events (
  id TEXT PRIMARY KEY,
  twap_id TEXT,
  wallet TEXT NOT NULL,
  symbol TEXT NOT NULL,
  mexc_symbol TEXT NOT NULL,
  direction TEXT NOT NULL,          -- BUY | SELL
  notional_usd REAL NOT NULL,
  price_at_creation REAL NOT NULL,
  planned_duration_sec INTEGER,
  created_at INTEGER NOT NULL,
  tg_message_id INTEGER,
  status TEXT NOT NULL,             -- created | position_open | closed_tp | closed_finished | closed_terminated | error | ignored
  total_size_tokens REAL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_twap_wallet_symbol_status ON twap_events(wallet, symbol, status);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  twap_event_id TEXT NOT NULL,
  symbol TEXT NOT NULL,             -- HL symbol (для логів)
  mexc_symbol TEXT NOT NULL,
  direction TEXT NOT NULL,          -- LONG | SHORT
  margin_usd REAL NOT NULL,
  leverage INTEGER NOT NULL,
  notional_usd REAL NOT NULL,
  qty REAL NOT NULL,
  entry_order_id TEXT,
  entry_price REAL,
  mexc_position_id TEXT,            -- ПРИМІТКА: може збігатись у кількох рядків,
                                     -- якщо MEXC злив кілька TWAP одного symbol+side
                                     -- в одну біржову позицію. Закриття завжди йде
                                     -- reduce-only на qty КОНКРЕТНОГО рядка, не всієї позиції.
  tp_price REAL,
  status TEXT NOT NULL,             -- opening | open | closing | closed | error
  close_reason TEXT,
  exit_price REAL,
  pnl REAL,
  opened_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_twap ON positions(twap_event_id);
`);

function uuid() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------
// Дедуплікація Telegram-повідомлень
// ---------------------------------------------------------------------
function isMessageProcessed(messageId) {
  return !!db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?').get(messageId);
}

function markMessageProcessed(messageId) {
  try {
    db.prepare('INSERT INTO processed_messages (message_id, processed_at) VALUES (?, ?)')
      .run(messageId, Date.now());
  } catch (e) {
    // UNIQUE constraint -> вже позначено паралельним викликом, ігноруємо
  }
}

// ---------------------------------------------------------------------
// TWAP events
// ---------------------------------------------------------------------
function createTwapEvent(ev) {
  const id = uuid();
  const now = Date.now();
  db.prepare(`
    INSERT INTO twap_events
      (id, twap_id, wallet, symbol, mexc_symbol, direction, notional_usd,
       price_at_creation, planned_duration_sec, created_at, tg_message_id,
       status, total_size_tokens, updated_at)
    VALUES (@id, @twap_id, @wallet, @symbol, @mexc_symbol, @direction, @notional_usd,
            @price_at_creation, @planned_duration_sec, @created_at, @tg_message_id,
            @status, @total_size_tokens, @updated_at)
  `).run({
    id,
    twap_id: ev.twapId || null,
    wallet: ev.wallet,
    symbol: ev.symbol,
    mexc_symbol: ev.mexcSymbol,
    direction: ev.direction,
    notional_usd: ev.notionalUsd,
    price_at_creation: ev.priceAtCreation,
    planned_duration_sec: ev.plannedDurationSec || null,
    created_at: ev.createdAt,
    tg_message_id: ev.tgMessageId || null,
    status: 'created',
    total_size_tokens: null,
    updated_at: now
  });
  return getTwapEvent(id);
}

function getTwapEvent(id) {
  return db.prepare('SELECT * FROM twap_events WHERE id = ?').get(id);
}

function updateTwapEvent(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE twap_events SET ${sets}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: Date.now() });
  return getTwapEvent(id);
}

// Кандидати для matching create -> finish: той самий wallet+symbol, ще відкриті
function getOpenTwapCandidates(wallet, symbol) {
  return db.prepare(`
    SELECT * FROM twap_events
    WHERE wallet = ? AND symbol = ? AND status = 'position_open'
    ORDER BY created_at ASC
  `).all(wallet, symbol);
}

function getAllOpenTwapEvents() {
  return db.prepare(`SELECT * FROM twap_events WHERE status IN ('created', 'position_open')`).all();
}

// ---------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------
function createPosition(p) {
  const id = uuid();
  db.prepare(`
    INSERT INTO positions
      (id, twap_event_id, symbol, mexc_symbol, direction, margin_usd, leverage,
       notional_usd, qty, entry_order_id, entry_price, mexc_position_id, tp_price,
       status, close_reason, exit_price, pnl, opened_at, closed_at)
    VALUES (@id, @twap_event_id, @symbol, @mexc_symbol, @direction, @margin_usd, @leverage,
            @notional_usd, @qty, @entry_order_id, @entry_price, @mexc_position_id, @tp_price,
            @status, NULL, NULL, NULL, @opened_at, NULL)
  `).run({
    id,
    twap_event_id: p.twapEventId,
    symbol: p.symbol,
    mexc_symbol: p.mexcSymbol,
    direction: p.direction,
    margin_usd: p.marginUsd,
    leverage: p.leverage,
    notional_usd: p.notionalUsd,
    qty: p.qty,
    entry_order_id: p.entryOrderId || null,
    entry_price: p.entryPrice || null,
    mexc_position_id: p.mexcPositionId || null,
    tp_price: p.tpPrice || null,
    status: p.status || 'opening',
    opened_at: p.openedAt || Date.now()
  });
  return getPosition(id);
}

function getPosition(id) {
  return db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
}

function updatePosition(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE positions SET ${sets} WHERE id = @id`).run({ ...fields, id });
  return getPosition(id);
}

// Атомарний перехід статусу: спрацьовує, лише якщо поточний статус входить
// у fromStatuses. Повертає true, якщо "виграли" перехід (захист від гонки
// TP-monitor vs finish/terminated-повідомлення, що прийшли майже одночасно).
function claimPositionClosing(id) {
  const res = db.prepare(`UPDATE positions SET status = 'closing' WHERE id = ? AND status = 'open'`).run(id);
  return res.changes > 0;
}

function claimTwapStatus(id, fromStatuses, toStatus) {
  const placeholders = fromStatuses.map(() => '?').join(',');
  const res = db.prepare(`
    UPDATE twap_events SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})
  `).run(toStatus, Date.now(), id, ...fromStatuses);
  return res.changes > 0;
}

function getOpenPositionsForTwap(twapEventId) {
  return db.prepare(`SELECT * FROM positions WHERE twap_event_id = ? AND status IN ('opening','open','closing')`)
    .all(twapEventId);
}

function getAllOpenPositions() {
  return db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all();
}

// ---------------------------------------------------------------------
// Очищення старих закритих записів (щоб не роздувати volume на Railway)
// ---------------------------------------------------------------------
function cleanupOld() {
  const cutoff = Date.now() - config.db.cleanupAfterHours * 3600 * 1000;
  const posRes = db.prepare(`
    DELETE FROM positions WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?
  `).run(cutoff);
  const twapRes = db.prepare(`
    DELETE FROM twap_events
    WHERE status IN ('closed_tp','closed_finished','closed_terminated','error','ignored')
      AND updated_at < ?
      AND id NOT IN (SELECT twap_event_id FROM positions)
  `).run(cutoff);
  const msgRes = db.prepare(`DELETE FROM processed_messages WHERE processed_at < ?`).run(cutoff);
  if (posRes.changes || twapRes.changes || msgRes.changes) {
    logger.info(`[DB] Очищення: positions=${posRes.changes}, twap_events=${twapRes.changes}, messages=${msgRes.changes}`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  }
}

module.exports = {
  db,
  isMessageProcessed, markMessageProcessed,
  createTwapEvent, getTwapEvent, updateTwapEvent, getOpenTwapCandidates, getAllOpenTwapEvents,
  createPosition, getPosition, updatePosition, getOpenPositionsForTwap, getAllOpenPositions,
  claimPositionClosing, claimTwapStatus,
  cleanupOld
};
