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

// Global rate limiting - use config values
let currentDelay = config.timing.initialConnectionDelay;
let lastConnectionTime = 0;
let rateLimitDetected = false;
const MAX_DELAY = config.timing.maxConnectionDelay;
let chatDisabled = config.behavior.assumeChatDisabled;

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

// Rate-limited bot creation - waits for appropriate delay before creating a bot
async function createBotWithRateLimit(index) {
  // Calculate time since last connection
  const now = Date.now();
  const timeSinceLastConnection = now - lastConnectionTime;
  
  // If we need to wait more, do so
  if (timeSinceLastConnection < currentDelay) {
    const waitTime = currentDelay - timeSinceLastConnection;
    log('SYSTEM', `Rate limiting: waiting ${Math.round(waitTime/1000)}s before next connection`, 'warning');
    await delay(waitTime);
  }
  
  // Update last connection time and create bot
  lastConnectionTime = Date.now();
  return createBot(index);
}

// Creates and manages a bot
async function createBot(index) {
  const username = `${config.bots.prefix}${index}`;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = config.bots.maxReconnectAttempts;
  let reconnectDelay = config.timing.reconnectBaseDelay;
  let loginRetries = 0;
  const maxLoginRetries = config.bots.maxLoginRetries;
  
  async function connect() {
    try {
      // Remove old bot if exists
      if (activeBots.has(username)) {
        const oldBot = activeBots.get(username);
        try {
          if (oldBot && oldBot.end) oldBot.end();
        } catch (e) {
          // Ignore errors while ending bot
        }
        activeBots.delete(username);
      }
      
      // Create new bot with proper error handling
      log(username, `Connecting to ${config.server.host}:${config.server.port}`, 'info');
      
      const bot = mineflayer.createBot({
        host: config.server.host,
        port: config.server.port,
        username,
        version: config.server.version,
        keepAlive: true,
        checkTimeoutInterval: 60000,
        viewDistance: config.behavior.viewDistance,
        connectTimeout: 60000,
        respawn: config.behavior.respawnEnabled,
        skipValidation: true,
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
    // Set up error handlers first
    bot.on('error', (err) => {
      log(username, `Error: ${err.message}`, 'error');
      
      // Specifically handle ECONNRESET by marking as rate limited
      if (err.code === 'ECONNRESET') {
        rateLimitDetected = true;
        // Increase global delay when we see connection resets
        currentDelay = Math.min(currentDelay * 1.5, MAX_DELAY);
        log('SYSTEM', `ECONNRESET detected, increasing global delay to ${Math.round(currentDelay/1000)}s`, 'warning');
      }
    });
    
    // Spawn handler
    bot.once('spawn', async () => {
      log(username, 'Spawned', 'success');
      
      try {
        // Wait a bit before trying to authenticate
        await delay(2000 + Math.random() * 1000);
        
        // Handle authentication
        if (!credentials[username]) {
          await performRegistration(bot, username);
        } else {
          await performLogin(bot, username);
        }
        
        // Start bot activities after successful spawn
        startBotActivities(bot, username);
        
        // Reset reconnection attempts on successful spawn
        reconnectAttempts = 0;
        reconnectDelay = config.timing.reconnectBaseDelay;
        loginRetries = 0;
      } catch (error) {
        log(username, `Error during spawn: ${error.message}`, 'error');
      }
    });
    
    // Message handler for login detection and chat disabled detection
    bot.on('message', (message) => {
      const msg = message.toString().toLowerCase();
      
      // Log all messages
      log(username, `Chat: ${message.toString()}`, 'info');
      
      // Check for chat disabled message
      if (msg.includes("chat is disabled")) {
        chatDisabled = true;
        log(username, 'Chat is disabled on this server', 'warning');
      }
      
      // Check for rate limiting messages
      if (msg.includes("logging in too fast") || msg.includes("try again later")) {
        rateLimitDetected = true;
        // Increase global delay when rate limited
        currentDelay = Math.min(currentDelay * 2, MAX_DELAY);
        log('SYSTEM', `Rate limit detected, increasing global delay to ${Math.round(currentDelay/1000)}s`, 'warning');
      }
      
      // Handle login success/failure messages
      if (msg.includes('success') && msg.includes('log')) {
        log(username, 'Login successful', 'success');
        loginRetries = 0;
      } else if ((msg.includes('wrong password') || msg.includes('failed')) && msg.includes('log')) {
        log(username, 'Login failed', 'error');
        loginRetries++;
        
        // Try to login again after delay if we haven't exceeded retry limit
        if (loginRetries < maxLoginRetries) {
          setTimeout(() => {
            if (bot.entity) {
              bot.chat(`/login ${credentials[username]}`);
              log(username, `Retrying login... (${loginRetries + 1}/${maxLoginRetries})`, 'warning');
            }
          }, 5000);
        } else {
          log(username, `Max login retries (${maxLoginRetries}) reached`, 'error');
        }
      }
    });
    
    // Registration handler
    async function performRegistration(bot, username) {
      log(username, 'Attempting registration', 'info');
      bot.chat(`/register ${config.bots.password} ${config.bots.password}`);
      credentials[username] = config.bots.password;
      
      try {
        fs.writeJsonSync(credPath, credentials, { spaces: 2 });
        log(username, 'Registered and credentials saved', 'success');
      } catch (err) {
        log(username, `Failed to save credentials: ${err.message}`, 'error');
      }
    }
    
    // Login handler with retries
    async function performLogin(bot, username) {
      log(username, 'Attempting login', 'info');
      bot.chat(`/login ${credentials[username]}`);
    }
    
    // Disconnection handler
    bot.on('end', async () => {
      log(username, 'Disconnected', 'warning');
      activeBots.delete(username);
      
      // If we're rate limited, add extra delay
      if (rateLimitDetected) {
        const extraDelay = Math.random() * 30000 + 30000; // 30-60s additional delay
        log(username, `Rate limit detected, adding ${Math.round(extraDelay/1000)}s extra delay`, 'warning');
        await delay(extraDelay);
        rateLimitDetected = false;
      }
      
      // Attempt to reconnect with exponential backoff
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        // Add jitter to the reconnect delay to prevent all bots reconnecting at once
        const jitter = Math.random() * 10000 - 5000; // ±5s jitter
        const actualDelay = reconnectDelay + jitter;
        
        log(username, `Reconnecting in ${Math.round(actualDelay/1000)}s (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`, 'warning');
        
        setTimeout(async () => {
          // Use rate-limited connect to prevent server overload
          await createBotWithRateLimit(index);
          // Increase delay for next attempt with a slower growth rate
          reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
        }, actualDelay);
      } else {
        log(username, 'Max reconnection attempts reached', 'error');
      }
    });
    
    // Kick handler with specific handling for rate limiting
    bot.on('kicked', (reason, loggedIn) => {
      try {
        const parsedReason = typeof reason === 'string' ? JSON.parse(reason) : reason;
        const reasonStr = typeof parsedReason === 'object' ? JSON.stringify(parsedReason) : parsedReason;
        log(username, `Kicked: ${reasonStr}`, 'error');
        
        // Check for rate limiting kick messages
        if (typeof reasonStr === 'string' && 
            (reasonStr.includes("too fast") || reasonStr.includes("try again") || 
             reasonStr.includes("rate") || reasonStr.includes("limit"))) {
          rateLimitDetected = true;
          // Double the connection delay when explicitly rate limited
          currentDelay = Math.min(currentDelay * 2, MAX_DELAY);
          log('SYSTEM', `Rate limit kick detected, doubling global delay to ${Math.round(currentDelay/1000)}s`, 'warning');
        }
        
        // Check for auth timeout
        if (typeof reasonStr === 'string' && reasonStr.includes("authorisation time")) {
          log('SYSTEM', 'Auth timeout detected, will adjust login timing', 'warning');
        }
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
    
    // Player tracking (based on config)
    if (config.logging.logPlayerMovements) {
      bot.on('playerJoined', (player) => {
        // Only log non-bot players to reduce spam
        if (!player.username.startsWith(config.bots.prefix)) {
          log(username, `Player joined: ${player.username}`, 'info');
        }
      });
      
      bot.on('playerLeft', (player) => {
        // Only log non-bot players to reduce spam
        if (!player.username.startsWith(config.bots.prefix)) {
          log(username, `Player left: ${player.username}`, 'info');
        }
      });
    }
  }
  
  // Start the bot behaviors - using config values for timings
  function startBotActivities(bot, username) {
    // More complex movements
    const moveIntervals = [];
    
    // Jump around
    moveIntervals.push(setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), config.behavior.movementDuration);
      }
    }, config.timing.jumpInterval + Math.random() * 10000));
    
    // Random movement
    moveIntervals.push(setInterval(() => {
      if (bot.entity) {
        const movements = ['forward', 'back', 'left', 'right'];
        const movement = movements[Math.floor(Math.random() * movements.length)];
        
        bot.setControlState(movement, true);
        setTimeout(() => {
          bot.setControlState(movement, false);
        }, config.behavior.movementDuration + Math.random() * 1000);
        
        // Random look
        bot.look(Math.random() * Math.PI * 2, Math.random() * Math.PI - Math.PI/2);
      }
    }, config.timing.movementInterval + Math.random() * 5000));
    
    // Chat spam only if chat is not disabled
    if (!chatDisabled) {
      moveIntervals.push(setInterval(() => {
        if (bot.entity) {
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
          const message = messages[Math.floor(Math.random() * messages.length)];
          bot.chat(message);
        }
      }, config.timing.chatInterval + Math.random() * 30000));
    }
    
    // Clean up intervals on disconnect
    bot.once('end', () => {
      moveIntervals.forEach(interval => clearInterval(interval));
    });
  }
  
  // Start the bot
  return await connect();
}

// Start system with rate limiting
(async () => {
  try {
    // Show startup message
    log('SYSTEM', `Starting bot army for ${config.server.host}:${config.server.port}`, 'system');
    log('SYSTEM', `Targeting Minecraft ${config.server.version} with ${config.bots.totalBots} bots`, 'system');
    log('SYSTEM', `Initial connection delay: ${Math.round(currentDelay/1000)}s`, 'system');
    
    // Launch bots with rate limiting
    for (let i = config.bots.startIndex; i < config.bots.startIndex + config.bots.totalBots; i++) {
      await createBotWithRateLimit(i);
      
      // Add dynamic delay based on observations
      if (rateLimitDetected) {
        log('SYSTEM', 'Rate limit detected, increasing connection delay', 'warning');
        rateLimitDetected = false;
        await delay(60000); // Wait a full minute after rate limit detection
      }
    }
    
    // Log status periodically
    setInterval(() => {
      const uptime = process.uptime();
      const minutes = Math.floor(uptime / 60);
      const seconds = Math.floor(uptime % 60);
      log('SYSTEM', `Status: ${activeBots.size}/${config.bots.totalBots} bots active, uptime: ${minutes}m ${seconds}s, current delay: ${Math.round(currentDelay/1000)}s`, 'system');
    }, config.logging.statusInterval);
  } catch (err) {
    log('SYSTEM', `CRITICAL ERROR: ${err.message}`, 'error');
    console.error(err);
  }
})();
