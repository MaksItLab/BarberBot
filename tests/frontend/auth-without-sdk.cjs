const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// Deliberately fake launch data. Only mocked API responses confer roles in this UI test.
const launchData = 'user=%7B%22id%22%3A9000000001%7D&auth_date=1792051200&hash=test-only';
const hash = new URLSearchParams({tgWebAppData:launchData,tgWebAppPlatform:'android'});
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    async function setup(status) {
      const context = await browser.newContext({viewport:{width:390,height:844}});
      const page = await context.newPage();
      const calls = {auth:0,admin:0};
      const errors=[];
      page.on('pageerror', error=>errors.push(error.message));
      await page.route('https://telegram.org/**',route=>route.abort());
      await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')
        ? {items:[],page:1,pageSize:20,hasMore:false}:[]}));
      await page.route('**/api/auth/telegram',route=>{
        calls.auth++;
        assert.equal(route.request().headers().authorization,'tma '+launchData);
        return route.fulfill({status,json:{telegramId:'9000000001',role:'Admin'}});
      });
      await page.route('**/api/admin/**',route=>{
        calls.admin++;
        assert.equal(route.request().headers().authorization,'tma '+launchData);
        return route.fulfill({json:[]});
      });
      return {context,page,calls,errors};
    }
    const success=await setup(200);
    await success.page.goto(base+'/#'+hash);
    await success.page.getByRole('button',{name:'Управление магазином',exact:true}).click();
    await success.page.getByRole('heading',{name:'Управление магазином',exact:true}).waitFor();
    await success.page.getByLabel('Название',{exact:true}).waitFor();
    assert.equal(new URL(success.page.url()).hash,'');
    assert.ok(success.calls.admin>0);
    assert.deepEqual(success.errors,[]);
    await success.context.close();

    const rejected=await setup(401);
    await rejected.page.goto(base+'/#'+hash);
    await rejected.page.getByText('Для управления магазином откройте приложение заново из Telegram.').waitFor();
    assert.equal(await rejected.page.getByRole('button',{name:'Управление магазином',exact:true}).count(),0);
    await rejected.page.getByRole('button',{name:'Повторить вход',exact:true}).click();
    await rejected.page.waitForFunction(()=>Boolean(document.querySelector('.auth-notice')));
    assert.deepEqual(rejected.errors,[]);
    await rejected.context.close();

    const guest=await setup(200);
    await guest.page.goto(base);
    await guest.page.getByRole('heading',{name:'Каталог скоро появится'}).waitFor();
    assert.equal(guest.calls.auth,0);
    assert.equal(await guest.page.getByRole('button',{name:'Управление магазином',exact:true}).count(),0);
    await guest.page.goto(base+'/?launch=test#tgWebAppPlatform=android');
    await guest.page.getByText('Telegram не передал данные для входа. Закройте магазин и откройте его заново кнопкой бота.').waitFor();
    assert.equal(guest.calls.auth,0);
    assert.deepEqual(guest.errors,[]);
    await guest.context.close();
    console.log('PASS: unavailable Telegram SDK, unchanged launch data, admin navigation, server rejection, retry, ordinary guest and missing-data notice.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
