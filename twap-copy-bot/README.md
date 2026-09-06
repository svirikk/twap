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

## Відомий краш при першому запуску (виправлено)

Якщо бачив `Assertion failed: (env) != nullptr` / `RemoveEnvironmentCleanupHook` і
`Aborted` одразу після старту — це не логіка бота, а конфлікт версій:
Node.js **24.19.0+** додав cleanup hooks до `node::ObjectWrap`
([nodejs/node#63642](https://github.com/nodejs/node/pull/63642)), а
`better-sqlite3` до версії 13 використовує саме цей legacy API — деструктор
`Statement`/`Database` падає на цій зміні. Виправлено тут двома речами
одночасно: `better-sqlite3` піднято до `^13.0.0` (перейшов на N-API, цього
шляху краху вже нема) + `package.json.engines.node` і `.nvmrc` зафіксовані на
`>=22`, щоб Railway не підхопив несумісну комбінацію знову. Публічний API
`better-sqlite3` (prepare/run/get/all/pragma/exec) між 11.x і 13.x не мінявся,
тож `db/store.js` правок не потребував.

## Відомі архітектурні компроміси (див. детальні коментарі в коді)

- **Telegram-listener читає публічну `t.me/s/<channel>` сторінку поллінгом**
  (`TELEGRAM_POLL_INTERVAL_MS`, дефолт 1200мс = 50 запитів/хв, без логіну). Простіше
  за MTProto, але без гарантій Telegram щодо швидкості оновлення цієї сторінки, і
  видно лише ~20 останніх повідомлень — довгий простій бота може означати непомітний
  пропуск сигналу. Справжній push (нуль поллінгу) для чужого каналу можливий ЛИШЕ
  через автентифіковане MTProto-з'єднання (сесія користувача) — Bot API тут не
  підходить, бо канал не наш і додати туди свого бота ми не можемо. Якщо колись
  захочеш повернутись до push — кажи, інтерфейс listener'а сумісний, зміниться лише
  цей файл. На старті бот навмисно ігнорує вже видиму історію (baseline по message id).
- **TP — біржовий, інлайн при вході** (`stopLossPrice`/`takeProfitPrice` в
  `order/create`, той самий підхід, що вже перевірений у вихідному коді на реальних
  ордерах). Якщо кілька TWAP одного `wallet+symbol+side` зіллються MEXC в одну
  позицію — TP спрацює на всю позицію одразу, не окремо по частці кожного TWAP.
  Прийнято як свідомий компроміс замість власного REST-поллінгу ціни.
  Виявлення спрацювання — через приватний WS (`push.personal.position`, `state=3`),
  без опитування.
- **Matching create→finished/terminated евристичний**, бо `TwapId` присутній лише в
  finish-повідомленні. При двох майже однакових одночасних TWAP того самого гаманця на
  тому самому символі й напрямку 100% коректний matching неможливий у принципі — бот
  логує `[MATCH AMBIGUOUS]` для ручної перевірки. Деталі — `core/twap-manager.js`.
- **Reconciliation-цикл лише попереджає, не "ремонтує" автоматично** розбіжності між
  локальним станом і біржею, коли на symbol+side кілька локальних записів — немає
  надійного способу вгадати, який саме постраждав.

## Символ недоступний на MEXC ("Contract not exists")

Означає, що `config/settings.js → toMexcSymbol()` побудував рядок (`${SYMBOL}_USDT`),
якого на MEXC Futures немає — типово через колізію тікерів (кілька різних монет з
однаковою чи схожою назвою на різних мережах, MEXC розводить їх під різними symbol).
Бот у цьому випадку НЕ падає і НЕ торгує — просто позначає TWAP як `error` і логує.

Щоб знайти правильний symbol:
```bash
node scripts/find-symbol.js PUMP
```
виведе всі контракти MEXC Futures, що містять цей підрядок, з повними даними з API —
звідти видно точний `symbol`. Додай відповідність в `config/settings.js`:
```js
const SYMBOL_OVERRIDES = {
  'PUMP': 'PUMPFUN_USDT', // приклад — перевір реальний symbol через find-symbol.js
};
```

## Ручне закриття позиції на біржі

Якщо позицію закрито вручну в UI MEXC (не через бота), вона перестає відстежуватись
автоматично: приватний WS (`push.personal.position`) зазвичай ловить закриття миттєво,
а reconcile-цикл (раз на `RECONCILE_INTERVAL_MS`, дефолт 60с) — підстраховка на випадок,
якщо WS щось пропустив. Коли на біржі по symbol+side обсяг зникає повністю — локальний
запис фіналізується автоматично, і бот більше не намагається його закрити чи звірити.
Точна ціна виходу/PnL для такого закриття невідомі (позначені `null` в БД) — глянь
історію на самій біржі, якщо потрібні деталі.

## Скрипти

- `npm run check-balance` — швидка перевірка балансу/з'єднання з MEXC.
- `npm run debug-channel` — сирий дамп того, що зараз повертає t.me/s/<channel>.
- `npm run find-symbol -- PUMP` — пошук точного MEXC-symbol за підрядком.
- `npm run dry-run` — весь пайплайн без реальних ордерів.
