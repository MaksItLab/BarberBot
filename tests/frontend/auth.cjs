const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://telegram.org/**', route => route.fulfill({ contentType: 'application/javascript',
      body: 'window.Telegram={WebApp:{initData:"test-init-data",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};' }));
    await page.route('**/api/catalog/**', route => route.fulfill({ json: route.request().url().includes('/products')
      ? { items: [], page: 1, pageSize: 20, hasMore: false } : [] }));
    let role = 'Admin', status = 200, calls = 0;
    await page.route('**/api/auth/telegram', route => {
      calls++;
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().headers().authorization, 'tma test-init-data');
      return route.fulfill({ status, json: { telegramId: '9000000001', role } });
    });
    const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
    await page.goto(base);
    await page.getByText('Администратор', { exact: true }).waitFor();
    role = 'Customer';
    await page.reload();
    await page.getByRole('heading', { name: 'Каталог скоро появится' }).waitFor();
    assert.equal(await page.getByText('Администратор', { exact: true }).count(), 0);
    status = 401;
    await page.reload();
    await page.getByText('Для управления магазином откройте приложение заново из Telegram.').waitFor();
    await page.getByRole('heading', { name: 'Каталог скоро появится' }).waitFor();
    status = 503;
    await page.reload();
    await page.getByRole('button', { name: 'Повторить вход' }).waitFor();
    status = 200;
    await page.getByRole('button', { name: 'Повторить вход' }).click();
    await page.waitForFunction(() => !document.querySelector('.auth-notice'));
    assert.ok(calls >= 5);
    assert.deepEqual(errors, []);
    console.log('PASS: initData header, server role, expired login, public catalog, login retry.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
