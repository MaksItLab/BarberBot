const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://telegram.org/**', route => route.fulfill({ contentType: 'application/javascript',
      body: 'window.Telegram={WebApp:{ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){},BackButton:{show(){window.backVisible=true},hide(){window.backVisible=false},onClick(fn){window.tgBack=fn},offClick(fn){if(window.tgBack===fn)window.tgBack=null}}}};' }));
    await page.route('**/images/missing.png', route => route.fulfill({ status: 404, body: '' }));
    let fail = false;
    const products = Array.from({ length: 25 }, (_, index) => ({ id: String(index + 1), name: `Крем ${index + 1}`,
      brandName: index % 2 ? 'Бренд Б' : 'Бренд А', imagePath: index === 0 ? '/images/missing.png' : null, priceRub: 199.99, hasPriceRange: index === 0 }));
    await page.route('**/api/catalog/**', async route => {
      const url = new URL(route.request().url());
      if (fail) return route.fulfill({ status: 503, json: {} });
      if (url.pathname.endsWith('/brands')) return route.fulfill({ json: [{ id: '1', name: 'Бренд А' }, { id: '2', name: 'Бренд Б' }] });
      if (url.pathname.endsWith('/types')) return route.fulfill({ json: [{ id: '1', name: 'Уход' }, { id: '2', name: 'Макияж' }] });
      const detailId = /\/products\/(\d+)$/.exec(url.pathname)?.[1];
      if (detailId) {
        const product = products.find(value => value.id === detailId);
        if (!product) return route.fulfill({ status: 404, json: {} });
        return route.fulfill({ json: { ...product, description: '<script>Текст описания</script>', brandDescription: 'Описание бренда', typeName: 'Уход',
          variants: [{ id: '1', volume: '50 мл', size: null, shade: null, priceRub: 199.99 },
            ...(detailId === '1' ? [{ id: '2', volume: '100 мл', size: null, shade: '02', priceRub: 399.99 }] : [])] } });
      }
      const brand = url.searchParams.get('brandId'), type = url.searchParams.get('typeId');
      const filtered = products.filter((_, index) => (!brand || brand === String(index % 2 + 1)) && (!type || type === String(index % 3 + 1)));
      const number = Number(url.searchParams.get('page') || 1), start = (number - 1) * 20;
      return route.fulfill({ json: { items: filtered.slice(start, start + 20), page: number, pageSize: 20, hasMore: filtered.length > start + 20 } });
    });
    await page.goto(base);
    await page.getByRole('heading', { name: 'Крем 1', exact: true }).waitFor();
    assert.equal(await page.locator('.product-card').count(), 20);
    assert.match(await page.locator('.product-price').first().innerText(), /^от /);
    await page.getByRole('button', { name: 'Показать ещё' }).click();
    await page.getByRole('heading', { name: 'Крем 25', exact: true }).waitFor();
    assert.equal(await page.locator('.product-card').count(), 25);
    await page.getByRole('heading', { name: 'Крем 25', exact: true }).scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => scrollY);
    await page.getByRole('heading', { name: 'Крем 25', exact: true }).click();
    await page.getByRole('heading', { name: 'О товаре', exact: true }).waitFor();
    assert.equal(await page.getByRole('radio').count(), 0);
    assert.equal(await page.evaluate(() => window.backVisible), true);
    await page.evaluate(() => window.tgBack());
    await page.getByRole('heading', { name: 'Каталог', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.backVisible), false);
    assert.equal(await page.locator('.product-card').count(), 25);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scroll) < 2);
    await page.getByLabel('Бренд', { exact: true }).selectOption('1');
    await page.waitForFunction(() => document.querySelectorAll('.product-card').length === 13);
    await page.getByLabel('Тип косметики').selectOption('1');
    await page.waitForFunction(() => document.querySelectorAll('.product-card').length === 5);
    assert.match(page.url(), /brandId=1&typeId=1/);
    await page.getByRole('heading', { name: 'Крем 1', exact: true }).click();
    await page.getByRole('heading', { name: 'О товаре', exact: true }).waitFor();
    await page.locator('.detail').getByRole('img', { name: 'Без изображения' }).waitFor();
    assert.match(await page.locator('.detail-price').innerText(), /199,99/);
    await page.getByRole('radio', { name: /100 мл/ }).check();
    assert.match(await page.locator('.detail-price').innerText(), /399,99/);
    assert.equal(await page.locator('.description script').count(), 0);
    assert.match(await page.locator('.description').first().innerText(), /<script>/);
    await page.screenshot({ path: 'artifacts/product-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'В каталог' }).click();
    await page.getByRole('heading', { name: 'Каталог', exact: true }).waitFor();
    assert.match(page.url(), /brandId=1&typeId=1/);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.product-card').length === 5);
    await page.screenshot({ path: 'artifacts/catalog-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Сбросить' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.product-card').length === 20);
    fail = true;
    await page.reload();
    await page.getByRole('heading', { name: 'Не удалось загрузить каталог' }).waitFor();
    fail = false;
    await page.getByRole('button', { name: 'Попробовать снова' }).click();
    await page.getByRole('heading', { name: 'Крем 1', exact: true }).waitFor();
    await page.goto(`${base}/?brandId=999`);
    await page.getByRole('heading', { name: 'Ничего не найдено' }).waitFor();
    await page.goto(`${base}/products/999`);
    await page.getByRole('heading', { name: 'Товар недоступен' }).waitFor();
    await page.getByRole('button', { name: 'В каталог' }).click();
    await page.getByRole('heading', { name: 'Каталог', exact: true }).waitFor();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: 'artifacts/catalog-dark.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: catalog, filters, pages, URL, variants, prices, safe text, image fallback, return/scroll, Telegram BackButton, 404, retry, mobile and dark theme.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
