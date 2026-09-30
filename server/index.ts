import { readConfig } from './config.js';
import { createApp } from './app.js';

const config = readConfig();
const { app, store } = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`${config.siteName} listening at ${config.publicUrl}`);
  if (!config.passwordHash) console.log('Owner administration is disabled. Configure ADMIN_PASSWORD_HASH to enable it.');
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
