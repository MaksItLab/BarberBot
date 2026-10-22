# Магазин косметики — Telegram Mini App

Магазин: отдельный React frontend и ASP.NET Core backend в одном
репозитории. Backend состоит из пяти проектов: Domain, Application,
Infrastructure, Api и Contracts. На публикации сервер отдаёт интерфейс и API под одним адресом.
Реализованы каталог, фильтры, карточка с вариантами, Telegram-вход и админка.
Настоящий запуск в Telegram требует токена, размещения с HTTPS и ID администратора.
Договорённости и границы MVP: [docs/decisions.md](docs/decisions.md).
Согласованная модель данных: [docs/data-model.md](docs/data-model.md).
Один товар содержит варианты объёма/размера/оттенка с ценами в рублях.
Учёт и показ остатков отложены.
Результаты проверок: [verification.md](docs/verification.md).
Завершение настоящего запуска: [launch-checklist.md](docs/launch-checklist.md).
Продуктовый backlog: [надёжность, UI/UX и развитие](docs/backlog.md).

Архитектура сервера — слоистый монолит с организацией по фичам и Minimal API.
Подробности: [архитектура](docs/architecture.md), [порядок работы по ролям](docs/workflow.md),
[анализ и результаты шести фич](docs/features.md). Правила для дальнейшей
работы также закреплены в [AGENTS.md](AGENTS.md).

## Требования

- .NET SDK 10 (стабильный; версия выбирается через `global.json`).
- Node.js 24 LTS и pnpm 11.25.0 (`npm install --global pnpm@11.25.0`).
- Docker Desktop с запущенным Linux engine для PostgreSQL/Compose либо установленный PostgreSQL 18.

Для браузерных автоматических проверок дополнительно нужны Edge и Playwright.

## Локальная разработка

Все команды ниже выполняются из корня репозитория в PowerShell.

### 1. PostgreSQL

```powershell
Copy-Item .env.example .env
# Задайте свой POSTGRES_PASSWORD в .env.
docker compose up -d postgres
```

База `cosmetics`, пользователь `cosmetics`, порт `localhost:5432`.
Данные сохраняются в Docker volume `postgres_data`. При остановке используйте
`docker compose stop`; удаление volume приведёт к потере данных.

### 2. Сервер

```powershell
Copy-Item backend/CosmeticsShop.Api/appsettings.Local.example.json backend/CosmeticsShop.Api/appsettings.Local.json
# В ConnectionStrings:Shop укажите тот же пароль, что в .env.
dotnet restore CosmeticsShop.slnx --locked-mode
dotnet tool restore
dotnet ef database update --project backend/CosmeticsShop.Infrastructure --startup-project backend/CosmeticsShop.Api
dotnet run --project backend/CosmeticsShop.Api --launch-profile http
```

Сервер: `http://localhost:5080`.

`.env` читается Docker Compose. Для локального .NET используется
`appsettings.Local.json` или переменная `ConnectionStrings__Shop`.
Переменные окружения имеют приоритет над локальным JSON.
Настройки с паролями и токенами исключены из Git.

### 3. Интерфейс — во втором терминале

```powershell
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend dev
```

Откройте `http://localhost:5173`. Vite передаёт `/api` на порт 5080.
В обычном браузере каталог доступен без Telegram. Пока товары не добавлены,
интерфейс показывает пустое состояние. Админка требует проверенного входа Telegram.

## Проверки

```powershell
pnpm --dir frontend build
dotnet build CosmeticsShop.slnx --no-restore
Invoke-RestMethod http://localhost:5080/api/health/live
Invoke-RestMethod http://localhost:5080/api/health/ready
```

`live` проверяет процесс. `ready` возвращает 200 при подключении к
PostgreSQL и отсутствии неприменённых миграций. Без подключения или с
неприменёнными миграциями возвращается 503. Запуск сервера и стартовый экран
доступны без базы, но такая система не считается готовой к работе с данными.
Неизвестные `/api/*` возвращают 404, а клиентские маршруты — HTML приложения
после совместной публикации.

### Проверка модели на настоящем PostgreSQL

Если PostgreSQL 18 установлен локально:

```powershell
./scripts/test-database.ps1
# При другом расположении:
# ./scripts/test-database.ps1 -PostgresBin 'D:/PostgreSQL/18/bin'
```

Скрипт создаёт отдельный кластер в `artifacts/postgres-tests`, выбирает
свободный локальный порт и генерирует временный пароль. Тесты создают
свою базу со случайным именем, проверяют миграцию и ограничения, затем
удаляют только эту базу. Сервер останавливается в конце, файл пароля
удаляется. Диагностические файлы кластера остаются в `artifacts` и не
попадают в Git. Уже работающие базы данных не изменяются.

Альтернативно задайте `SHOP_TEST_ADMIN_CONNECTION` для PostgreSQL с правом
создания баз и выполните:

```powershell
dotnet test tests/CosmeticsShop.Api.IntegrationTests --configuration Release --no-restore
```

Проверяются точность цен, уникальность вариантов с незаполненными
характеристиками, запрет отрицательных цен, роли и Telegram ID, внешние
ключи, видимость вариантов, даты изменения и откат/повторное применение миграции.

## Миграции

Первая миграция — `InitialCatalog`; создаёт таблицы `brands`, `cosmetic_types`,
`products`, `product_variants`, `users` и служебную историю EF Core.
Миграции применяются явно, автоматически при запуске приложение их не выполняет.

```powershell
dotnet tool restore
dotnet ef database update --project backend/CosmeticsShop.Infrastructure --startup-project backend/CosmeticsShop.Api
dotnet ef migrations has-pending-model-changes --project backend/CosmeticsShop.Infrastructure --startup-project backend/CosmeticsShop.Api
```

Миграции находятся в Infrastructure; настройки подключения и запуск инструментов —
в Api. Перенос сохранил ID первой миграции и SQL создания таблиц.
`ProductConcurrency` добавляет отображение системного xmin для защиты от
одновременного редактирования; нового физического столбца не создаётся.

## Совместная публикация без Docker

```powershell
./scripts/publish.ps1
$env:ASPNETCORE_URLS = 'http://localhost:8080'
# Укажите ConnectionStrings__Shop для проверки готовности базы.
Push-Location artifacts/publish
dotnet CosmeticsShop.Api.dll
Pop-Location
```

Интерфейс и API доступны на `http://localhost:8080`. Скрипт собирает оба
проекта и помещает готовый интерфейс в `wwwroot` публикации.
Node.js для работы опубликованного приложения не требуется.

Сквозная локальная приёмка опубликованного приложения:

```powershell
./scripts/publish.ps1 -OutputDirectory artifacts/mvp-publish
./scripts/test-e2e.ps1
```

Она использует отдельный PostgreSQL и случайный тестовый токен, создаёт данные
через интерфейс и проверяет сохранность после перезапуска. `-Port 8081 -KeepRunning`
оставляет демонстрацию; `scripts/stop-local-preview.ps1` останавливает её.
Подробности Playwright и переменных окружения — в инструкции запуска выше.

## Совместный запуск в Docker

```powershell
docker compose up --build -d
```

Откройте `http://localhost:8080`. Приложение ждёт готовности PostgreSQL.
После создания базы примените миграции командой выше, указав в локальных
настройках тот же пароль, что в `.env`. До этого `/api/health/ready` вернёт 503.
Compose привязывает порты к локальному компьютеру. Для доступа из Telegram
нужен публичный HTTPS-адрес, настроенный отдельно.

## Подключение Telegram-бота

Бот выключен по умолчанию: каталог можно проверить без токена и сетевых
обращений к Bot API. После создания бота и размещения приложения задайте
`Telegram:Enabled = true`, `Telegram:BotToken` и `Telegram:MiniAppUrl`
в локальных настройках или через `Telegram__*` переменные окружения.
В Compose соответствующие переменные находятся в `.env.example`.

При `/start` в личном чате бот отправит кнопку «Открыть магазин».
`MiniAppUrl` должен быть публичным HTTPS-адресом именно опубликованного
приложения. Локальные HTTP-адреса для этого не подходят.
При включённом боте отсутствие токена или HTTPS-адреса блокирует запуск.

Сейчас используется long polling: запускайте только один экземпляр бота
с данным токеном; существующий webhook необходимо предварительно отключить.
Вход использует исходные `Telegram.WebApp.initData` в заголовке `Authorization: tma …`.
Сервер проверяет подпись и возраст (по умолчанию час; настройка
`Telegram:InitDataMaxAgeSeconds`), затем роль из БД. Каталог публичен.
В Production защищённые запросы требуют HTTPS; при завершении TLS на прокси
нужно настроить доверенную передачу протокола до приложения.

Для назначения первого администратора после применения миграций выполните
локально, указав настоящий Telegram ID вместо примера:

```powershell
dotnet run --project backend/CosmeticsShop.Api -- --grant-admin 123456789
```

Команда использует настроенное подключение к БД и завершает работу без запуска
бота/HTTP-сервера. Публичного endpoint выдачи ролей нет. Токен храните в локальном
`appsettings.Local.json` или переменных окружения; не добавляйте его в репозиторий.

## Временный localhost.run для локальной демонстрации

Если уже запущена локальная демонстрация с `artifacts/local-preview.json`,
доступны Node.js и встроенный SSH, запустите:

```powershell
node scripts/local-tunnel.cjs
```

Помощник поддерживает SSH, принимает новые адреса localhost.run и проверяет
`/api/health/ready` перед их сохранением. Текущий адрес и PID находятся в
`artifacts/local-tunnel/state.json`. Файл `appsettings.Tunnel.json` содержит
только URL; бот читает изменения без перезапуска. Этот файл исключён из Git,
Docker-контекста и публикации. Токен помощнику не нужен.

Для такого режима не задавайте `Telegram__MiniAppUrl`: переменные окружения
имеют приоритет над обновляемым файлом. Настройки токена, роли и доверенного
прокси остаются обязательными. При смене каталога публикации перезапустите
помощник, чтобы он использовал новый путь из метаданных.

Остановка — Ctrl+C в окне помощника либо `scripts/stop-local-tunnel.ps1`.
Приложение и база при этом продолжают работать. После смены адреса нужен новый
`/start`: кнопки из старых сообщений могут устареть. Временный туннель не заменяет
постоянный сервер. Открытие каталога ещё не подтверждает успешный вход Telegram.
