const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHOP_UI_URL;
const token = process.env.SHOP_E2E_TOKEN;
if (!base || !token) throw new Error('Run scripts/test-e2e.ps1. A random test-only token and local database are required.');
function initData(id) {
  const user = JSON.stringify({ id, first_name: 'Local test' });
  const date = String(Math.floor(Date.now() / 1000));
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(`auth_date=${date}\nuser=${user}`).digest('hex');
  return new URLSearchParams({ auth_date: date, user, hash }).toString();
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://telegram.org/**', route => route.fulfill({ contentType: 'application/javascript',
      body: `window.Telegram={WebApp:{initData:${JSON.stringify(initData(9000000001))},ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};` }));
    if (process.env.SHOP_E2E_PHASE === 'create') {
      await page.goto(`${base}/admin`);
      await page.getByLabel('Название', { exact: true }).fill('Lumière (демо)');
      await page.getByLabel('Описание бренда').fill('Демонстрационный бренд для локальной проверки магазина.');
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByRole('button', { name: 'Изменить Lumière (демо)', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Типы косметики', exact: true }).click();
      await page.getByLabel('Название', { exact: true }).fill('Уход за лицом');
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByRole('button', { name: 'Изменить Уход за лицом', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Товары', exact: true }).click();
      await page.getByRole('button', { name: 'Добавить товар', exact: true }).click();
      await page.getByLabel('Название товара', { exact: true }).fill('Увлажняющий крем (демо)');
      await page.getByLabel('Описание товара', { exact: true }).fill('Демонстрационный товар. Выберите объём, чтобы увидеть точную цену.\nТекст и цены используются только для проверки приложения.');
      await page.getByLabel('Объём варианта 1', { exact: true }).fill('50 мл');
      await page.getByLabel('Цена варианта 1', { exact: true }).fill('990,50');
      await page.getByRole('button', { name: 'Добавить вариант', exact: true }).click();
      await page.getByLabel('Объём варианта 2', { exact: true }).fill('100 мл');
      await page.getByLabel('Цена варианта 2', { exact: true }).fill('1590');
      await page.getByLabel('Показывать товар в каталоге', { exact: true }).check();
      await page.getByRole('button', { name: 'Сохранить товар', exact: true }).click();
      await page.getByText('Товар сохранён.', { exact: true }).waitFor();
    }
    // A separate unauthenticated browser context exercises the customer path.
    const customer = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const shop = await customer.newPage();
    shop.on('pageerror', error => errors.push(error.message));
    await shop.route('https://telegram.org/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await shop.goto(base);
    await shop.getByRole('heading', { name: 'Увлажняющий крем (демо)', exact: true }).waitFor();
    assert.match(await shop.locator('.product-price').innerText(), /от 990,50/);
    assert.equal(await shop.getByRole('button', { name: 'Управление магазином' }).count(), 0);
    await shop.getByLabel('Бренд', { exact: true }).selectOption({ label: 'Lumière (демо)' });
    await shop.getByLabel('Тип косметики', { exact: true }).selectOption({ label: 'Уход за лицом' });
    await shop.getByRole('heading', { name: 'Увлажняющий крем (демо)', exact: true }).click();
    await shop.getByRole('heading', { name: 'О товаре', exact: true }).waitFor();
    assert.match(await shop.locator('.detail-price').innerText(), /990,50/);
    await shop.getByRole('radio', { name: '100 мл' }).check();
    assert.match((await shop.locator('.detail-price').innerText()).replace(/\s/g, ''), /1590,00/);
    await shop.screenshot({ path: `artifacts/e2e/${process.env.SHOP_E2E_RUN}/product.png`, fullPage: true });
    await shop.getByRole('button', { name: 'В каталог' }).click();
    await shop.getByRole('heading', { name: 'Каталог', exact: true }).waitFor();
    assert.match(shop.url(), /brandId=\d+&typeId=\d+/);
    assert.equal(await shop.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await shop.screenshot({ path: `artifacts/e2e/${process.env.SHOP_E2E_RUN}/catalog.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await customer.close();
    console.log(`PASS: real frontend/API/PostgreSQL customer path (${process.env.SHOP_E2E_PHASE}).`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
