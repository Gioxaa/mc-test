const mineflayer = require('mineflayer');
const fs = require('fs-extra');
const config = require('./config.json');

const credPath = './bots/credentials.json';
let credentials = fs.existsSync(credPath) ? fs.readJsonSync(credPath) : {};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createBot(index) {
  const username = `${config.prefix}${index}`;
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username,
    version: config.version,
  });

  bot.once('spawn', async () => {
    console.log(`[${username}] Spawned`);

    // Jika belum ada password tersimpan, lakukan register
    if (!credentials[username]) {
      await delay(1500 + Math.random() * 1000);
      bot.chat(`/register ${config.password} ${config.password}`);
      credentials[username] = config.password;
      fs.writeJsonSync(credPath, credentials, { spaces: 2 });
      console.log(`[${username}] Registered`);
    } else {
      await delay(1000 + Math.random() * 1000);
      bot.chat(`/login ${credentials[username]}`);
      console.log(`[${username}] Logged in`);
    }

    // Aksi gila: spam chat, lompat-lompat, muter
    setInterval(() => {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
      bot.setControlState('right', true);
      setTimeout(() => bot.setControlState('right', false), 500);
      bot.chat(`Aku ${username} sedang mengacau 😈`);
    }, 8000 + Math.random() * 2000);
  });

  bot.on('end', () => {
    console.log(`[${username}] Disconnected`);
  });

  bot.on('error', (err) => {
    console.log(`[${username}] Error: ${err.message}`);
  });
}

(async () => {
  for (let i = config.startIndex; i < config.startIndex + config.totalBots; i++) {
    createBot(i);
    await delay(500 + Math.random() * 300); // Supaya gak langsung nembak semua
  }
})();
