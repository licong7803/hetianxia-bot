const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const LOCK_FILE = path.join(ROOT_DIR, '.bot.lock');

loadEnvFile();

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(ROOT_DIR, 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

ensureFolders();

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const TELEGRAM_PROXY = getTelegramProxy();
const sessions = new Map();

let bot = null;

function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  }
}

function ensureFolders() {
  for (const folder of [DATA_DIR, PUBLIC_DIR, UPLOADS_DIR]) {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  }

  if (!fs.existsSync(STORE_FILE)) {
    writeStore({
      products: [],
      orders: [],
      users: [],
      broadcasts: [],
      settings: {
        storeName: '盒天下',
        supportText: '请联系人工客服完成付款和发货。',
        usdtAddress: '',
        wechatQr: ''
      }
    });
  }
}

function readStore() {
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}

function writeStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function textResponse(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(text);
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const parts = cookie.split(';').map((item) => item.trim());
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === name) return decodeURIComponent(value || '');
  }
  return '';
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createSession() {
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, { createdAt: Date.now() });
  return `${id}.${sign(id)}`;
}

function isAuthenticated(req) {
  const raw = getCookie(req, 'admin_session');
  const [id, signature] = raw.split('.');
  if (!id || !signature) return false;
  if (sign(id) !== signature) return false;
  return sessions.has(id);
}

function clearSession(req) {
  const raw = getCookie(req, 'admin_session');
  const [id] = raw.split('.');
  if (id) sessions.delete(id);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 12 * 1024 * 1024) {
        reject(new Error('请求内容太大，图片请控制在 10MB 以内。'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('请求格式不是有效 JSON。'));
      }
    });
    req.on('error', reject);
  });
}

function saveImageFromDataUrl(dataUrl) {
  if (!dataUrl) return '';
  const match = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/);
  if (!match) throw new Error('只支持 png、jpg、webp、gif 图片。');

  const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
  const filename = `${createId('image')}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(match[3], 'base64'));
  return `/uploads/${filename}`;
}

function getUploadedFilePath(imageUrl) {
  return path.join(UPLOADS_DIR, path.basename(imageUrl || ''));
}

function getRequestPath(req) {
  return new URL(req.url, `http://${req.headers.host}`).pathname;
}

function serveFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    textResponse(res, 404, 'Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.username === ADMIN_USERNAME && body.password === ADMIN_PASSWORD) {
        const session = createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `admin_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      jsonResponse(res, 401, { ok: false, message: '账号或密码错误' });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      clearSession(req);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!isAuthenticated(req)) {
      jsonResponse(res, 401, { ok: false, message: '请先登录后台' });
      return;
    }

    const store = readStore();

    if (pathname === '/api/me' && req.method === 'GET') {
      jsonResponse(res, 200, { username: ADMIN_USERNAME });
      return;
    }

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      jsonResponse(res, 200, {
        productCount: store.products.length,
        activeProductCount: store.products.filter((item) => item.active).length,
        orderCount: store.orders.length,
        userCount: store.users.length,
        pendingShipCount: store.orders.filter((item) => item.status === '待发货').length
      });
      return;
    }

    if (pathname === '/api/products' && req.method === 'GET') {
      jsonResponse(res, 200, store.products);
      return;
    }

    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await parseBody(req);
      const imageUrl = saveImageFromDataUrl(body.imageData);
      const product = normalizeProduct({ ...body, id: createId('product'), imageUrl });
      store.products.unshift(product);
      writeStore(store);
      jsonResponse(res, 201, product);
      return;
    }

    const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch && req.method === 'PUT') {
      const body = await parseBody(req);
      const product = store.products.find((item) => item.id === productMatch[1]);
      if (!product) return jsonResponse(res, 404, { message: '商品不存在' });
      const imageUrl = body.imageData ? saveImageFromDataUrl(body.imageData) : product.imageUrl;
      Object.assign(product, normalizeProduct({ ...product, ...body, imageUrl, id: product.id }));
      writeStore(store);
      jsonResponse(res, 200, product);
      return;
    }

    if (productMatch && req.method === 'DELETE') {
      store.products = store.products.filter((item) => item.id !== productMatch[1]);
      writeStore(store);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
      jsonResponse(res, 200, store.orders);
      return;
    }

    const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && req.method === 'PUT') {
      const body = await parseBody(req);
      const order = store.orders.find((item) => item.id === orderMatch[1]);
      if (!order) return jsonResponse(res, 404, { message: '订单不存在' });
      const nextStatus = body.status || order.status;
      if (nextStatus === '已完成' && !order.stockDeducted) {
        const product = store.products.find((item) => item.id === order.productId);
        if (product) {
          product.stock = Math.max(0, Number(product.stock || 0) - 1);
          order.stockDeducted = true;
        }
      }
      order.status = nextStatus;
      order.note = body.note || '';
      order.updatedAt = new Date().toISOString();
      writeStore(store);
      jsonResponse(res, 200, order);
      return;
    }

    if (pathname === '/api/users' && req.method === 'GET') {
      jsonResponse(res, 200, store.users);
      return;
    }

    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && req.method === 'PUT') {
      const body = await parseBody(req);
      const user = store.users.find((item) => String(item.telegramId) === userMatch[1]);
      if (!user) return jsonResponse(res, 404, { message: '用户不存在' });
      user.banned = Boolean(body.banned);
      writeStore(store);
      jsonResponse(res, 200, user);
      return;
    }

    const userMessageMatch = pathname.match(/^\/api\/users\/([^/]+)\/message$/);
    if (userMessageMatch && req.method === 'POST') {
      const body = await parseBody(req);
      if (!bot) return jsonResponse(res, 400, { message: '机器人未启动，请检查 BOT_TOKEN。' });
      await bot.sendMessage(userMessageMatch[1], body.text || '');
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/broadcasts' && req.method === 'GET') {
      jsonResponse(res, 200, store.broadcasts);
      return;
    }

    if (pathname === '/api/broadcasts' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!bot) return jsonResponse(res, 400, { message: '机器人未启动，请检查 BOT_TOKEN。' });
      const imageUrl = saveImageFromDataUrl(body.imageData);
      let successCount = 0;
      let failCount = 0;

      for (const user of store.users.filter((item) => !item.banned)) {
        try {
          if (imageUrl) {
            await bot.sendPhoto(user.telegramId, getUploadedFilePath(imageUrl), { caption: body.text || '' });
          } else {
            await bot.sendMessage(user.telegramId, body.text || '');
          }
          successCount += 1;
        } catch (error) {
          failCount += 1;
        }
      }

      const broadcast = {
        id: createId('broadcast'),
        text: body.text || '',
        imageUrl,
        successCount,
        failCount,
        createdAt: new Date().toISOString()
      };
      store.broadcasts.unshift(broadcast);
      writeStore(store);
      jsonResponse(res, 201, broadcast);
      return;
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      jsonResponse(res, 200, store.settings);
      return;
    }

    if (pathname === '/api/settings' && req.method === 'PUT') {
      const body = await parseBody(req);
      store.settings = {
        storeName: String(body.storeName || '盒天下'),
        supportText: String(body.supportText || ''),
        usdtAddress: String(body.usdtAddress || ''),
        wechatQr: body.wechatQrData ? saveImageFromDataUrl(body.wechatQrData) : String(body.wechatQr || store.settings.wechatQr || '')
      };
      writeStore(store);
      jsonResponse(res, 200, store.settings);
      return;
    }

    jsonResponse(res, 404, { message: '接口不存在' });
  } catch (error) {
    jsonResponse(res, 500, { message: error.message || '服务器错误' });
  }
}

function normalizeProduct(input) {
  return {
    id: input.id,
    name: String(input.name || '').trim(),
    description: String(input.description || '').trim(),
    price: Number(input.price || 0),
    stock: Number(input.stock || 0),
    active: input.active !== false,
    imageUrl: input.imageUrl || '',
    updatedAt: new Date().toISOString(),
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function getTelegramProxy() {
  const proxy = process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME);
  const isLocalProxy = /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(proxy);
  const isValidProxyUrl = /^(https?|socks4?|socks5):\/\//i.test(proxy);

  if (proxy && !isValidProxyUrl) {
    console.log('检测到 TELEGRAM_PROXY/HTTP_PROXY/HTTPS_PROXY 不是有效代理地址，已忽略。代理地址必须以 http://、https:// 或 socks:// 开头。');
    return '';
  }

  if (isRailway && isLocalProxy) {
    console.log('检测到 Railway 上配置了本地代理地址，已忽略 TELEGRAM_PROXY。Railway 通常不需要 Telegram 代理。');
    return '';
  }

  return proxy;
}

function handleWeb(req, res) {
  const pathname = getRequestPath(req);

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname);
    return;
  }

  if (pathname === '/' || pathname === '/admin') {
    serveFile(res, path.join(PUBLIC_DIR, 'admin.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    const safeName = path.basename(pathname);
    const ext = path.extname(safeName).toLowerCase();
    const typeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    };
    serveFile(res, path.join(UPLOADS_DIR, safeName), typeMap[ext] || 'application/octet-stream');
    return;
  }

  textResponse(res, 404, 'Not found');
}

function rememberUser(msg) {
  return rememberTelegramUser(msg.chat.id, msg.from || {});
}

function rememberTelegramUser(telegramId, from) {
  const store = readStore();
  let user = store.users.find((item) => item.telegramId === telegramId);
  if (!user) {
    user = {
      telegramId,
      username: from?.username || '',
      firstName: from?.first_name || '',
      lastName: from?.last_name || '',
      banned: false,
      purchaseHistory: [],
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    store.users.unshift(user);
  } else {
    user.username = from?.username || user.username;
    user.firstName = from?.first_name || user.firstName;
    user.lastName = from?.last_name || user.lastName;
    user.lastSeenAt = new Date().toISOString();
  }
  writeStore(store);
  return user;
}

function isUserBanned(telegramId) {
  const store = readStore();
  const user = store.users.find((item) => item.telegramId === telegramId);
  return Boolean(user?.banned);
}

function productKeyboard(products) {
  const rows = products.map((product) => ([{
    text: `${product.name} - ${product.price} USDT`,
    callback_data: `buy:${product.id}`
  }]));
  rows.push([{ text: '联系客服', callback_data: 'support' }]);
  return { inline_keyboard: rows };
}

function startBot() {
  if (!BOT_TOKEN) {
    console.log('未配置 BOT_TOKEN，Telegram 机器人不会启动；后台仍可使用。');
    return;
  }

  if (!/^\d+:[A-Za-z0-9_-]+$/.test(BOT_TOKEN)) {
    console.error('BOT_TOKEN 格式不正确。请打开 .env，填入 BotFather 给你的完整 Token。');
    console.error('正确格式类似：1234567890:AA...，中间不能有空格、中文或其它符号。');
    return;
  }

  createLockFile();

  process.on('exit', () => {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const botOptions = { polling: true };
  if (TELEGRAM_PROXY) {
    botOptions.request = { proxy: TELEGRAM_PROXY };
    console.log(`Telegram 代理已启用：${TELEGRAM_PROXY}`);
  }

  bot = new TelegramBot(BOT_TOKEN, botOptions);

  bot.onText(/\/start/, (msg) => {
    const user = rememberUser(msg);
    if (user.banned) {
      bot.sendMessage(msg.chat.id, '你的账号暂时无法使用本机器人。');
      return;
    }

    bot.sendMessage(msg.chat.id, '欢迎使用盒天下！请选择功能：', {
      reply_markup: {
        keyboard: [
          ['商品购买'],
          ['今日价格'],
          ['联系客服']
        ],
        resize_keyboard: true
      }
    });
  });

  bot.on('message', (msg) => {
    rememberUser(msg);
    if (isUserBanned(msg.chat.id)) {
      bot.sendMessage(msg.chat.id, '你的账号暂时无法使用本机器人。');
      return;
    }

    if (msg.photo?.length) {
      savePaymentScreenshot(msg);
      return;
    }

    if (!msg.text || msg.text.startsWith('/')) return;

    const store = readStore();
    if (msg.text === '商品购买' || msg.text === '今日价格') {
      const products = store.products.filter((item) => item.active);
      console.log(`商品列表请求：总商品 ${store.products.length} 个，上架 ${store.products.filter((item) => item.active).length} 个，展示 ${products.length} 个。`);
      if (products.length === 0) {
        bot.sendMessage(msg.chat.id, '当前暂无可售商品，请稍后再来。');
        return;
      }
      bot.sendMessage(msg.chat.id, '请选择商品：', { reply_markup: productKeyboard(products) });
      return;
    }

    if (msg.text === '联系客服') {
      bot.sendMessage(msg.chat.id, store.settings.supportText || '请联系人工客服。');
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    rememberTelegramUser(chatId, query.from || {});
    if (isUserBanned(chatId)) {
      bot.answerCallbackQuery(query.id, { text: '你的账号暂时无法使用本机器人。' });
      return;
    }

    const store = readStore();
    if (query.data === 'support') {
      bot.sendMessage(chatId, store.settings.supportText || '请联系人工客服。');
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (query.data.startsWith('buy:')) {
      const productId = query.data.slice(4);
      const product = store.products.find((item) => item.id === productId);
      if (!product || !product.active || product.stock <= 0) {
        bot.answerCallbackQuery(query.id, { text: '商品已下架或库存不足。' });
        return;
      }

      const order = {
        id: createId('order'),
        productId: product.id,
        productName: product.name,
        price: product.price,
        telegramId: chatId,
        username: query.from?.username || '',
        status: '待付款',
        paymentImageUrl: '',
        note: '',
        stockDeducted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      store.orders.unshift(order);
      const user = store.users.find((item) => item.telegramId === chatId);
      if (user) user.purchaseHistory.unshift(order.id);
      writeStore(store);

      const payLines = [
        `订单已创建：${order.id}`,
        `商品：${product.name}`,
        `价格：${product.price} USDT`,
        '',
        store.settings.usdtAddress ? `USDT 地址：${store.settings.usdtAddress}` : 'USDT 地址：请联系人工客服获取。',
        '',
        '付款后请把付款截图发给客服'
      ].filter(Boolean);

      if (product.imageUrl) {
        try {
          await bot.sendPhoto(chatId, getUploadedFilePath(product.imageUrl), {
            caption: `商品：${product.name}`
          });
        } catch (error) {
          console.error(`发送商品图片失败：${error.message}`);
        }
      }
      bot.sendMessage(chatId, payLines.join('\n'));
      if (store.settings.wechatQr) {
        try {
          await bot.sendPhoto(chatId, getUploadedFilePath(store.settings.wechatQr), {
            caption: '微信收款码'
          });
        } catch (error) {
          console.error(`发送微信收款码失败：${error.message}`);
        }
      }
      bot.answerCallbackQuery(query.id, { text: '订单已创建' });
    }
  });

  bot.on('polling_error', (error) => {
    console.error('Telegram polling_error:', error.message);
    if (String(error.message).includes('409 Conflict')) {
      console.error('原因：同一个 Bot Token 正在被另一个程序使用。请关闭其它 node index.js、部署平台或旧终端。');
      bot.stopPolling();
    } else if (String(error.message).includes('secure TLS connection') || String(error.message).includes('ETIMEDOUT') || String(error.message).includes('ECONNRESET')) {
      console.error('原因：当前终端里的 Node 程序无法连接 Telegram。请检查网络，或在 .env 里配置 TELEGRAM_PROXY。');
    }
  });

  console.log('盒天下 Telegram 机器人已启动。');
}

async function savePaymentScreenshot(msg) {
  const store = readStore();
  const order = store.orders.find((item) => item.telegramId === msg.chat.id && item.status === '待付款');
  if (!order) {
    bot.sendMessage(msg.chat.id, '已收到图片，但没有找到待付款订单。请先选择商品创建订单。');
    return;
  }

  const largestPhoto = msg.photo[msg.photo.length - 1];
  const tempDir = path.join(UPLOADS_DIR, 'telegram-temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const downloadedPath = await bot.downloadFile(largestPhoto.file_id, tempDir);
  const ext = path.extname(downloadedPath) || '.jpg';
  const filename = `${createId('payment')}${ext}`;
  const finalPath = path.join(UPLOADS_DIR, filename);
  fs.renameSync(downloadedPath, finalPath);

  order.paymentImageUrl = `/uploads/${filename}`;
  order.status = '待发货';
  order.updatedAt = new Date().toISOString();
  writeStore(store);

  bot.sendMessage(msg.chat.id, `付款截图已收到，订单 ${order.id} 已进入待发货。`);
}

function createLockFile() {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (oldPid) {
      try {
        process.kill(oldPid, 0);
        console.error(`检测到本项目可能已经启动过，旧进程 PID：${oldPid}。请先关闭旧终端。`);
        process.exit(1);
      } catch (error) {
        fs.unlinkSync(LOCK_FILE);
      }
    } else {
      fs.unlinkSync(LOCK_FILE);
    }
  }

  const fd = fs.openSync(LOCK_FILE, 'wx');
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
}

const server = http.createServer(handleWeb);
server.listen(PORT, () => {
  console.log(`后台管理系统已启动：http://localhost:${PORT}/admin`);
  startBot();
});
