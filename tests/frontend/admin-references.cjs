const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://telegram.org/**', route => route.fulfill({ contentType: 'application/javascript',
      body: 'window.Telegram={WebApp:{initData:"test-init-data",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};' }));
    let role = 'Admin';
    await page.route('**/api/auth/telegram', route => route.fulfill({ json: { telegramId: '1', role } }));
    await page.route('**/api/catalog/**', route => route.fulfill({ json: route.request().url().includes('/products')
      ? { items: [], page: 1, pageSize: 20, hasMore: false } : [] }));
    const tables = { brands: [], types: [] };
    await page.route('**/api/admin/**', async route => {
      assert.equal(route.request().headers().authorization, 'tma test-init-data');
      const [, table, id] = /\/api\/admin\/(brands|types)(?:\/(\d+))?/.exec(new URL(route.request().url()).pathname);
      if (route.request().method() === 'GET') return route.fulfill({ json: tables[table] });
      const input = route.request().postDataJSON();
      if (tables[table].some(value => value.name === input.name.trim() && value.id !== id))
        return route.fulfill({ status: 409, json: { title: 'Такое название уже существует.' } });
      const value = { id: id || String(tables[table].length + 1), name: input.name.trim(), description: input.description || null };
      if (id) tables[table] = tables[table].map(row => row.id === id ? value : row); else tables[table].push(value);
      return route.fulfill({ status: id ? 200 : 201, json: value });
    });
    const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
    await page.goto(base);
    await page.getByRole('button', { name: 'Управление магазином' }).click();
    await page.getByLabel('Название', { exact: true }).fill('Бренд А');
    await page.getByLabel('Описание бренда').fill('Описание');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('button', { name: 'Изменить Бренд А', exact: true }).waitFor();
    await page.getByLabel('Название', { exact: true }).fill('Бренд А');
    await page.getByLabel('Описание бренда').fill('Не терять');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Такое название уже существует.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Название', { exact: true }).inputValue(), 'Бренд А');
    assert.equal(await page.getByLabel('Описание бренда').inputValue(), 'Не терять');
    await page.getByRole('button', { name: 'Изменить Бренд А', exact: true }).click();
    await page.getByLabel('Название', { exact: true }).fill('Бренд Б');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('button', { name: 'Изменить Бренд Б', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Типы косметики', exact: true }).click();
    await page.getByLabel('Название', { exact: true }).fill('Уход');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('button', { name: 'Изменить Уход', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'artifacts/admin-references-mobile.png', fullPage: true });
    role = 'Customer';
    await page.reload();
    await page.getByText('Управление доступно администратору при входе через Telegram.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Сохранить', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: admin references create/edit, duplicates preserve form, type management, customer UI denied, mobile.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
