# Диагностика входа и сохранения (R01)

Каждый ответ API несёт заголовок `X-Request-Id` — 32 шестнадцатеричных символа
(TraceId текущего запроса). В ответах с ошибкой то же значение лежит в поле
`requestId`, а поле `code` содержит стабильный код класса ошибки. Интерфейс
показывает первые 8 символов как «Код обращения», по ним запрос находится в журнале.

## Коды ошибок

| Код | HTTP | Что случилось |
| --- | --- | --- |
| `auth_missing` | 401 | Нет данных входа Telegram: магазин открыт не из Telegram. |
| `auth_invalid` | 401 | Подпись initData не сошлась или заголовок испорчен. |
| `auth_expired` | 401 | Подпись верна, но вход старше `Telegram:InitDataMaxAgeSeconds` (по умолчанию час). |
| `user_not_found` | 401 | `/api/me`: пользователя нет в БД. |
| `forbidden` | 403 | Вход подтверждён, но нет роли администратора. |
| `secure_transport_unavailable` | 503 | Сервер не подтвердил HTTPS за прокси; операция не выполнялась. |
| `validation_failed` | 400 | Неверные данные формы. |
| `not_found` | 404 | Запись или адрес не найдены. |
| `conflict` | 409 | Дубликат или устаревшая версия записи. |
| `database_unavailable` | 503 | Нет связи с БД. Для записи исход неизвестен: проверить, прежде чем повторять. |
| `service_unavailable` | 503 | Прочий отказ 503. |
| `internal_error` | 500 | Необработанная ошибка сервера. |

Только на клиенте, без ответа сервера: `network_error` (чтение не дошло) и
`outcome_unknown` (запись отправлена, ответа нет, изменения могли сохраниться).

## Строка журнала

Для каждого запроса `/api/*`, кроме `/api/health/*`, категория `CosmeticsShop.Requests`
пишет одну строку:

```
operation=save method=POST route=/api/admin/brands status=201 code=ok elapsed_ms=41.7 auth_ms=3.2 request=4bf92f3577b34da6a3ce929d0e0e4736
```

- `operation`: `login` (POST `/api/auth/telegram`), `save` (не GET в `/api/admin`), иначе `read`.
- `route` — шаблон маршрута (`/api/admin/products/{id:long}`), а не фактический путь.
- `auth_ms` — время проверки Telegram и роли; пусто, если заголовка не было.
- Уровень Warning для статуса ≥ 500 и для `client_aborted` (клиент закрыл соединение).

В журнал не попадают заголовки, тело запроса, query-строка, initData, хэш подписи
и Telegram ID. Это проверяет `DiagnosticsHttpTests`.

## Найти обращение по коду из интерфейса

```bash
docker compose logs app | grep 'request=4bf92f35'
```

## Доли успешных входов и сохранений

Исходные замеры собираются из этих строк на реальном трафике после развёртывания
(команды ниже — для `deploy/compose.yaml` из R08, сервис `app`).
Подтверждённый отказ (4xx, `secure_transport_unavailable`) и неизвестный исход
(`database_unavailable` на записи, `internal_error`, `client_aborted`) считаются
раздельно. Сетевые обрывы без ответа сервера в журнал сервера не попадают по
определению; их видно только по жалобам с текстом «Связь прервалась».

```bash
docker compose logs --since 24h app | grep -o 'operation=\(login\|save\) [^ ]* [^ ]* status=[0-9]* code=[a-z_]*' \
  | awk '{print $1, $5}' | sort | uniq -c | sort -rn
```

Пример вывода: `120 operation=login code=ok`, `3 operation=login code=auth_expired`.
