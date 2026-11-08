# Прокси для Telegram Bot API (сервер в России)

Дата: 8 ноября 2026. Задача: разместить приложение на российском VPS, где
`api.telegram.org` без прокси недоступен, без аренды отдельного зарубежного сервера.
У владельца есть подписка на VPN-сервис с ключом VLESS.

## Анализ

**Поведение.** Бот получает обновления long polling и отвечает через Bot API.
Это единственный исходящий трафик к Telegram: Mini App загружается клиентом
напрямую с нашего домена, подпись `initData` проверяется локально по токену.
Значит, через туннель нужно пускать только HTTP-клиент бота. Весь сервер
через VPN заворачивать не нужно: это ломает входящий HTTPS и доступ клиентов из РФ.

**Выбранный подход.** На сервере работает VPN-клиент xray с исходящим соединением
по ключу VLESS и локальным SOCKS5-входом `127.0.0.1:1080`. В приложении есть
необязательная настройка `Telegram:ProxyUrl`. Если она задана, HTTP-клиент бота
(`SocketsHttpHandler` + `WebProxy`) ходит через этот прокси. Если пустая,
поведение прежнее.

**Требования и ошибки.**
- Поддерживаются схемы `http`, `https`, `socks4`, `socks4a`, `socks5`. Логин, путь
  и query в адресе запрещены: локальному прокси пароль не нужен, а секрет в адресе
  попал бы в конфиг и логи. Неверный адрес блокирует запуск, и сообщение об ошибке
  не повторяет значение.
- `socks5h` в .NET не поддерживается и отклоняется. Он и не нужен: SOCKS5-клиент
  .NET передаёт прокси имя хоста, поэтому `api.telegram.org` разрешается на той
  стороне, и подмена DNS в РФ не мешает. Это проверено тестом.
- Адрес прокси читается при запуске, после изменения нужен перезапуск.
- При обрыве туннеля каждая ошибка пишется как предупреждение (как раньше), без
  URL и текста исключения, где может быть токен. После 6 ошибок подряд пишется
  одна запись уровня Error («бот не отвечает, проверьте VPN»), а при
  восстановлении — Information с числом неудачных попыток.

**Отклонённые варианты.** Весь трафик сервера через VPN: ломает входящие
соединения. Бесплатные публичные прокси: нестабильны, оператор видит трафик.
Serverless-ретранслятор как `baseUrl`: Cloudflare в РФ замедляют; можно добавить
позже, если VLESS будет заблокирован. Локальный `telegram-bot-api`: ему тоже нужен
выход к Telegram, проблему он не решает.

**Риски.** Ключи VPN-сервисов блокируют, поэтому стоит держать 2–3 ключа (у xray
можно задать несколько исходящих). Сервер занимает одно устройство из лимита
подписки. Оферты некоторых хостеров запрещают VPN/прокси на сервере; исходящий
клиент одного приложения — не размещение VPN-сервиса, но формулировки размыты.
Таблица рисков — в обсуждении с владельцем 08.11.2026.

### Источники (проверены 08.11.2026)

- [.NET 6: поддержка SOCKS-прокси в HttpClient](https://devblogs.microsoft.com/dotnet/dotnet-6-networking-improvements/#socks-proxy-support): схемы socks4/4a/5 через `WebProxy`.
- [SocketsHttpHandler.Proxy](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.socketshttphandler.proxy).
- [Xray: установка как systemd-сервис](https://github.com/XTLS/Xray-install) и [формат конфигурации](https://xtls.github.io/en/config/).
- [Telegram Bot API: получение обновлений](https://core.telegram.org/bots/api#getting-updates).
- Недоступность `api.telegram.org` с российских VPS: [vc.ru, 15.03.2026](https://vc.ru/id5779154/2795944-blokirovka-telegram-api-v-rossii), [AffTimes, 19.03.2026](https://afftimes.com/news/oshibka-504-i-taimauty/).
- Правила для хостеров: [Теплица, 05–07.2026](https://te-st.org/2026/05/12/hostingrules/), [CNews, 01.10.2026](https://www.cnews.ru/news/top/2026-10-01_po_vpn_v_rossii_nanesen_tyazhelejshij).

### Критерии приёмки

- [x] Без `Telegram:ProxyUrl` бот работает как раньше (существующие тесты бота).
- [x] С `http://` прокси запрос к Telegram уходит как `CONNECT api.telegram.org:443`.
- [x] С `socks5://` прокси передаётся имя хоста, а не IP.
- [x] Неверный адрес блокирует запуск, значение в ошибке не печатается.
- [x] В логе: адрес прокси без секретов, одна ошибка после серии сбоев, запись о восстановлении, без токена.
- [ ] Проверка на настоящем российском VPS с ключом VLESS (после аренды сервера).

## Установка на сервер (Ubuntu/Debian)

Ключ VLESS — секрет, не храните его в репозитории и не пересылайте в чатах.

1. Проверить, что напрямую Telegram недоступен (ожидается таймаут):
   `curl -m 10 -sS https://api.telegram.org -o /dev/null -w '%{http_code}\n'`.
2. Установить xray как systemd-сервис:
   `sudo bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install`.
3. Разобрать ключ `vless://UUID@HOST:PORT?type=tcp&security=reality&sni=SNI&fp=FP&pbk=PBK&sid=SID&flow=FLOW#имя`
   и заполнить `/usr/local/etc/xray/config.json`:

   ```json
   {
     "log": { "loglevel": "warning" },
     "inbounds": [
       { "listen": "127.0.0.1", "port": 1080, "protocol": "socks", "settings": { "udp": false } }
     ],
     "outbounds": [
       {
         "protocol": "vless",
         "settings": {
           "vnext": [ { "address": "HOST", "port": PORT,
             "users": [ { "id": "UUID", "encryption": "none", "flow": "FLOW" } ] } ]
         },
         "streamSettings": {
           "network": "tcp",
           "security": "reality",
           "realitySettings": { "serverName": "SNI", "fingerprint": "FP",
             "publicKey": "PBK", "shortId": "SID" }
         }
       }
     ]
   }
   ```

   Если в ключе нет `flow`, удалите это поле. Если `security=tls` вместо `reality`,
   замените блок на `"security": "tls", "tlsSettings": { "serverName": "SNI", "fingerprint": "FP" }`.
   При `type=ws` или `grpc` нужны соответствующие `wsSettings`/`grpcSettings` из ключа.
4. Запустить и проверить:
   `sudo systemctl enable --now xray && sudo systemctl status xray`, затем
   `curl -m 15 --socks5-hostname 127.0.0.1:1080 https://api.telegram.org -o /dev/null -w '%{http_code}\n'`
   (ожидается код `302`).
5. Порт 1080 должен слушать только `127.0.0.1`: открытый наружу прокси быстро
   найдут, и хостер заблокирует сервер. Проверка: `ss -ltnp | grep 1080`.
6. Указать приложению `Telegram__ProxyUrl=socks5://127.0.0.1:1080` и перезапустить его.
   В логе появится `Telegram requests go through proxy socks5://127.0.0.1:1080.`

**Приложение в Docker Compose.** Внутри контейнера `127.0.0.1` — сам контейнер.
В `compose.yaml` для приложения добавлено имя `host.docker.internal`. Пусть xray
слушает адрес моста Docker (обычно `172.17.0.1`, см. `ip addr show docker0`)
вместо `127.0.0.1`, а в `.env` укажите
`TELEGRAM_PROXY_URL=socks5://host.docker.internal:1080`. Фаервол должен закрывать
этот порт снаружи. Этот вариант на сервере пока не проверялся.

## Проверки и ревью

Автоматические тесты (`TelegramProxyTests`, `TelegramWorkerTests`): проверка
адресов, отказ запуска при неверном адресе, настоящие HTTP CONNECT и SOCKS5
рукопожатия на локальном сокете, журнал при сбоях и восстановлении. Полный прогон
описан в PR. Ревью: отдельный проход автора (Claude), не независимое ревью.
Проверка на настоящем Telegram и российском VPS не выполнялась.
