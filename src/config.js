const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const LOCK_FILE = path.join(ROOT_DIR, '.bot.lock');

function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

function isRailwayRuntime() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME);
}

function resolveDataPaths() {
  const railway = isRailwayRuntime();
  const defaultDataDir = railway ? '/data/data' : path.join(ROOT_DIR, 'data');
  const defaultUploadsDir = railway ? '/data/uploads' : path.join(ROOT_DIR, 'uploads');

  return {
    DATA_DIR: process.env.DATA_DIR || defaultDataDir,
    UPLOADS_DIR: process.env.UPLOADS_DIR || defaultUploadsDir,
  };
}

function getTelegramProxy() {
  const proxy = (process.env.TELEGRAM_PROXY || '').trim();
  if (!proxy) {
    return '';
  }

  if (!/^https?:\/\//i.test(proxy)) {
    console.warn('TELEGRAM_PROXY 格式不正确，已忽略。');
    return '';
  }

  if (isRailwayRuntime() && /127\.0\.0\.1|localhost/i.test(proxy)) {
    console.warn('Railway 上不能使用本机代理，TELEGRAM_PROXY 已忽略。');
    return '';
  }

  return proxy;
}

const { DATA_DIR, UPLOADS_DIR } = resolveDataPaths();

module.exports = {
  ROOT_DIR,
  PUBLIC_DIR,
  LOCK_FILE,
  DATA_DIR,
  UPLOADS_DIR,
  STORE_FILE: path.join(DATA_DIR, 'store.json'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  PORT: process.env.PORT || 3000,
  BOT_TOKEN: (process.env.BOT_TOKEN || '').trim(),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123456',
  SESSION_SECRET: process.env.SESSION_SECRET || 'change-this-session-secret',
  DEFAULT_SUPPORT_TELEGRAM: process.env.SUPPORT_TELEGRAM || '@hetianxia_china',
  getTelegramProxy,
  isRailwayRuntime,
};
