const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const {
  BOT_TOKEN,
  DEFAULT_SUPPORT_TELEGRAM,
  LOCK_FILE,
  UPLOADS_DIR,
  getTelegramProxy,
  isRailwayRuntime,
} = require('./config');
const { readSettings, readStore, writeStore } = require('./storage');
const {
  createId,
  getUploadedFilePath,
  isProductActive,
  normalizeTelegramLink,
  nowIso,
} = require('./utils');

let botInstance = null;

function getBot() {
  return botInstance;
}

function shouldSkipBot() {
  if (!BOT_TOKEN || !/^\d+:[A-Za-z0-9_-]+$/.test(BOT_TOKEN)) {
    console.warn('BOT_TOKEN 未配置或格式不正确，机器人未启动。');
    return true;
  }
  return false;
}

function createLockFile() {
  if (isRailwayRuntime()) {
    return;
  }

  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`检测到机器人可能已经在运行，PID=${pid}。请先关闭另一个终端。`);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    }
  }

  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch (error) {
      // Ignore cleanup errors.
    }
  });
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

function rememberUser(from) {
  if (!from) {
    return;
  }

  const store = readStore();
  const id = String(from.id);
  let user = store.users.find((item) => String(item.id || item.telegramId) === id);
  if (!user) {
    user = {
      id,
      telegramId: id,
      username: from.username || '',
      firstName: from.first_name || '',
      lastName: from.last_name || '',
      banned: false,
      purchases: [],
      purchaseHistory: [],
      createdAt: nowIso(),
    };
    store.users.unshift(user);
  } else {
    user.id = user.id || id;
    user.telegramId = user.telegramId || id;
    user.username = from.username || user.username || '';
    user.firstName = from.first_name || user.firstName || '';
    user.lastName = from.last_name || user.lastName || '';
    user.purchases = user.purchases || user.purchaseHistory || [];
    user.purchaseHistory = user.purchaseHistory || user.purchases || [];
  }
  user.lastActiveAt = nowIso();
  writeStore(store);
}

function isBanned(chatId) {
  const user = readStore().users.map(normalizeUser).find((item) => String(item.telegramId) === String(chatId));
  return Boolean(user && user.banned);
}

function productImage(product) {
  return product.image || product.imageUrl || '';
}

function replyKeyboard() {
  return {
    keyboard: [['商品购买', '联系客服']],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function getSupportTelegram(settings) {
  return normalizeTelegramLink(settings.supportTelegram) || normalizeTelegramLink(DEFAULT_SUPPORT_TELEGRAM);
}

function mainMenuReplyMarkup(settings) {
  const buttons = [[{ text: '商品购买', callback_data: 'show_products' }]];
  const supportLink = getSupportTelegram(settings);
  if (supportLink) {
    buttons.push([{ text: '联系客服', url: supportLink }]);
  } else {
    buttons.push([{ text: '联系客服', callback_data: 'support' }]);
  }
  return { inline_keyboard: buttons };
}

function productSummaryKeyboard(products) {
  return {
    inline_keyboard: products.map((product, index) => [
      {
        text: `${index + 1}. ${product.name} - ${product.price} USDT`,
        callback_data: `detail:${product.id}`,
      },
    ]),
  };
}

function productConfirmKeyboard(productId) {
  return {
    inline_keyboard: [[{ text: '确认下单', callback_data: `confirm_buy:${productId}` }]],
  };
}

function supportText(settings) {
  return settings.supportText || '请点击下方按钮联系人工客服。';
}

function supportReplyMarkup(settings) {
  const link = getSupportTelegram(settings);
  if (!link) {
    return undefined;
  }

  return {
    inline_keyboard: [[{ text: '打开 Telegram 客服', url: link }]],
  };
}

function productDetailText(product) {
  return [
    `商品：${product.name}`,
    `价格：${product.price} USDT`,
    `库存：${product.stock}`,
    '',
    '商品介绍：',
    product.description || '暂无介绍',
  ].join('\n');
}

async function sendStartMenu(chatId) {
  const settings = readSettings(readStore().settings);
  await botInstance.sendMessage(chatId, '欢迎使用盒天下！请选择功能：', {
    reply_markup: replyKeyboard(),
  });
  await botInstance.sendMessage(chatId, '也可以点击下方按钮操作：', {
    reply_markup: mainMenuReplyMarkup(settings),
  });
}

async function sendSupport(chatId) {
  const settings = readSettings(readStore().settings);
  console.log(`联系客服请求：客服说明="${settings.supportText || ''}"，客服链接="${getSupportTelegram(settings)}"`);
  await botInstance.sendMessage(chatId, supportText(settings), {
    reply_markup: supportReplyMarkup(settings),
  });
}

async function sendProductSummary(chatId) {
  const store = readStore();
  const products = store.products.filter(isProductActive);
  console.log(`商品列表请求：总商品 ${store.products.length} 个，上架 ${products.length} 个，展示 ${products.length} 个。`);

  if (!products.length) {
    await botInstance.sendMessage(chatId, '暂无可购买商品，请稍后再试。');
    return;
  }

  await botInstance.sendMessage(chatId, '请选择商品：', {
    reply_markup: productSummaryKeyboard(products),
  });
}

async function sendProductDetail(chatId, productId) {
  const product = readStore().products.find((item) => item.id === productId);
  if (!isProductActive(product)) {
    await botInstance.sendMessage(chatId, '该商品当前不可购买。');
    return;
  }

  const text = productDetailText(product);
  const imagePath = getUploadedFilePath(productImage(product));
  if (imagePath && fs.existsSync(imagePath)) {
    await botInstance.sendPhoto(chatId, imagePath, {
      caption: text,
      reply_markup: productConfirmKeyboard(product.id),
    });
    return;
  }

  await botInstance.sendMessage(chatId, text, {
    reply_markup: productConfirmKeyboard(product.id),
  });
}

async function sendPaymentQr(chatId, imageUrl, caption) {
  const filePath = getUploadedFilePath(imageUrl);
  if (!filePath || !fs.existsSync(filePath)) {
    await botInstance.sendMessage(chatId, `${caption}未配置，请联系客服。`);
    return;
  }

  await botInstance.sendPhoto(chatId, filePath, { caption });
}

async function confirmOrder(chatId, from, productId) {
  const store = readStore();
  const product = store.products.find((item) => item.id === productId);
  if (!isProductActive(product)) {
    await botInstance.sendMessage(chatId, '该商品当前不可购买。');
    return;
  }

  const userId = String(from.id);
  const order = {
    id: createId('order'),
    userId,
    telegramId: userId,
    username: from.username || '',
    productId: product.id,
    productName: product.name,
    price: product.price,
    status: '待付款',
    paymentScreenshot: '',
    paymentImageUrl: '',
    stockDeducted: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  store.orders.unshift(order);
  let user = store.users.find((item) => String(item.id || item.telegramId) === userId);
  if (!user) {
    user = {
      id: userId,
      telegramId: userId,
      username: from.username || '',
      firstName: from.first_name || '',
      lastName: from.last_name || '',
      banned: false,
      purchases: [],
      purchaseHistory: [],
      createdAt: nowIso(),
    };
    store.users.unshift(user);
  }
  user.purchases = user.purchases || user.purchaseHistory || [];
  user.purchaseHistory = user.purchaseHistory || user.purchases || [];
  user.purchases.unshift(order.id);
  user.purchaseHistory.unshift(order.id);
  user.lastActiveAt = nowIso();
  writeStore(store);

  const settings = readSettings(store.settings);
  console.log(`确认下单收款设置：usdtQr="${settings.usdtQr}"，wechatQr="${settings.wechatQr}"`);

  await botInstance.sendMessage(chatId, [
    `订单已创建：${order.id}`,
    `商品：${product.name}`,
    `价格：${product.price} USDT`,
    '付款后请把付款截图发给客服',
  ].join('\n'));

  if (settings.usdtQr) {
    await sendPaymentQr(chatId, settings.usdtQr, 'USDT 收款码');
  }
  if (settings.wechatQr) {
    await sendPaymentQr(chatId, settings.wechatQr, '微信收款码');
  }
  if (!settings.usdtQr && !settings.wechatQr) {
    await botInstance.sendMessage(chatId, '后台暂未配置收款码，请联系客服。');
  }
}

async function savePaymentScreenshot(msg) {
  const chatId = String(msg.chat.id);
  const photos = msg.photo || [];
  const photo = photos[photos.length - 1];
  if (!photo) {
    return;
  }

  const store = readStore();
  const order = store.orders.find((item) => {
    const orderUserId = String(item.userId || item.telegramId || '');
    return orderUserId === chatId && item.status === '待付款';
  });
  if (!order) {
    await botInstance.sendMessage(chatId, '已收到图片，但没有找到待付款订单。');
    return;
  }

  const file = await botInstance.getFile(photo.file_id);
  const ext = path.extname(file.file_path || '') || '.jpg';
  const filename = `${Date.now()}_${photo.file_unique_id || photo.file_id}${ext}`;
  const targetPath = path.join(UPLOADS_DIR, filename);
  const downloadedPath = await botInstance.downloadFile(photo.file_id, UPLOADS_DIR);

  if (downloadedPath && fs.existsSync(downloadedPath)) {
    fs.renameSync(downloadedPath, targetPath);
  }

  order.paymentScreenshot = `/uploads/${path.basename(targetPath)}`;
  order.paymentImageUrl = order.paymentScreenshot;
  order.status = '待发货';
  order.updatedAt = nowIso();
  writeStore(store);
  await botInstance.sendMessage(chatId, '付款截图已收到，订单已进入待发货。');
}

function registerHandlers() {
  botInstance.onText(/\/start/, async (msg) => {
    rememberUser(msg.from);
    if (isBanned(msg.chat.id)) {
      await botInstance.sendMessage(msg.chat.id, '你的账号暂时无法使用。');
      return;
    }
    await sendStartMenu(msg.chat.id);
  });

  botInstance.on('message', async (msg) => {
    try {
      rememberUser(msg.from);
      if (isBanned(msg.chat.id)) {
        return;
      }

      if (msg.text && msg.text.startsWith('/start')) {
        return;
      }

      if (msg.photo) {
        await savePaymentScreenshot(msg);
        return;
      }

      const text = String(msg.text || '').trim();
      if (text === '商品购买' || text === '购买商品') {
        await sendProductSummary(msg.chat.id);
        return;
      }

      if (text === '联系客服') {
        await sendSupport(msg.chat.id);
      }
    } catch (error) {
      console.error('Telegram 消息处理失败：', error);
    }
  });

  botInstance.on('callback_query', async (query) => {
    const chatId = query.message && query.message.chat.id;
    if (!chatId) {
      return;
    }

    try {
      rememberUser(query.from);
      await botInstance.answerCallbackQuery(query.id);

      if (isBanned(chatId)) {
        return;
      }

      const data = query.data || '';
      if (data === 'show_products') {
        await sendProductSummary(chatId);
      } else if (data === 'support') {
        await sendSupport(chatId);
      } else if (data.startsWith('detail:')) {
        await sendProductDetail(chatId, data.slice('detail:'.length));
      } else if (data.startsWith('confirm_buy:') || data.startsWith('buy:')) {
        const productId = data.startsWith('confirm_buy:')
          ? data.slice('confirm_buy:'.length)
          : data.slice('buy:'.length);
        await confirmOrder(chatId, query.from, productId);
      }
    } catch (error) {
      console.error('Telegram 回调处理失败：', error);
    }
  });
}

function startBot() {
  if (botInstance || shouldSkipBot()) {
    return botInstance;
  }

  createLockFile();

  const proxy = getTelegramProxy();
  const options = { polling: true };
  if (proxy) {
    options.request = { proxy };
  }

  botInstance = new TelegramBot(BOT_TOKEN, options);
  registerHandlers();

  botInstance.on('polling_error', (error) => {
    console.error(`Telegram 轮询错误：${error.message || error}`);
  });

  console.log('盒天下 Telegram机器人已启动。');
  return botInstance;
}

module.exports = {
  getBot,
  startBot,
};
