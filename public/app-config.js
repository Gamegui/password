// Публичная конфигурация SafeKey (значения НЕ секретные и попадают в сборку).
//
// ClientID OAuth-приложений: их же можно ввести прямо в приложении
// («Синхронизация» → «Подключить облако» или экран «Облачный сейф»).
// Как получить — см. README, раздел «Настройка синхронизации».
window.SAFEKEY_CONFIG = {
  // https://oauth.yandex.ru/client/new — платформа «Веб-сервисы»,
  // доступ «Яндекс Диск REST API → Доступ к папке приложения»
  YANDEX_CLIENT_ID: '',
  // https://console.cloud.google.com/apis/credentials — OAuth-клиент
  // «Web application», scope drive.appdata (appDataFolder).
  // Client Secret сюда НЕ кладите: он вводится в самом приложении (карточка
  // Google Drive) и хранится только в localStorage браузера — в открытом
  // коде репозитория секрета нет.
  GOOGLE_CLIENT_ID: ''
}
