// U05: laboratory responsiveness profile. Chromium with CPU slowed down 4x, the four interactions from the
// acceptance criteria, each repeated; Event Timing gives the interaction duration (what INP is built from).
// A measurement, not a regression test: timings depend on the machine, so it is run by hand, not in CI.
// Usage: SHOP_UI_URL=http://127.0.0.1:5173 node scripts/lab-profile.cjs [--budget=200] [--repeat=5]
const {launch} = require('../tests/frontend/browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
const option = (name, fallback) => Number(process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const budget = option('budget', 200), repeat = option('repeat', 5);

const types = ['Уход', 'Волосы', 'Борода', 'Бритьё'].map((name, i) => ({id: String(i + 1), name}));
const card = (i, type = '') => ({id: String(i), name: `Товар ${type}${i} с длинным названием для проверки переноса`, brandName: 'Бренд 1', imagePath: null, priceRub: 100 + i, hasPriceRange: i % 3 === 0});

(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    await page.route('https://telegram.org/**', route => route.fulfill({contentType: 'application/javascript', body:
      'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
    await page.route('**/api/auth/telegram', route => route.fulfill({json: {telegramId: '9000000001', role: 'Admin'}}));
    await page.route('**/api/catalog/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/brands')) return route.fulfill({json: [{id: '1', name: 'Бренд 1'}]});
      if (url.pathname.endsWith('/types')) return route.fulfill({json: types});
      const detail = /\/products\/(\d+)$/.exec(url.pathname)?.[1];
      if (detail) return route.fulfill({json: {...card(Number(detail)), description: 'Описание', brandDescription: null, typeName: 'Уход',
        variants: [{id: '1', volume: '50 мл', size: null, shade: null, priceRub: 100}, {id: '2', volume: '100 мл', size: null, shade: null, priceRub: 180}]}});
      const number = Number(url.searchParams.get('page') ?? 1);
      return route.fulfill({json: {items: Array.from({length: 20}, (_, i) => card((number - 1) * 20 + i + 1, url.searchParams.get('typeId') ?? '')), page: number, pageSize: 20, hasMore: number < 50}});
    });
    await page.route('**/api/admin/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/brands')) return route.fulfill({json: [{id: '1', name: 'Бренд 1', description: null}]});
      if (url.pathname.endsWith('/types')) return route.fulfill({json: types});
      if (route.request().method() === 'GET') return route.fulfill({json: {items: [], page: 1, pageSize: 20, hasMore: false}});
      const input = route.request().postDataJSON();
      return route.fulfill({status: 201, json: {...input, id: '1', version: '1', variants: input.variants.map((value, i) => ({...value, id: String(i + 1)}))}});
    });
    const button = name => page.getByRole('button', {name, exact: true});
    await page.goto(base); await page.locator('.product-card').first().waitFor();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    await page.evaluate(() => {
      window.__events = []; window.__long = [];
      new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.interactionId) window.__events.push(entry.duration); })
        .observe({type: 'event', durationThreshold: 16, buffered: true});
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__long.push(entry.duration); }).observe({type: 'longtask'});
    });
    /** Runs one interaction and returns its longest event duration (below 16 ms Event Timing reports nothing) and long tasks. */
    const measure = async (act, done) => {
      await page.evaluate(() => { window.__events.length = 0; window.__long.length = 0; });
      await act(); await done(); await page.waitForTimeout(300);
      return page.evaluate(() => ({interaction: Math.max(0, ...window.__events), longest: Math.max(0, ...window.__long)}));
    };
    const results = {};
    const record = (name, sample) => (results[name] ??= []).push(sample);
    const cards = () => page.locator('.product-card').count();

    for (let round = 0; round < repeat; round++) {
      const type = types[round % types.length];
      // Done when the new list is shown; the card names carry the type, so this works before and after U01.
      record('Фильтр', await measure(() => button(type.name).click(),
        () => page.waitForFunction(id => document.querySelector('.product-card h2')?.textContent.startsWith(`Товар ${id}1 `), type.id)));
      const total = await cards() + 20;
      record('Показать ещё', await measure(() => button('Показать ещё').click(),
        () => page.waitForFunction(total => document.querySelectorAll('.product-card').length === total, total)));
      record('Открытие товара', await measure(() => page.locator('.product-card a').first().click(), () => page.locator('.detail h1').waitFor()));
      await button('← В каталог').click(); await page.locator('.product-card').first().waitFor();
    }
    await button('Управление магазином').click(); await button('Товары').click();
    for (let round = 0; round < repeat; round++) {
      await button('Добавить товар').click();
      await page.getByLabel('Название товара', {exact: true}).fill(`Крем ${round}`);
      await page.getByLabel('Описание товара', {exact: true}).fill('Описание');
      await page.getByLabel('Объём варианта 1', {exact: true}).fill('50 мл');
      await page.getByLabel('Цена варианта 1', {exact: true}).fill('199');
      record('Сохранение формы', await measure(() => button('Сохранить товар').click(), () => page.getByText('Товар сохранён.', {exact: true}).waitFor()));
      await button('Закрыть форму').click();
    }

    const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
    const shown = value => value < 16 ? '<16' : String(Math.round(value));
    console.log(`Лабораторный профиль: Chromium, CPU ×4, 390×844, повторов ${repeat}. Взаимодействие — Event Timing, мс.\n`);
    console.log('| Действие | Взаимодействие: медиана / максимум | Длинные задачи: медиана / максимум |');
    console.log('| --- | --- | --- |');
    let over = false;
    for (const [name, samples] of Object.entries(results)) {
      const interactions = samples.map(s => s.interaction), longest = samples.map(s => s.longest);
      if (Math.max(...interactions) > budget) over = true;
      console.log(`| ${name} | ${shown(median(interactions))} / ${shown(Math.max(...interactions))} | ${median(longest) ? Math.round(median(longest)) : 'нет'} / ${Math.max(...longest) ? Math.round(Math.max(...longest)) : 'нет'} |`);
    }
    console.log(over ? `\nFAIL: взаимодействие дольше ${budget} мс.` : `\nPASS: все взаимодействия не дольше ${budget} мс.`);
    if (over) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
