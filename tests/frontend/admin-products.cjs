const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://telegram.org/**', route => route.fulfill({ contentType: 'application/javascript',
      body: 'window.Telegram={WebApp:{initData:"test-init-data",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};' }));
    await page.route('**/api/auth/telegram', route => route.fulfill({ json: { telegramId: '1', role: 'Admin' } }));
    let product, conflict = false, version = 0;
    const keys = [];
    await page.route('**/api/catalog/**', route => {
      const url = new URL(route.request().url());
      const items = product?.isVisible ? [{ id: product.id, name: product.name, brandName: 'Бренд А', imagePath: null,
        priceRub: Math.min(...product.variants.filter(value => value.isVisible).map(value => value.priceRub)), hasPriceRange: true }] : [];
      return route.fulfill({ json: url.pathname.endsWith('/products') ? { items, page: 1, pageSize: 20, hasMore: false } : [] });
    });
    await page.route('**/api/admin/**', async route => {
      assert.equal(route.request().headers().authorization, 'tma test-init-data');
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/brands')) return route.fulfill({ json: [{ id: '1', name: 'Бренд А', description: null }] });
      if (url.pathname.endsWith('/types')) return route.fulfill({ json: [{ id: '1', name: 'Уход' }] });
      if (route.request().method() === 'GET') return route.fulfill({ json: /\/products\/\d+$/.test(url.pathname) ? product
        : { items: product ? [{ id: product.id, name: product.name, brandName: 'Бренд А', isVisible: product.isVisible }] : [], page: 1, pageSize: 20, hasMore: false } });
      const key = route.request().headers()['idempotency-key'];
      assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      keys.push(key);
      if (conflict) return route.fulfill({ status: 409, json: { title: 'Товар уже изменён другим администратором.' } });
      const input = route.request().postDataJSON();
      product = { ...input, id: '1', version: String(++version), variants: input.variants.map((value, index) => ({ ...value, id: value.id || String(index + 1) })) };
      return route.fulfill({ status: route.request().method() === 'POST' ? 201 : 200, json: product });
    });
    await page.goto(process.env.SHOP_UI_URL || 'http://127.0.0.1:5173');
    await page.getByRole('button', { name: 'Управление магазином' }).click();
    await page.getByRole('button', { name: 'Товары', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить товар', exact: true }).click();
    await page.getByLabel('Название товара', { exact: true }).fill('Новый крем');
    await page.getByLabel('Описание товара', { exact: true }).fill('Описание нового крема');
    await page.getByLabel('Объём варианта 1', { exact: true }).fill('50 мл');
    await page.getByLabel('Цена варианта 1', { exact: true }).fill('199,99');
    await page.getByRole('button', { name: 'Добавить вариант', exact: true }).click();
    await page.getByLabel('Объём варианта 2', { exact: true }).fill('100 мл');
    await page.getByLabel('Цена варианта 2', { exact: true }).fill('399.99');
    await page.getByLabel('Показывать товар в каталоге', { exact: true }).check();
    await page.getByRole('button', { name: 'Сохранить товар', exact: true }).click();
    await page.getByText('Товар сохранён.', { exact: true }).waitFor();
    assert.equal(product.variants[0].priceRub, 199.99);
    assert.equal(product.variants.length, 2);
    assert.equal(await page.getByRole('button', { name: /Убрать новый вариант/ }).count(), 0);
    await page.getByRole('button', { name: 'Закрыть форму', exact: true }).click();
    await page.getByRole('button', { name: 'Изменить Новый крем', exact: true }).click();
    await page.getByLabel('Название товара', { exact: true }).fill('Моя правка');
    conflict = true;
    await page.getByRole('button', { name: 'Сохранить товар', exact: true }).click();
    await page.getByText('Товар уже изменён другим администратором.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Название товара', { exact: true }).inputValue(), 'Моя правка');
    // A second attempt from the same form repeats the same intent; the earlier create had its own key.
    await page.getByRole('button', { name: 'Сохранить товар', exact: true }).click();
    for (let wait = 0; wait < 100 && keys.length < 3; wait++) await page.waitForTimeout(50);
    assert.equal(keys.length, 3);
    assert.equal(keys[2], keys[1]);
    assert.notEqual(keys[1], keys[0]);
    assert.equal(await page.getByLabel('Цена варианта 1', { exact: true }).inputValue(), '199.99');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'artifacts/admin-product-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'В каталог' }).click();
    await page.getByRole('heading', { name: 'Новый крем', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: product form, variants, ruble input, publish, immutable saved variants, conflict retains input, one save key per form, refreshed catalog, mobile.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
