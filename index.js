const { ensureFolders } = require('./src/storage');
const { startBot } = require('./src/bot');
const { startServer } = require('./src/server');

process.on('uncaughtException', (error) => {
  console.error('未捕获异常：', error);
});

process.on('unhandledRejection', (error) => {
  console.error('未处理 Promise 错误：', error);
});

ensureFolders();
startServer(startBot);
