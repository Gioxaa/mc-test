# Minecraft Bot Army

A Node.js-based Minecraft bot army using Mineflayer.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure your settings in `config.json`:
```json
{
  "host": "your-server-ip",
  "port": 25565,
  "version": "1.8.9",
  "prefix": "Bot_",
  "password": "your-password",
  "startIndex": 1,
  "totalBots": 10
}
```

3. Run the bot:
```bash
node index.js
```

## Features

- Multiple bot connections
- Automatic registration and login
- Random bot movements and chat messages
- Credential management

## Requirements

- Node.js
- Minecraft server with authentication enabled 