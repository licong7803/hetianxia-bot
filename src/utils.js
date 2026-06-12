const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('./config');

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isProductActive(product) {
  if (!product || Number(product.stock || 0) <= 0) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(product, 'active')) {
    return product.active === true || product.active === 'true' || product.active === 1 || product.active === '1';
  }

  return product.status === '上架';
}

function publicUploadPath(filename) {
  return `/uploads/${filename}`;
}

function getUploadedFilePath(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    return '';
  }

  if (!imageUrl.startsWith('/uploads/')) {
    return '';
  }

  return path.join(UPLOADS_DIR, path.basename(imageUrl));
}

function saveImageFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return '';
  }

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return '';
  }

  const mimeType = match[1];
  const extMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const ext = extMap[mimeType] || 'png';
  const filename = `${Date.now()}${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return publicUploadPath(filename);
}

function normalizeTelegramLink(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const withoutProtocol = raw.replace(/^https?:\/\//i, '').replace(/^@/, '');
  const cleaned = withoutProtocol
    .replace(/^t\.me\//i, '')
    .replace(/^telegram\.me\//i, '')
    .split(/[/?#]/)[0]
    .trim();

  if (!/^[a-zA-Z0-9_]{5,32}$/.test(cleaned)) {
    return '';
  }

  return `https://t.me/${cleaned}`;
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function textResponse(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error('请求内容过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = {
  createId,
  getUploadedFilePath,
  isProductActive,
  jsonResponse,
  normalizeTelegramLink,
  nowIso,
  parseBody,
  publicUploadPath,
  saveImageFromDataUrl,
  textResponse,
};
