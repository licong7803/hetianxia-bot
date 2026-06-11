const TelegramBot = require('node-telegram-bot-api');

// 把这里改成你的 Bot Token
const token = '8981659223:AAHrD6czrOuh0hCl4DgGEcJqwE7BVSOQVf8';

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {

    bot.sendMessage(
        msg.chat.id,
        '欢迎使用盒天下！',
        {
            reply_markup: {
                keyboard: [
                    ['🛒 商品购买'],
                    ['💰 今日价格'],
                    ['📞 联系客服']
                ],
                resize_keyboard: true
            }
        }
    );
});

console.log('盒天下机器人已启动');