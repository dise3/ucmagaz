const path = require('path');

/**
 * PM2 конфиг для UC Магазин
 * Запуск: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: 'ucmagaz-server',
      cwd: path.join(__dirname, 'server'),
      script: 'server.ts',
      interpreter: path.join(__dirname, 'node_modules/.bin/tsx'),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      env_file: '.env',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
