const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// R05/U02: bounded waits, safe retries and an explicit "checking the result" state for product saves.
(async () => {
 const browser=await launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install();
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:
   'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  await page.route('**/api/auth/telegram',route=>route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
  const product={id:'7',name:'Крем',description:'Описание',brandId:'1',typeId:'1',imagePath:null,isVisible:false,version:'AAAAAQ==',
   variants:[{id:'1',volume:null,size:null,shade:null,priceRub:100,isVisible:true}]};
  let listCalls=0,listMode='flaky';
  const saves=[];let saveMode='ok';
  const checks=[];let checkMode='found';
  await page.route('**/api/admin/**',route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
   if(url.pathname.startsWith('/api/admin/operations/')){
    checks.push(url.pathname.split('/').pop());
    if(checkMode==='found')return route.fulfill({json:{kind:'product.create',productId:'7'}});
    if(checkMode==='missing')return route.fulfill({status:404,json:{code:'operation_not_found',title:'Сохранение с этим ключом не выполнялось.'}});
    return route.abort();
   }
   if(request.method()==='GET'&&url.pathname==='/api/admin/products'){
    listCalls++;
    // A temporary gateway failure on a read is repeated automatically; 401 never is.
    // Two failures: with development StrictMode the first request may belong to a discarded mount,
    // so success after two 502s proves at least one automatic retry in either mode.
    if(listMode==='flaky'&&listCalls<=2)return route.fulfill({status:502,body:'Bad gateway'});
    if(listMode==='unauthorized')return route.fulfill({status:401,json:{code:'auth_expired',title:'Вход истёк. Откройте приложение заново из Telegram.'}});
    return route.fulfill({json:{items:[],page:1,pageSize:20,hasMore:false}});
   }
   if(request.method()==='GET')return route.fulfill({json:product});
   saves.push(request.headers()['idempotency-key']);
   if(saveMode==='ok')return route.fulfill({status:201,json:product});
   if(saveMode==='drop-once'&&saves.length===1)return route.abort();
   if(saveMode==='drop-once')return route.fulfill({status:201,json:product});
   if(saveMode==='hang')return; // never answers: only the time limit ends it
   return route.abort();
  });
  const fill=async()=>{
   await page.getByLabel('Название товара',{exact:true}).fill('Крем');
   await page.getByLabel('Описание товара',{exact:true}).fill('Описание');
   await page.getByLabel('Цена варианта 1',{exact:true}).fill('100');
  };
  const openNew=async()=>{
   await page.getByRole('button',{name:'Добавить товар',exact:true}).click();
   await fill();
  };
  const settle=async()=>{for(let i=0;i<20;i++)await page.clock.runFor(500);};

  await page.goto(base);
  await page.getByRole('button',{name:'Управление магазином',exact:true}).click();
  await page.getByRole('button',{name:'Товары',exact:true}).click();
  await settle();
  await page.getByText('Товаров пока нет.',{exact:true}).waitFor();
  assert.equal(listCalls,3);

  // 1. Dropped connection on the first attempt: repeated once with the same key, one confirmed save.
  saveMode='drop-once';saves.length=0;
  await openNew();
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await settle();
  await page.getByText('Товар сохранён.',{exact:true}).waitFor();
  assert.equal(saves.length,2);assert.equal(saves[0],saves[1]);
  await page.getByRole('button',{name:'Закрыть форму',exact:true}).click();

  // 2. Both attempts dropped: the interface checks the outcome instead of guessing; found → saved.
  saveMode='drop';saves.length=0;checks.length=0;checkMode='found';
  await openNew();
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await settle();
  await page.getByText('Товар сохранён.',{exact:true}).waitFor();
  assert.equal(saves.length,2);assert.deepEqual(checks,[saves[0]]);
  await page.getByRole('button',{name:'Закрыть форму',exact:true}).click();

  // 3. Not found → "not saved", the form keeps its input and the next save reuses the key.
  saves.length=0;checks.length=0;checkMode='missing';
  await openNew();
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await settle();
  await page.getByText('Товар не сохранён. Можно сохранить ещё раз.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Название товара',{exact:true}).inputValue(),'Крем');
  const key=saves[0];saveMode='ok';
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await settle();
  await page.getByText('Товар сохранён.',{exact:true}).waitFor();
  assert.equal(saves.at(-1),key);
  await page.getByRole('button',{name:'Закрыть форму',exact:true}).click();

  // 4. The check itself fails → explicit unknown state with "check again"; then found.
  saveMode='drop';saves.length=0;checks.length=0;checkMode='down';
  await openNew();
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await settle();
  await page.getByText(/^Не удалось уточнить, сохранился ли товар\./).waitFor();
  assert.equal(checks.length,3);
  checkMode='found';
  await page.getByRole('button',{name:'Проверить ещё раз',exact:true}).click();
  await settle();
  await page.getByText('Товар сохранён.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Закрыть форму',exact:true}).click();

  // 5. A save that never answers ends at the 30 s limit and goes to checking; no endless "Сохраняем…".
  saveMode='hang';saves.length=0;checks.length=0;checkMode='found';
  await openNew();
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await page.clock.runFor(29_000);
  await page.getByRole('button',{name:'Сохраняем…',exact:true}).waitFor();
  await page.clock.runFor(2_000);
  await settle();
  await page.getByText('Товар сохранён.',{exact:true}).waitFor();
  assert.equal(saves.length,1);assert.equal(checks.length,1);
  await page.getByRole('button',{name:'Закрыть форму',exact:true}).click();

  // 6. 401 is final: not repeated.
  listMode='unauthorized';listCalls=0;
  await page.getByRole('button',{name:'Справочники',exact:true}).click();
  await page.getByRole('button',{name:'Товары',exact:true}).click();
  await page.waitForTimeout(300);
  const before=listCalls;assert.ok(before>=1);
  // A retry would come after the 0.35–0.65 s backoff; development StrictMode may mount twice at once.
  await settle();
  assert.equal(listCalls,before);
  assert.deepEqual(errors,[]);
  console.log('PASS: read retry after 502, one retry of a keyed save, outcome check found/missing/failed, 30 s save limit, no retry of 401.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
