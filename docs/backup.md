# Резервная копия базы магазина (R09)

Анализ и выбор подхода — [operations-analysis.md](operations-analysis.md#r09--резервная-копия-и-проверенное-восстановление-локально).
Скрипт: `scripts/database-backup.cjs` (Node.js 24 и инструменты PostgreSQL 18).

## Что делает

- `backup` — логическая копия `pg_dump --format=custom --no-owner` без остановки
  магазина. Рядом с копией пишется `.json`: время, версия PostgreSQL, последняя
  миграция, SHA-256 и «отпечаток» каждой таблицы (число строк и хэш содержимого).
  Отпечаток снимается в том же снимке данных, что и копия, поэтому совпадает с ней
  даже при одновременной работе администратора.
- `verify` — проверяет SHA-256, восстанавливает копию в **отдельную временную** БД
  `shop_restore_check_…`, сравнивает отпечатки таблиц, записывает длительность
  восстановления и возраст копии, удаляет временную БД. Рабочая БД только читается.
- Копия старше 36 ч (`--max-age-hours`) — отказ: значит, ежедневное резервирование
  перестало работать.
- Хранится 14 последних копий (`--keep`); старые удаляются только после успешной новой.
- `status.json` в папке копий: последняя попытка, успех, причина отказа, последняя
  успешная копия и проверка. Код выхода ≠ 0 при любом отказе.
- Пароль передаётся инструментам только через `PGPASSWORD`: он не печатается и не
  попадает в `.json`.

## Настройка на Windows

Подключение берётся из `ConnectionStrings:Shop` в исключённом из Git
`backend/CosmeticsShop.Api/appsettings.Local.json` (или из `SHOP_BACKUP_CONNECTION`).
Для `verify` пользователю нужно право создавать базы; иначе задайте
`SHOP_RESTORE_CONNECTION` — другой сервер или пользователь с этим правом.

Папка копий по умолчанию: `%LOCALAPPDATA%\BarberBot\backups`. Копии содержат
Telegram ID пользователей: не кладите их в репозиторий и в общий доступ. Вторую копию
держите на другом диске или в своей облачной папке (`--out`).

Проверка вручную:

```powershell
node scripts/database-backup.cjs backup
node scripts/database-backup.cjs verify
```

Расписание через Планировщик задач ([schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create)),
от имени текущего пользователя, раз в сутки:

```powershell
$node = (Get-Command node).Source
schtasks /Create /SC DAILY /ST 03:00 /TN "BarberBot backup" /TR "`"$node`" D:\BarberBot\scripts\database-backup.cjs backup"
schtasks /Create /SC DAILY /ST 03:30 /TN "BarberBot backup check" /TR "`"$node`" D:\BarberBot\scripts\database-backup.cjs verify"
```

Результат последнего запуска виден в Планировщике (код 0 — успех) и в `status.json`.
Компьютер должен быть включён в это время; пропущенный запуск обнаружит `verify` по
возрасту копии.

## Восстановление рабочей БД после сбоя

1. Остановить магазин (`scripts/stop-local-preview.ps1` или процесс приложения).
2. Проверить выбранную копию: `node scripts/database-backup.cjs verify --file shop-YYYYMMDD-HHmmss.dump`.
3. Создать пустую БД и восстановить в неё (пример для БД `cosmetics`, владелец `cosmetics`):

   ```powershell
   & 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -U postgres -c "CREATE DATABASE cosmetics_restored OWNER cosmetics TEMPLATE template0"
   & 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' -U cosmetics --no-owner --exit-on-error -d cosmetics_restored "$env:LOCALAPPDATA\BarberBot\backups\shop-YYYYMMDD-HHmmss.dump"
   ```

4. Указать `Database=cosmetics_restored` в `appsettings.Local.json` и запустить магазин.
   Старую БД не удалять, пока новая не проверена в работе.

## Проверки

`tests/backup/database-backup.test.cjs` на отдельном тестовом PostgreSQL 18
(`SHOP_TEST_ADMIN_CONNECTION`): копия и восстановление, согласованность при
одновременной записи, срок хранения, повреждённая копия, недоступная БД, параллельный
запуск, устаревшая копия, расхождение содержимого, отсутствие пароля в выводе.
