const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// R06/U03: product input survives a reload or an expired login, per account and product, on this device only.
(async () => {
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // device: Bot API 9.0 DeviceStorage (kept in sessionStorage so it survives a reload of the test page);
  // old: a client before 9.0, so the browser storage is used; none: no storage at all.
  let client='device',telegramId='9000000001',login='ok';
  await page.addInitScript(()=>{
   if(sessionStorage.getItem('test:block-local'))Object.defineProperty(window,'localStorage',{get(){throw new DOMException('denied','SecurityError');}});
  });
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:`
   const mode=${JSON.stringify(client)};
   const later=callback=>setTimeout(callback,5);
   window.__closing=[];
   window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){},
    isVersionAtLeast:version=>Number(version)<=(mode==='device'?9:6),
    enableClosingConfirmation(){window.__closing.push(true);},disableClosingConfirmation(){window.__closing.push(false);},
    DeviceStorage:mode==='device'?{
     setItem(key,value,callback){sessionStorage.setItem('device:'+key,value);later(()=>callback?.(null,true));},
     getItem(key,callback){const value=sessionStorage.getItem('device:'+key);later(()=>callback(null,value??''));},
     removeItem(key,callback){sessionStorage.removeItem('device:'+key);later(()=>callback?.(null,true));}}:undefined}};`}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  await page.route('**/api/auth/telegram',route=>login==='ok'?route.fulfill({json:{telegramId,role:'Admin'}})
   :route.fulfill({status:401,json:{code:'auth_expired',title:'Вход истёк. Откройте приложение заново из Telegram.'}}));
  const product={id:'7',name:'Крем',description:'Описание',brandId:'1',typeId:'1',imagePath:null,isVisible:false,version:'v1',
   variants:[{id:'1',volume:'50 мл',size:null,shade:null,priceRub:100,isVisible:true}]};
  const saves=[];let saveMode='ok',checkMode='missing';
  await page.route('**/api/admin/**',route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
   if(url.pathname.startsWith('/api/admin/operations/'))return checkMode==='found'?route.fulfill({json:{kind:'product.create',productId:'7'}})
    :route.fulfill({status:404,json:{code:'operation_not_found',title:'Сохранение с этим ключом не выполнялось.'}});
   if(url.pathname==='/api/admin/products')
    if(request.method()==='GET')return route.fulfill({json:{items:[{id:'7',name:'Крем',brandName:'Бренд',isVisible:false}],page:1,pageSize:20,hasMore:false}});
   if(request.method()==='GET')return route.fulfill({json:product});
   saves.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});
   if(saveMode==='expired')return route.fulfill({status:401,json:{code:'auth_expired',title:'Вход истёк. Откройте приложение заново из Telegram.'}});
   if(saveMode==='drop')return route.abort();
   if(saveMode==='hang')return; // the app is closed before an answer comes
   return route.fulfill({status:request.method()==='POST'?201:200,json:product});
  });
  const label=text=>page.getByLabel(text,{exact:true});
  const button=text=>page.getByRole('button',{name:text,exact:true});
  const text=value=>page.getByText(value,{exact:true});
  const products=async()=>{await button('Управление магазином').click();await button('Товары').click();await button('Изменить Крем').waitFor();};
  // Opens the app again from its start address, as Telegram does after the Mini App was closed.
  const reload=async()=>{await page.goto(base);await products();};
  const stored=()=>page.evaluate(()=>Object.fromEntries([...Object.keys(sessionStorage).filter(key=>key.startsWith('device:draft:')).map(key=>[key,sessionStorage.getItem(key)]),
   ...(()=>{try{return Object.keys(localStorage).filter(key=>key.startsWith('draft:')).map(key=>['local:'+key,localStorage.getItem(key)]);}catch{return [];}})()]));
  const until=async(check,message)=>{for(let i=0;i<60;i++){if(await check())return;await page.waitForTimeout(50);}assert.fail(message);};
  const newKey='device:draft:v1:9000000001:new';

  await page.goto(base);await products();
  // 1. Typed input is stored after a short pause, in DeviceStorage, without login data; the app asks before closing.
  await button('Добавить товар').click();
  await label('Название товара').fill('Черновик крема');
  await label('Описание товара').fill('Текст, который жалко потерять');
  await label('Цена варианта 1').fill('250');
  await until(async()=>JSON.parse((await stored())[newKey]??'null')?.fields?.variants?.[0]?.price==='250','draft is written');
  const value=(await stored())[newKey];
  assert.ok(!value.includes('test-only')&&!/role|Admin|initData/.test(value),'no login data in the draft');
  assert.deepEqual(Object.keys(await stored()),[newKey],'DeviceStorage is used instead of localStorage');
  assert.equal(await page.evaluate(()=>window.__closing.at(-1)),true);

  // 1b. Input typed less than the pause before leaving the form is not lost.
  await button('Закрыть форму').click();
  await button('Изменить Крем').click();
  await label('Название товара').fill('Быстрая правка');
  await button('Закрыть форму').click();
  await until(async()=>JSON.parse((await stored())['device:draft:v1:9000000001:7']??'null')?.fields?.name==='Быстрая правка','pending input is written on leaving');
  await page.evaluate(()=>sessionStorage.removeItem('device:draft:v1:9000000001:7'));

  // 2. After a reload the draft is offered, not applied silently; restoring brings back fields and the save key.
  await reload();await button('Добавить товар').click();
  await page.getByText(/^Найден несохранённый черновик от \d\d:\d\d\.$/).waitFor();
  assert.equal(await label('Название товара').isDisabled(),true,'no typing over an unanswered draft');
  await button('Восстановить').click();
  assert.equal(await label('Название товара').inputValue(),'Черновик крема');
  assert.equal(await label('Цена варианта 1').inputValue(),'250');
  const draftKey=JSON.parse(value).saveKey;

  // 3. A confirmed save removes the draft and the closing question; the restored form repeats the stored key.
  await button('Сохранить товар').click();
  await text('Товар сохранён.').waitFor();
  assert.equal(saves.at(-1).key,draftKey);
  await until(async()=>!(newKey in await stored()),'draft removed after a confirmed save');
  assert.equal(await page.evaluate(()=>window.__closing.at(-1)),false);
  await button('Закрыть форму').click();

  // 4. Another account on the same device does not see the draft; "Отбросить" deletes it.
  await button('Изменить Крем').click();
  await label('Описание товара').fill('Правка первого администратора');
  await until(async()=>'device:draft:v1:9000000001:7' in await stored(),'edit draft is written per product');
  telegramId='9000000002';await reload();
  await button('Изменить Крем').click();
  await label('Описание товара').waitFor();await page.waitForTimeout(200);
  assert.equal(await label('Описание товара').inputValue(),'Описание');
  assert.equal(await text('Восстановить').count(),0);
  await button('Закрыть форму').click();
  telegramId='9000000001';await reload();
  await button('Изменить Крем').click();
  await button('Отбросить').click();
  assert.equal(await label('Описание товара').inputValue(),'Описание');
  await until(async()=>!('device:draft:v1:9000000001:7' in await stored()),'rejected draft is removed');

  // 5. "Отбросить черновик" in the form returns the saved values and deletes the stored input.
  await label('Название товара').fill('Случайная правка');
  await until(async()=>'device:draft:v1:9000000001:7' in await stored(),'draft written');
  await button('Отбросить черновик').click();
  assert.equal(await label('Название товара').inputValue(),'Крем');
  await until(async()=>!('device:draft:v1:9000000001:7' in await stored()),'discarded draft is removed');
  await button('Закрыть форму').click();

  // 6. An expired or damaged draft is not offered and is removed.
  await page.evaluate(()=>{
   sessionStorage.setItem('device:draft:v1:9000000001:new',JSON.stringify({v:1,savedAt:Date.now()-8*24*3600*1000,base:null,
    saveKey:crypto.randomUUID(),unconfirmed:false,fields:{name:'Старое',description:'',brandId:'1',typeId:'1',imagePath:'',visible:false,variants:[]}}));
   sessionStorage.setItem('device:draft:v1:9000000001:7','{"v":1,"fields":');
  });
  await button('Добавить товар').click();await label('Название товара').waitFor();await page.waitForTimeout(200);
  assert.equal(await label('Название товара').inputValue(),'');
  await button('Закрыть форму').click();
  await button('Изменить Крем').click();await label('Название товара').waitFor();await page.waitForTimeout(200);
  assert.equal(await label('Название товара').inputValue(),'Крем');
  assert.deepEqual(await stored(),{});
  await button('Закрыть форму').click();

  // 7. A save rejected because the login expired: the panel closes, the input is kept and offered after a new login.
  saveMode='expired';
  await button('Добавить товар').click();
  await label('Название товара').fill('До истечения входа');
  await label('Описание товара').fill('Описание');
  await label('Цена варианта 1').fill('300');
  await button('Сохранить товар').click();
  await text('Для управления магазином откройте приложение заново из Telegram.').waitFor();
  assert.ok(newKey in await stored(),'draft kept after auth_expired');
  saveMode='ok';checkMode='missing';
  await button('Повторить вход').click();
  await button('Товары').click();await button('Добавить товар').click();
  await page.getByText(/^Найден несохранённый черновик от \d\d:\d\d\. Его сохранение не было подтверждено/).waitFor();
  await button('Восстановить').click();
  // The interrupted save is checked first: not found, so the form says so and keeps the input.
  await text('Товар не сохранён. Можно сохранить ещё раз.').waitFor();
  assert.equal(await label('Название товара').inputValue(),'До истечения входа');
  await button('Сохранить товар').click();
  await text('Товар сохранён.').waitFor();
  await button('Закрыть форму').click();

  // 8. Outcome unknown, then the app is closed: after restoring, the check finds the save and the draft is removed.
  saveMode='drop';checkMode='down';
  await page.route('**/api/admin/operations/**',route=>checkMode==='down'?route.abort():route.fallback());
  await button('Добавить товар').click();
  await label('Название товара').fill('Потерянный ответ');
  await label('Описание товара').fill('Описание');
  await label('Цена варианта 1').fill('400');
  await button('Сохранить товар').click();
  await page.getByText(/^Не удалось уточнить, сохранился ли товар\./).waitFor({timeout:20_000});
  const lost=saves.at(-1).key;
  assert.equal(JSON.parse((await stored())[newKey]).unconfirmed,true);
  saveMode='ok';checkMode='found';
  await reload();await button('Добавить товар').click();
  await button('Восстановить').click();
  await text('Товар сохранён.').waitFor();
  assert.equal(saves.at(-1).key,lost,'no new save was sent');
  await until(async()=>!(newKey in await stored()),'draft removed once the save is confirmed');
  await button('Закрыть форму').click();

  // 8b. A sent save is recorded at once, so closing the app during the request still leads to a check.
  saveMode='hang';
  await button('Добавить товар').click();
  await label('Название товара').fill('Закрыли во время сохранения');
  await label('Описание товара').fill('Описание');
  await label('Цена варианта 1').fill('500');
  await button('Сохранить товар').click();
  await button('Сохраняем…').waitFor();
  const sentAt=Date.now();
  await until(async()=>JSON.parse((await stored())[newKey]??'null')?.unconfirmed===true,'unconfirmed save recorded');
  assert.ok(Date.now()-sentAt<400,'recorded without the input pause');
  const hung=saves.at(-1).key;
  saveMode='ok';checkMode='found';
  await reload();await button('Добавить товар').click();
  await button('Восстановить').click();
  await text('Товар сохранён.').waitFor();
  assert.equal(saves.at(-1).key,hung,'checked, not sent again');
  await button('Закрыть форму').click();

  // 9. A client before Bot API 9.0 keeps the draft in localStorage and has no closing question.
  client='old';await reload();
  await button('Добавить товар').click();
  await label('Название товара').fill('Старый клиент');
  await until(async()=>'local:draft:v1:9000000001:new' in await stored(),'localStorage fallback');
  assert.deepEqual(await page.evaluate(()=>window.__closing),[]);
  await reload();await button('Добавить товар').click();
  await button('Восстановить').click();
  assert.equal(await label('Название товара').inputValue(),'Старый клиент');
  await button('Отбросить черновик').click();
  await button('Закрыть форму').click();

  // 10. No storage at all: an honest warning instead of a silent loss.
  await page.evaluate(()=>sessionStorage.setItem('test:block-local','1'));
  await reload();await button('Добавить товар').click();
  await text('Черновик не сохраняется на этом устройстве: не закрывайте форму до сохранения.').waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: DeviceStorage draft without login data, offer/restore/reject/discard, per account and product, expiry, kept after auth_expired, unknown outcome checked after restore, localStorage fallback, no-storage warning, closing confirmation.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
