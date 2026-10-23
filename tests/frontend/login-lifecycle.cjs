const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// R03: returning to the Mini App rechecks the login without resetting the open form;
// a late answer never overrides a newer one; a network failure is not a lost role.
(async () => {
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let version=8;
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:`
   const handlers={};
   window.__emit=name=>(handlers[name]??[]).forEach(callback=>callback());
   window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",
    isVersionAtLeast:value=>Number(value)<=${version},
    onEvent(name,callback){(handlers[name]??=[]).push(callback);},
    offEvent(name,callback){handlers[name]=(handlers[name]??[]).filter(value=>value!==callback);}}};`}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  // Each login answer is taken from the queue in request order; the default is a confirmed admin.
  const logins=[];let queue=[];
  await page.route('**/api/auth/telegram',async route=>{
   logins.push(Date.now());
   const next=queue.shift()??{json:{telegramId:'9000000001',role:'Admin'}};
   if(next.delay)await new Promise(resolve=>setTimeout(resolve,next.delay));
   if(next.abort)return route.abort().catch(()=>{});
   return route.fulfill(next).catch(()=>{}); // the page may have aborted it already
  });
  await page.route('**/api/admin/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
   return route.fulfill({json:{items:[],page:1,pageSize:20,hasMore:false}});
  });
  const label=text=>page.getByLabel(text,{exact:true});
  const button=text=>page.getByRole('button',{name:text,exact:true});
  const returnToApp=()=>page.evaluate(()=>window.__emit('activated'));
  const settled=async count=>{for(let i=0;i<80&&logins.length<count;i++)await page.waitForTimeout(25);assert.equal(logins.length,count);await page.waitForTimeout(150);};
  const open=async()=>{
   await button('Управление магазином').click();await button('Товары').click();await button('Добавить товар').click();
   await label('Название товара').fill('Ввод до сворачивания');
  };
  await page.goto(base);
  await open();
  const before=logins.length;

  // 1. Return from the background: one quiet recheck, the form and its input stay, no "checking" screen.
  queue=[{delay:600,json:{telegramId:'9000000001',role:'Admin'}}];
  await returnToApp();
  await page.waitForTimeout(300); // while the recheck is still waiting for its answer
  assert.equal(await page.getByText('Проверяем вход через Telegram…',{exact:true}).count(),0);
  await settled(before+1);
  await page.waitForTimeout(400);
  assert.equal(await label('Название товара').inputValue(),'Ввод до сворачивания');

  // 2. A slow answer of an older check (role revoked) is overtaken by a newer one: the newer one decides.
  queue=[{delay:800,status:403,json:{code:'forbidden',title:'Нет прав.'}},{json:{telegramId:'9000000001',role:'Admin'}}];
  await returnToApp();await returnToApp();
  await settled(before+3);
  await page.waitForTimeout(1000);
  assert.equal(await label('Название товара').inputValue(),'Ввод до сворачивания','late 403 did not close the form');
  assert.equal(await page.getByText('У вашего аккаунта нет прав для управления магазином.',{exact:true}).count(),0);

  // 3. No connection on return: the confirmed role is kept and the form stays; the notice offers a retry.
  queue=[{abort:true},{abort:true},{abort:true}];
  await returnToApp();
  await page.getByText(/Нет связи с сервером|Не удалось проверить вход/).waitFor();
  assert.equal(await label('Название товара').inputValue(),'Ввод до сворачивания');
  await button('Повторить вход').click();
  await page.getByText(/Нет связи с сервером|Не удалось проверить вход/).waitFor({state:'detached'});

  // 4. The role was revoked meanwhile: the next check closes the admin panel; the draft stays on the device.
  queue=[{status:403,json:{code:'forbidden',title:'Нет прав для управления магазином.'}}];
  await returnToApp();
  await page.getByText('У вашего аккаунта нет прав для управления магазином.',{exact:true}).waitFor();
  assert.equal(await label('Название товара').count(),0);
  assert.ok(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('draft:v1:9000000001:new'))),'draft kept');

  // 5. Access restored: returning again brings the panel back without reloading the page.
  await returnToApp();
  await button('Товары').waitFor();

  // 6. Login expired while away: the notice asks to reopen the app from Telegram.
  queue=[{status:401,json:{code:'auth_expired',title:'Вход истёк. Откройте приложение заново из Telegram.'}}];
  await returnToApp();
  await page.getByText('Для управления магазином откройте приложение заново из Telegram.',{exact:true}).waitFor();

  // 7. A client before Bot API 8.0 has no "activated": the page becoming visible triggers the recheck.
  version=7;queue=[];
  await page.goto(base);
  await button('Управление магазином').waitFor();
  const old=logins.length;
  await page.evaluate(()=>window.__emit('activated'));
  await page.waitForTimeout(300);
  assert.equal(logins.length,old,'no activated listener on old clients');
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await settled(old+1);
  assert.deepEqual(errors,[]);
  console.log('PASS: quiet recheck on return keeps the form, late answer ignored, network failure keeps role, revoked role closes panel with draft kept, restored access, expired login, visibility fallback.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
