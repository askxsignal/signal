# signal — настройка с нуля

Порядок: конфиг → X Developer Portal → Supabase → Netlify → проверка. Всё вместе — минут 30–40.

## 0. Конфиг проекта

Откройте `shared/brand.mjs` и заполните:

| Поле | Что вписать |
|---|---|
| `site` | ваш домен, например `https://asksignal.chat` |
| `xHandle` | ник аккаунта X без `@` |
| `postId` | ID закреплённого поста (число из ссылки `x.com/<ник>/status/<ID>`) |
| `ticker` / `unit` | тикер (`SIG`) и как показываются суммы (`$SIG`) |
| `token.ca` | адрес контракта на Solana. Пока пусто, сайт пишет «Launching soon» |
| `swap.url` | ссылка на свап NFT → $SIG. Кнопка заблокирована до запуска, после запуска открывается эта ссылка |
| `launch.at` / `label` | время запуска (ISO с часовым поясом) и подпись для отсчёта |

Задания берут ник и пост отсюда же, поэтому SQL трогать не нужно.

Тексты заданий лежат в двух местах: `shared/tasks.mjs` (демо) и таблица `tasks` (прод, миграция `0013_signal.sql`). Если меняете их, меняйте в обоих.

## 1. X Developer Portal (логин через X)

1. developer.x.com → Projects & Apps → создайте App внутри Project (без привязки к Project X API v2 не отдаст профиль).
2. **User authentication settings:**
   - App permissions: **Read**;
   - Type of App: **Web App, Automated App or Bot**;
   - Callback URI:
     - прод `https://ВАШ_ДОМЕН/auth/x/callback`;
     - локально `http://127.0.0.1:8888/auth/x/callback` (`localhost` X не принимает);
   - Website URL: `https://ВАШ_ДОМЕН`.
3. Keys and tokens → **OAuth 2.0 Client ID и Client Secret** → `X_CLIENT_ID`, `X_CLIENT_SECRET`. Это не API Key/Secret от OAuth 1.0a.

Платный тариф X API не нужен. Подписки и лайки проверяются серверным таймером, ответы и цитаты — по ссылке на ваш пост (через публичный oEmbed X).

## 2. Supabase

1. Создайте проект. Регион выбирайте ближе к функциям Netlify (по умолчанию us-east).
2. SQL Editor → вставьте и выполните миграции **строго по порядку**: `0001_init.sql`, `0002_limits.sql`, … `0013_signal.sql`. Все миграции идемпотентные, повторный запуск безопасен.
3. Advisors → Security: не должно быть «RLS disabled».
4. Project Settings → API:
   - `SUPABASE_URL` = Project URL;
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role / secret key (**только сервер**).
5. Бесплатный проект засыпает после недели без запросов. Тогда нажмите Restore в дашборде.

Миграция 0013 только переименовывает задания под signal. Механика, кошельки и таблицы NFT остаются как у glyph.

## 3. Модель (необязательно)

Подойдёт любой OpenAI-совместимый endpoint `chat/completions` с поддержкой tools: `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`. Без него отвечает скриптовый мозг: персонаж беднее, но всё работает. Дневные лимиты расхода — в `app_config` (см. `docs/OPERATIONS.md`).

## 4. NFT (минт пропуска на Solana, необязательно)

Без этих переменных сайт работает, просто меню «My NFT» не откроется. Порядок такой:

1. Нужен RPC с поддержкой DAS (Helius, Triton и т.п.) → `NFT_RPC_URL`.
2. На своём компьютере, после `npm install`:
   - `node scripts/nft-setup.mjs keygen` → кошелёк-минтер в `.nft/minter.json`. Пополните его SOL на газ: около 0.0001 SOL за пропуск плюс оплата дерева один раз;
   - `node scripts/nft-setup.mjs tree --yes` → merkle tree (`NFT_TREE`);
   - `node scripts/nft-setup.mjs collection --site https://ВАШ_ДОМЕН --yes` → коллекция (`NFT_COLLECTION`).
3. `NFT_SECRET_KEY` = содержимое `.nft/minter.json`, `NFT_NETWORK` = `devnet` (сначала) или `mainnet`.
4. **Сначала всё на devnet:** `node scripts/nft-setup.mjs test-mint --to <ваш кошелёк> --site https://ВАШ_ДОМЕН`, затем минт с сайта. Только после этого переключайте на mainnet.
5. Кто может минтить — список в базе или «все»: SQL в `docs/OPERATIONS.md` → Minting. Проверка функции: `/api/nft/health`.

Картинка NFT рисуется на сервере шрифтами из `netlify/fonts` (Geist Mono, Manrope). Чтобы NFT был в тех же шрифтах, что сайт, положите туда TTF Martian Mono и Space Grotesk и поменяйте `font-family` в `netlify/lib/nft.mjs`.

## 5. Netlify

1. Код в GitHub → Netlify → Add new site → Import from Git. Или `npx netlify-cli deploy --build --prod`.
   - ⚠️ Drag-and-drop zip загружает **только статику**: функции не задеплоятся, и `/api` вернёт 404 или HTML.
2. Site settings → Environment variables (секреты — Scope: Functions, «Contains secret values»):

| Переменная | Значение |
|---|---|
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | из X Portal |
| `SESSION_SECRET` | `openssl rand -base64 48` (не короче 32 символов) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | из Supabase |
| `SITE_URL` | `https://ВАШ_ДОМЕН` (обязательно на своём домене) |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | необязательно |
| `X_MIN_ACCOUNT_AGE_DAYS` | необязательно, например `30` |
| `NFT_RPC_URL`, `NFT_SECRET_KEY`, `NFT_TREE`, `NFT_COLLECTION`, `NFT_NETWORK` | для минта, см. раздел 4 |

3. **После изменения env нужен Redeploy** (Deploys → Trigger deploy).
4. Откройте `https://ВАШ_ДОМЕН/api/health` — должно быть `ok: true`. Скопируйте оттуда `callback_url` в X Portal символ в символ.
5. Пройдите логин целиком: X → назад на сайт → `?auth=ok` → `/api/me` отвечает 200.

## 6. Локальный запуск

- Только интерфейс: `npm run dev` → `http://127.0.0.1:5193`, демо-режим на localStorage с бейджем DEMO.
- С функциями: `npx netlify-cli dev` → `http://127.0.0.1:8888`, в `.env` укажите `SITE_URL=http://127.0.0.1:8888`.
- ⚠️ `netlify dev` подтягивает env сайта, то есть пишет в **боевую** базу. Для тестов заведите отдельный проект Supabase.

## Ошибка → причина

| Что видно | Причина |
|---|---|
| Тост «X refused the sign-in», `reason=token` | Callback в X Portal не совпадает символ в символ, неверный секрет или тип приложения не Web App |
| `reason=state` / `expired` | Куки заблокированы, логин занял дольше 10 минут, начали на www, а вернулись без www (зафиксируйте `SITE_URL`) |
| `reason=profile` | App не привязан к Project, и у него нет доступа к X API v2 |
| `reason=database` | Миграции не запущены, неверный service key или проект Supabase на паузе |
| `reason=config` | На сервере нет `X_CLIENT_ID` / `X_CLIENT_SECRET` (проверьте `/api/health`, затем Redeploy) |
| `reason=too_new` | Аккаунт моложе `X_MIN_ACCOUNT_AGE_DAYS` |
| Баннер «Service unavailable», `/api/*` отдаёт HTML или 404 | Функции не задеплоились (drag-and-drop) или запущен `npm run dev` без `netlify dev` |
| Персонаж отвечает шаблонно | Нет `MODEL_*` или кончился дневной бюджет. `/api/health?llm=1` покажет, отвечает ли модель |
| «that post does not exist» на настоящую ссылку | Пост не публичный или X oEmbed временно недоступен (тогда сервер проверяет только формат ссылки) |
| Задания ведут на чужой пост | В `shared/brand.mjs` остался `postId` по умолчанию |
| Отсчёт сразу показывает «$SIG is live» | Дата `launch.at` уже прошла |
| «Minting is not set up yet.» | Нет переменных `NFT_*` на сервере. `/api/nft/health` покажет, каких |
| «Solana is not answering» / «The reserve is refilling its gas» | RPC не отвечает или на кошельке-минтере кончились SOL |
| «Minting is not open for you yet.» | Аккаунта нет в списке на минт (`nft_allowlist`) и `nft_open` не включён |
| NFT без текста или с квадратами вместо букв | Функция не нашла шрифты: проверьте `included_files` в `netlify.toml` и что деплой идёт из Git |

## Перед запуском

- [ ] `/api/health` → ok. Логин проходит на проде, с телефона и из in-app браузера X.
- [ ] Повторное «done» не начисляет второй раз. Свою реф-ссылку засчитать нельзя.
- [ ] В бандле нет секретов: `grep -r "service_role\|SECRET" dist/` пусто.
- [ ] Supabase Advisors чистые.
- [ ] Ник, ID поста, дата запуска и CA (или «Launching soon») в `shared/brand.mjs` — реальные.
- [ ] Минт проверен на devnet, на кошельке-минтере есть SOL, `/api/nft/health` → ok.
- [ ] OG-картинка видна в превью X (отправьте ссылку себе в DM).
- [ ] На 375px нет горизонтального скролла, `prefers-reduced-motion` работает.
- [ ] Ключи, когда-либо вставленные в чат, ротированы.
