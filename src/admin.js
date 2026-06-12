const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  PUBLIC_DIR,
  SESSION_SECRET,
  UPLOADS_DIR,
} = require('./config');
const { readSettings, readStore, writeSettings, writeStore } = require('./storage');
const {
  createId,
  getUploadedFilePath,
  jsonResponse,
  nowIso,
  parseBody,
  saveImageFromDataUrl,
  textResponse,
} = require('./utils');

const sessions = new Map();

function safeEqual(a, b) {
  if (Buffer.byteLength(a) !== Buffer.byteLength(b)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function makeSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function signSession(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

function buildSessionCookie(token) {
  return `admin_session=${token}.${signSession(token)}; HttpOnly; Path=/; SameSite=Lax`;
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const parts = cookie.split(';').map((item) => item.trim());
  const matched = parts.find((item) => item.startsWith(`${name}=`));
  return matched ? decodeURIComponent(matched.slice(name.length + 1)) : '';
}

function isAuthed(req) {
  const cookie = getCookie(req, 'admin_session');
  const [token, signature] = cookie.split('.');
  if (!token || !signature || signSession(token) !== signature) {
    return false;
  }

  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }

  session.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  return true;
}

function serveFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    textResponse(res, 404, 'Not Found');
    return;
  }

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return map[ext] || 'application/octet-stream';
}

function toActive(input, oldProduct = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'active')) {
    return input.active === true || input.active === 'true' || input.active === 1 || input.active === '1';
  }
  if (Object.prototype.hasOwnProperty.call(input, 'status')) {
    return input.status !== '下架';
  }
  if (Object.prototype.hasOwnProperty.call(oldProduct, 'active')) {
    return oldProduct.active === true || oldProduct.active === 'true' || oldProduct.active === 1 || oldProduct.active === '1';
  }
  return oldProduct.status !== '下架';
}

function normalizeProduct(input, oldProduct = {}) {
  const uploadedImage = input.imageData && input.imageData.startsWith('data:')
    ? saveImageFromDataUrl(input.imageData)
    : input.image && input.image.startsWith('data:')
      ? saveImageFromDataUrl(input.image)
      : '';
  const image = uploadedImage || input.imageUrl || input.image || oldProduct.imageUrl || oldProduct.image || '';
  const active = toActive(input, oldProduct);

  return {
    ...oldProduct,
    id: oldProduct.id || input.id || createId('product'),
    name: String(input.name ?? oldProduct.name ?? '').trim(),
    price: Number(input.price ?? oldProduct.price ?? 0),
    stock: Number(input.stock ?? oldProduct.stock ?? 0),
    active,
    status: active ? '上架' : '下架',
    description: String(input.description ?? oldProduct.description ?? ''),
    image,
    imageUrl: image,
    createdAt: oldProduct.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeOrder(order) {
  return {
    ...order,
    telegramId: order.telegramId || order.userId || '',
    userId: order.userId || order.telegramId || '',
    status: order.status || '待付款',
    paymentImageUrl: order.paymentImageUrl || order.paymentScreenshot || '',
    paymentScreenshot: order.paymentScreenshot || order.paymentImageUrl || '',
    stockDeducted: Boolean(order.stockDeducted),
  };
}

function normalizeUser(user) {
  return {
    ...user,
    id: user.id || user.telegramId,
    telegramId: user.telegramId || user.id,
    purchases: user.purchases || user.purchaseHistory || [],
    purchaseHistory: user.purchaseHistory || user.purchases || [],
  };
}

function normalizeBroadcast(item) {
  return {
    ...item,
    image: item.image || item.imageUrl || '',
    imageUrl: item.imageUrl || item.image || '',
    success: item.success ?? item.successCount ?? 0,
    failed: item.failed ?? item.failCount ?? 0,
    successCount: item.successCount ?? item.success ?? 0,
    failCount: item.failCount ?? item.failed ?? 0,
  };
}

function deductStockIfNeeded(store, order) {
  if (order.status !== '已完成' || order.stockDeducted) {
    return;
  }

  const product = store.products.find((item) => item.id === order.productId);
  if (product) {
    product.stock = Math.max(0, Number(product.stock || 0) - 1);
    order.stockDeducted = true;
  }
}

async function handleApi(req, res, pathname, getBot) {
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const usernameOk = safeEqual(String(body.username || ''), ADMIN_USERNAME);
    const passwordOk = safeEqual(String(body.password || ''), ADMIN_PASSWORD);

    if (!usernameOk || !passwordOk) {
      jsonResponse(res, 401, { message: '账号或密码错误' });
      return;
    }

    const token = makeSessionToken();
    sessions.set(token, { expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildSessionCookie(token),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookie = getCookie(req, 'admin_session');
    const [token] = cookie.split('.');
    sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!isAuthed(req)) {
    jsonResponse(res, 401, { message: '请先登录后台' });
    return;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    jsonResponse(res, 200, { username: ADMIN_USERNAME });
    return;
  }

  if (pathname === '/api/dashboard' && req.method === 'GET') {
    const store = readStore();
    const products = store.products.map((item) => normalizeProduct(item, item));
    jsonResponse(res, 200, {
      productCount: products.length,
      activeProductCount: products.filter((item) => item.active).length,
      orderCount: store.orders.length,
      userCount: store.users.length,
      pendingShipCount: store.orders.filter((order) => order.status === '待发货').length,
    });
    return;
  }

  if (pathname === '/api/products' && req.method === 'GET') {
    jsonResponse(res, 200, readStore().products.map((item) => normalizeProduct(item, item)));
    return;
  }

  if (pathname === '/api/products' && req.method === 'POST') {
    const body = await parseBody(req);
    const store = readStore();
    const product = normalizeProduct(body);
    store.products.unshift(product);
    writeStore(store);
    jsonResponse(res, 201, product);
    return;
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch && req.method === 'PUT') {
    const body = await parseBody(req);
    const store = readStore();
    const index = store.products.findIndex((item) => item.id === productMatch[1]);
    if (index === -1) {
      jsonResponse(res, 404, { message: '商品不存在' });
      return;
    }
    store.products[index] = normalizeProduct(body, store.products[index]);
    writeStore(store);
    jsonResponse(res, 200, store.products[index]);
    return;
  }

  if (productMatch && req.method === 'DELETE') {
    const store = readStore();
    store.products = store.products.filter((item) => item.id !== productMatch[1]);
    writeStore(store);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/orders' && req.method === 'GET') {
    jsonResponse(res, 200, readStore().orders.map(normalizeOrder));
    return;
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && req.method === 'PUT') {
    const body = await parseBody(req);
    const store = readStore();
    const order = store.orders.find((item) => item.id === orderMatch[1]);
    if (!order) {
      jsonResponse(res, 404, { message: '订单不存在' });
      return;
    }
    order.status = body.status || order.status;
    order.note = body.note || order.note || '';
    order.updatedAt = nowIso();
    deductStockIfNeeded(store, order);
    writeStore(store);
    jsonResponse(res, 200, normalizeOrder(order));
    return;
  }

  if (pathname === '/api/users' && req.method === 'GET') {
    jsonResponse(res, 200, readStore().users.map(normalizeUser));
    return;
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PUT') {
    const body = await parseBody(req);
    const store = readStore();
    const user = store.users.find((item) => String(item.id || item.telegramId) === userMatch[1]);
    if (!user) {
      jsonResponse(res, 404, { message: '用户不存在' });
      return;
    }
    user.banned = Boolean(body.banned);
    writeStore(store);
    jsonResponse(res, 200, normalizeUser(user));
    return;
  }

  const userMessageMatch = pathname.match(/^\/api\/users\/([^/]+)\/message$/);
  if (userMessageMatch && req.method === 'POST') {
    const body = await parseBody(req);
    const bot = getBot();
    if (!bot) {
      jsonResponse(res, 500, { message: '机器人未启动' });
      return;
    }
    await bot.sendMessage(userMessageMatch[1], String(body.text || body.message || ''));
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/broadcasts' && req.method === 'GET') {
    jsonResponse(res, 200, readStore().broadcasts.map(normalizeBroadcast));
    return;
  }

  if (pathname === '/api/broadcasts' && req.method === 'POST') {
    const body = await parseBody(req);
    const store = readStore();
    const bot = getBot();
    if (!bot) {
      jsonResponse(res, 500, { message: '机器人未启动' });
      return;
    }

    const image = body.imageData && body.imageData.startsWith('data:')
      ? saveImageFromDataUrl(body.imageData)
      : body.image && body.image.startsWith('data:')
        ? saveImageFromDataUrl(body.image)
        : '';
    const text = String(body.text || '').trim();
    let success = 0;
    let failed = 0;

    for (const user of store.users.map(normalizeUser).filter((item) => !item.banned)) {
      try {
        if (image) {
          await bot.sendPhoto(user.telegramId, getUploadedFilePath(image), { caption: text });
        } else {
          await bot.sendMessage(user.telegramId, text);
        }
        success += 1;
      } catch (error) {
        failed += 1;
      }
    }

    const broadcast = normalizeBroadcast({
      id: createId('broadcast'),
      text,
      image,
      success,
      failed,
      createdAt: nowIso(),
    });
    store.broadcasts.unshift(broadcast);
    writeStore(store);
    jsonResponse(res, 201, broadcast);
    return;
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    jsonResponse(res, 200, readSettings(readStore().settings));
    return;
  }

  if (pathname === '/api/settings' && req.method === 'PUT') {
    const body = await parseBody(req);
    const store = readStore();
    const current = readSettings(store.settings);
    const nextSettings = {
      ...current,
      storeName: String(body.storeName || current.storeName || '盒天下'),
      usdtAddress: String(body.usdtAddress || ''),
      supportText: String(body.supportText || ''),
      supportTelegram: String(body.supportTelegram || ''),
      usdtQr: body.usdtQrData && body.usdtQrData.startsWith('data:')
        ? saveImageFromDataUrl(body.usdtQrData)
        : body.usdtQr && body.usdtQr.startsWith('data:')
          ? saveImageFromDataUrl(body.usdtQr)
          : current.usdtQr,
      wechatQr: body.wechatQrData && body.wechatQrData.startsWith('data:')
        ? saveImageFromDataUrl(body.wechatQrData)
        : body.wechatQr && body.wechatQr.startsWith('data:')
          ? saveImageFromDataUrl(body.wechatQr)
          : current.wechatQr,
    };
    writeSettings(nextSettings);
    store.settings = nextSettings;
    writeStore(store);
    console.log(
      `系统设置已保存：客服说明="${nextSettings.supportText}"，客服链接="${nextSettings.supportTelegram}"`
    );
    jsonResponse(res, 200, nextSettings);
    return;
  }

  jsonResponse(res, 404, { message: '接口不存在' });
}

function handleStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/admin') {
    serveFile(res, path.join(PUBLIC_DIR, 'admin.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, path.basename(pathname));
    serveFile(res, filePath, contentTypeFor(filePath));
    return;
  }

  const filePath = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (filePath.startsWith(PUBLIC_DIR)) {
    serveFile(res, filePath, contentTypeFor(filePath));
    return;
  }

  textResponse(res, 404, 'Not Found');
}

function createRequestHandler(getBot) {
  return async (req, res) => {
    const { pathname } = url.parse(req.url);

    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, getBot);
        return;
      }
      handleStatic(req, res, pathname);
    } catch (error) {
      console.error('HTTP 请求处理失败：', error);
      jsonResponse(res, 500, { message: error.message || '服务器错误' });
    }
  };
}

module.exports = {
  createRequestHandler,
};
