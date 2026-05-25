# Bikegame Backend

В этом каталоге лежат backend-заготовки для той же схемы, что использовалась в `SPAR Discount Wheel`:

- `yandex-ingest-function/` — принимает события аналитики из игры
- `yandex-player-state-function/` — хранит прогресс игрока по `playerId`
- `yandex-report-function/` — собирает события и отдает выгрузку `ZIP/CSV/JSON`

## Что подключить на фронте

В `index.html` уже есть поддержка:

```html
<script>
  window.BIKEGAME_INTEGRATION = {
    metricaId: 12345678,
    backendEventEndpoint: "https://functions.yandexcloud.net/INGEST_FUNCTION_ID"
  };

  window.BIKEGAME_REPORT_CONFIG = {
    reportEndpoint: "https://functions.yandexcloud.net/REPORT_FUNCTION_ID"
  };
</script>
```

Для WebView игрока:

```js
window.bikegameSetPlayerContext({
  playerId: "123456",
  label: "Игрок 123456"
});
```

## Для player state endpoint

Игра уже работает с:

```text
/api/player/state
```

Если ты используешь reverse proxy или backend приложения, направь этот маршрут на функцию `yandex-player-state-function`.

## Минимальные env для Yandex функций

### Ingest

```text
ALLOWED_ORIGIN=https://olegskybi.github.io
YC_ACCESS_KEY_ID=...
YC_SECRET_ACCESS_KEY=...
YC_EVENTS_BUCKET=...
YC_EVENTS_PREFIX=bikegame-events
YC_REGION=ru-central1
```

### Player state

```text
ALLOWED_ORIGIN=https://olegskybi.github.io
YC_ACCESS_KEY_ID=...
YC_SECRET_ACCESS_KEY=...
YC_PLAYER_STATE_BUCKET=...
YC_PLAYER_STATE_PREFIX=player-state
YC_REGION=ru-central1
```

### Report

```text
ALLOWED_ORIGIN=https://olegskybi.github.io
REPORT_PASSWORD=...
YC_ACCESS_KEY_ID=...
YC_SECRET_ACCESS_KEY=...
YC_EVENTS_BUCKET=...
YC_EVENTS_PREFIX=bikegame-events
YC_PLAYER_STATE_BUCKET=...
YC_PLAYER_STATE_PREFIX=player-state
YC_REGION=ru-central1
```

## Страница отчета

После публикации статическая страница доступна как:

```text
/report.html
```

Если endpoint не зашит в `window.BIKEGAME_REPORT_CONFIG`, его можно передать query-параметром:

```text
report.html?reportEndpoint=https://functions.yandexcloud.net/REPORT_FUNCTION_ID
```
