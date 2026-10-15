// Запуск: node server.cjs (Node.js 24 или новее). Установка npm-пакетов не нужна.
import('./src/server/node-server.mjs').catch(error => {
  console.error('Не удалось запустить «Смену»:', error.message);
  process.exitCode = 1;
});
