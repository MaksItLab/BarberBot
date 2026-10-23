const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Edge by default, as on the owner's Windows machine. PLAYWRIGHT_CHANNEL= (empty) uses Playwright's own Chromium, as in CI.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';
exports.launch = () => chromium.launch({headless: true, ...(channel ? {channel} : {})});
