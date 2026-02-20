/**
 * PM2 конфиг для UC Магазин
 * Запуск: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: 'ucmagaz-server',
      cwd: './server',
      script: 'npx',
      args: 'ts-node --esm server.ts',
      interpreter: 'none',
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
