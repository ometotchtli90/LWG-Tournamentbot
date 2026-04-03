'use strict';
module.exports = {
  apps: [{
    name:        'lwg-tournament-bot',
    script:      'src/server.js',
    cwd:         __dirname,
    interpreter: 'node',
    env: {
      PORT:     4321,
      HEADLESS: 'true',
      DISPLAY:  '',        // no display needed on headless Linux
    },
    watch:         false,
    max_restarts:  10,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:  'logs/error.log',
    out_file:    'logs/out.log',
  }],
};
