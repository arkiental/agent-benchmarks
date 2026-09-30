import { defineConfig } from '@playwright/test';

const port=Number(process.env.BROWSER_TEST_PORT || 8788);
export default defineConfig({
  testDir:'./tests',testMatch:'**/*.spec.ts',workers:1,fullyParallel:false,timeout:120000,
  reporter:[['list']],
  use:{ baseURL:`http://127.0.0.1:${port}`,viewport:{width:1440,height:1000},trace:'retain-on-failure',screenshot:'only-on-failure',
    launchOptions:process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{} },
  webServer:process.env.BROWSER_TEST_EXTERNAL==='1'?undefined:{command:'node .local/testbuild/tests/browser-server.js',url:`http://127.0.0.1:${port}/healthz`,reuseExistingServer:false,timeout:30000},
});
