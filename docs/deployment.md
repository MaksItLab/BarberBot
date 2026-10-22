# Постоянное размещение на VPS (R08)

Схема: один VPS с Docker. Caddy принимает HTTPS на 443, сам получает и продлевает
сертификат Let's Encrypt и передаёт запросы приложению. Приложение и PostgreSQL
наружу не открыты. Файлы — в каталоге [deploy](../deploy).

```
Telegram / браузер ──HTTPS──> Caddy (172.30.0.10) ──HTTP──> app:8080 ──> postgres:5432
                              сеть edge                     сети edge + data   сеть data (internal)
```

## Анализ и выбранное решение — 22.10.2026

Источники (проверены 22.10.2026):

- [Caddy: reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) —
  Caddy сам выставляет `X-Forwarded-Proto` и игнорирует такие заголовки от клиента,
  пока не настроен `trusted_proxies`. Значит, подделать протокол через Caddy нельзя.
- [ASP.NET Core: proxy servers](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/proxy-load-balancer?view=aspnetcore-10.0) —
  заголовки принимаются только от явно доверенного адреса прокси.
- [EF Core: Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) —
  для автоматизации рекомендован migration bundle, запускаемый отдельной разовой
  задачей после готовности БД; применять миграции при старте приложения не советуют.

Решения:

- **Доверенный прокси без изменения кода.** У Caddy фиксированный адрес `172.30.0.10`
  в сети `edge`, он же передан в `ReverseProxy__KnownProxy`. Динамические адреса
  выдаются из `172.30.0.128/25`, поэтому `.10` не может занять другой контейнер.
  Запрос к приложению в обход Caddy с поддельным `X-Forwarded-Proto` получает 503,
  как и раньше. Проверка HTTPS не ослаблена.
- **Миграции — отдельной командой** `docker compose run --rm migrate` (цель
  `migrations` в Dockerfile, EF bundle). Приложение по-прежнему само их не применяет.
- **PostgreSQL** находится только во внутренней сети `data`: без опубликованного порта
  и без выхода наружу.
- **Сборка на сервере** из исходников (`--build`). Готовые образы из GitHub Actions
  можно добавить позже без изменения схемы.
- **Бот** работает через long polling. Перед включением на сервере его нужно
  остановить на ноутбуке: один токен — один экземпляр.

Рассмотрены и отклонены: nginx + certbot (больше ручной настройки сертификатов),
применение миграций при старте (против рекомендации EF Core), доверие всей
подсети Docker (шире, чем нужно).

## Что нужно заранее

1. VPS с Ubuntu 24.04, от 2 ГБ RAM (сборка .NET и фронтенда на 1 ГБ может не
   поместиться в память; тогда добавьте swap).
2. Домен с A-записью на IP сервера. Сертификат выдаётся, только когда запись уже
   действует (проверка: `nslookup shop.example.ru`).
3. Открытые порты 22, 80 и 443.

## Первый запуск

На сервере под пользователем с sudo:

```bash
# Docker Engine и Compose: https://docs.docker.com/engine/install/ubuntu/
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # затем перелогиньтесь

sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable

git clone https://github.com/<владелец>/<репозиторий>.git barbershop
cd barbershop/deploy
cp .env.example .env
nano .env          # DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD (openssl rand -base64 32)

docker compose up -d --build postgres
docker compose run --rm migrate
docker compose up -d --build
curl https://<домен>/api/health/ready   # ожидается ответ 200 со статусом ready
```

Назначить администратора (настоящий Telegram ID):

```bash
docker compose run --rm app --grant-admin 123456789
```

Включить бота: остановить его на ноутбуке, в `.env` задать `TELEGRAM_ENABLED=true`
и `TELEGRAM_BOT_TOKEN`, затем `docker compose up -d`. После этого отправить
боту `/start` заново: кнопки в старых сообщениях ведут на старый адрес.

## Обновление

```bash
cd barbershop && git pull
cd deploy
docker compose exec -T postgres pg_dump -U cosmetics -Fc cosmetics > ~/backup-$(date +%F-%H%M).dump
docker compose build
docker compose run --rm migrate
docker compose up -d
curl https://<домен>/api/health/ready
```

`docker compose up -d` пересоздаёт только изменившиеся контейнеры. Данные хранятся
в томе `postgres_data`, а сертификаты — в `caddy_data`. Команда `docker compose down -v`
удаляет тома вместе с данными, на сервере её не выполнять.

## Откат

1. `git checkout <предыдущий тег или коммит>`, затем `docker compose build && docker compose up -d`.
2. Если новая версия применила миграции, несовместимые со старым кодом, восстановите
   дамп, сделанный перед обновлением:
   `docker compose exec -T postgres pg_restore -U cosmetics -d cosmetics --clean --if-exists < ~/backup-….dump`.
   Откат миграций через bundle выполняет `Down` и может удалить данные. Использовать
   его можно только после проверки на копии БД.

Полноценное расписание резервных копий и проверка восстановления — задача R09.

## Диагностика

```bash
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 caddy   # ошибки получения сертификата
```

`ready` возвращает 503: БД недоступна или не применены миграции.
`secure_transport_unavailable` при входе: запрос пришёл не через Caddy или
изменился адрес Caddy. Сравните `ipv4_address` и `ReverseProxy__KnownProxy` в `compose.yaml`.

## Проверка — 22.10.2026

Выполнена локально в Docker (не на VPS). Caddy был запущен с `DOMAIN=localhost` и
внутренним сертификатом вместо Let's Encrypt.

- Образы `runtime` и `migrations` собираются. Корневой `compose.yaml` по-прежнему
  собирает `runtime` (последняя стадия Dockerfile).
- `ready` возвращает 503 до миграций и 200 после них. Повторный `migrate` выводит
  «No migrations were applied».
- Каталог и интерфейс через Caddy возвращают 200, HTTP перенаправляется на HTTPS (308).
- Подписанный initData администратора через Caddy: вход 200 (роль Admin), создание бренда 201.
  Это сценарий исходного сбоя «HTTPS check failed».
- Неверный initData через Caddy возвращает 401, а не 503: протокол определён верно.
- Прямой HTTP-запрос к app с поддельным `X-Forwarded-Proto: https` возвращает 503
  `secure_transport_unavailable`.
- PostgreSQL недоступен из сети `edge`.
- После `down`/`up` без удаления томов данные сохраняются: 1 бренд, 1 пользователь.
- `--grant-admin` через `docker compose run` работает.

Не проверено: настоящий домен и Let's Encrypt, работа на VPS, вход с телефона
через Telegram, бот на сервере. Это делается при развёртывании вместе с владельцем.
Интеграционные тесты .NET не перезапускались: C#-код не менялся.
