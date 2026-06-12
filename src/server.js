const http = require('http');
const { PORT } = require('./config');
const { createRequestHandler } = require('./admin');
const { getBot } = require('./bot');

function startServer(startBot) {
  const server = http.createServer(createRequestHandler(getBot));

  server.listen(PORT, () => {
    console.log(`后台管理系统已启动：http://localhost:${PORT}/admin`);
    try {
      startBot();
    } catch (error) {
      console.error('机器人启动失败：', error);
    }
  });

  return server;
}

module.exports = {
  startServer,
};
