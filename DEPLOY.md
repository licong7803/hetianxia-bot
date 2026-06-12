# 盒天下机器人公网部署说明

## 推荐方案

新手建议先用海外服务器或 Render 这类平台部署。不要部署在无法直接访问 Telegram 的网络里，否则还会遇到本地一样的 Telegram 连接问题。

## 需要配置的环境变量

```env
BOT_TOKEN=你的 Telegram Bot Token
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的后台登录密码
SESSION_SECRET=一串很长的随机字符
PORT=3000
DATA_DIR=服务器上的持久化数据目录
UPLOADS_DIR=服务器上的持久化图片目录
TELEGRAM_PROXY=
```

如果服务器在海外，通常不需要 `TELEGRAM_PROXY`。

## 启动命令

```powershell
npm.cmd start
```

Linux 服务器上使用：

```bash
npm start
```

## 注意事项

- `.env` 不要上传到 GitHub。
- `data/store.json` 是商品、订单、用户数据。
- `uploads/` 是后台上传的图片和付款截图。
- 服务器必须 24 小时运行，后台网页和 Telegram 机器人才能一直可用。
- 生产环境一定要修改 `ADMIN_PASSWORD` 和 `SESSION_SECRET`。
