module.exports = {
  apps: [{
    name: 'qwenwork2api',
    script: 'server.mjs',
    cwd: __dirname,
    node_args: '--enable-source-maps',
    env: {
      PORT: '4021',
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      // 伪装用的客户端版本；官方客户端升级后按 resources/package.json 同步
      QWENWORK_CLIENT_VERSION: '2.1.0',
      QWENWORK_RELEASE_VERSION: '2.1.0-26111315',
      REFRESH_MS: '600000'
    },
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    time: true
  }]
}
