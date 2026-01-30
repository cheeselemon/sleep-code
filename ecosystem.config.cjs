module.exports = {
  apps: [
    {
      name: 'sleep-slack',
      script: 'npm',
      args: 'run slack',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'sleep-discord',
      script: 'npm',
      args: 'run discord',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'sleep-telegram',
      script: 'npm',
      args: 'run telegram',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
