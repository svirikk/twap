# Hyperliquid → MEXC TWAP copy-trading bot

Копіює TWAP-ордери whitelist-гаманців з Hyperliquid (читає публічний Telegram-канал)
на MEXC Futures. Детальна логіка — див. коментарі у `core/*.js`.

## Архітектура

```
telegram-listener (HTTP-поллінг t.me/s/<channel>)
  -> message-parser        (розпізнає CREATE / FINISH повідомлення)
  -> twap-manager           (whitelist, дедуп, matching create->finish, стан)
  -> position-manager        (розмір позиції, вхід, self-managed TP, MARKET-close)
  -> mexc.service / mexc-user-stream.service
```

`db/store.js` — SQLite (better-sqlite3), персистить TWAP-події і позиції, щоб
рестарт процесу не губив стан.

## Локальний запуск

```bash
npm install
cp .env.example .env
# заповнити MEXC_*, за бажанням TELEGRAM_SOURCE_CHANNEL/POLL_INTERVAL (дефолти вже робочі)
npm run dry-run                # DRY_RUN=true, без реальних ордерів
```

## Деплой на Railway

1. Новий сервіс типу **Worker** (не Web) — процес не слухає HTTP, health-check не потрібен.
2. Підключити **Volume**, mount path `/data` (відповідає `DB_PATH=/data/state.db` в `.env.example`).
3. Всі змінні з `.env.example` — у Railway Variables. Джерело сигналів — публічна
   preview-сторінка `t.me/s/<channel>`, логін/сесія не потрібні.
4. `DRY_RUN=true` для першого запуску — перевірити логи/сповіщення без реальних ордерів,
   потім вимкнути.
5. Очищення БД відбувається автоматично (`DB_CLEANUP_AFTER_HOURS`/`DB_CLEANUP_INTERVAL_MS`)
   — записи старші за 48 год після закриття видаляються, `VACUUM` тримає файл компактним.

## Відомі архітектурні компроміси (див. детальні коментарі в коді)

- **Telegram-listener читає публічну `t.me/s/<channel>` сторінку поллінгом**
  (`TELEGRAM_POLL_INTERVAL_MS`, дефолт 1200мс), без логіну. Простіше за MTProto,
  але без гарантій Telegram щодо швидкості оновлення цієї сторінки, і видно лише
  ~20 останніх повідомлень — довгий простій бота може означати непомітний пропуск
  сигналу. На старті бот навмисно ігнорує вже видиму історію (баз лайн по message id),
  щоб не відкривати позиції по "старих" сигналах після рестарту.
- **TP керується ботом (REST-поллінг ціни), не біржовим TP/SL-ордером** — бо кілька TWAP
  одного `wallet+symbol+side` MEXC зливає в одну позицію, і біржовий TP на "всю позицію"
  не дає незалежного TP на кожен TWAP. Компроміс: затримка ≈`TP_POLL_INTERVAL_MS` замість
  миттєвого біржового тригера. Деталі — `core/position-manager.js`, верхній коментар.
- **Matching create→finished/terminated евристичний**, бо `TwapId` присутній лише в
  finish-повідомленні. При двох майже однакових одночасних TWAP того самого гаманця на
  тому самому символі й напрямку 100% коректний matching неможливий у принципі — бот
  логує `[MATCH AMBIGUOUS]` для ручної перевірки. Деталі — `core/twap-manager.js`.
- **Reconciliation-цикл лише попереджає, не "ремонтує" автоматично** розбіжності між
  локальним станом і біржею, коли на symbol+side кілька локальних записів — немає
  надійного способу вгадати, який саме постраждав.

## Скрипти

- `npm run check-balance` — швидка перевірка балансу/з'єднання з MEXC.
- `npm run dry-run` — весь пайплайн без реальних ордерів.
