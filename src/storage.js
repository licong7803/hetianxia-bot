const fs = require('fs');
const path = require('path');
const {
  DATA_DIR,
  UPLOADS_DIR,
  PUBLIC_DIR,
  STORE_FILE,
  SETTINGS_FILE,
} = require('./config');

const DEFAULT_SETTINGS = {
  usdtAddress: '',
  usdtQr: '',
  wechatQr: '',
  supportText: '',
  supportTelegram: '',
};

const EMPTY_STORE = {
  products: [],
  orders: [],
  users: [],
  broadcasts: [],
  settings: DEFAULT_SETTINGS,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    return clone(fallback);
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    const backupFile = `${file}.broken-${Date.now()}`;
    fs.copyFileSync(file, backupFile);
    console.error(`数据文件读取失败，已备份到 ${backupFile}`, error.message);
    return clone(fallback);
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
  };
}

function isFilled(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function chooseNewerSettings(fileSettings, fallbackSettings) {
  const fileTime = Date.parse(fileSettings.updatedAt || '') || 0;
  const fallbackTime = Date.parse(fallbackSettings.updatedAt || '') || 0;

  if (fallbackTime > fileTime) {
    return {
      ...fileSettings,
      ...fallbackSettings,
    };
  }

  const merged = {
    ...fallbackSettings,
    ...fileSettings,
  };

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!isFilled(merged[key]) && isFilled(fallbackSettings[key])) {
      merged[key] = fallbackSettings[key];
    }
  }

  return merged;
}

function readSettings(fallback = {}) {
  const fallbackSettings = normalizeSettings(fallback);
  const fileSettings = normalizeSettings(readJson(SETTINGS_FILE, fallbackSettings));
  return normalizeSettings(chooseNewerSettings(fileSettings, fallbackSettings));
}

function writeSettings(settings) {
  const normalized = normalizeSettings(settings);
  writeJson(SETTINGS_FILE, normalized);
  return normalized;
}

function normalizeStore(store = {}) {
  return {
    products: Array.isArray(store.products) ? store.products : [],
    orders: Array.isArray(store.orders) ? store.orders : [],
    users: Array.isArray(store.users) ? store.users : [],
    broadcasts: Array.isArray(store.broadcasts) ? store.broadcasts : [],
    settings: readSettings(store.settings),
  };
}

function readStore() {
  return normalizeStore(readJson(STORE_FILE, EMPTY_STORE));
}

function writeStore(store) {
  const normalized = normalizeStore(store);
  writeJson(STORE_FILE, normalized);
  return normalized;
}

function updateStore(mutator) {
  const store = readStore();
  mutator(store);
  return writeStore(store);
}

function ensureFolders() {
  ensureDir(PUBLIC_DIR);
  ensureDir(DATA_DIR);
  ensureDir(UPLOADS_DIR);

  if (!fs.existsSync(SETTINGS_FILE)) {
    const oldStore = readJson(STORE_FILE, EMPTY_STORE);
    writeSettings(oldStore.settings || DEFAULT_SETTINGS);
  }

  if (!fs.existsSync(STORE_FILE)) {
    writeStore(EMPTY_STORE);
  }

  console.log(`数据文件路径：${STORE_FILE}`);
  console.log(`系统设置路径：${SETTINGS_FILE}`);
  console.log(`上传目录路径：${UPLOADS_DIR}`);
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureFolders,
  readSettings,
  readStore,
  updateStore,
  writeSettings,
  writeStore,
};
