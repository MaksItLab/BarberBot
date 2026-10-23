const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// U01: references load once, the previous list stays marked while a filter loads, a late answer for an
// earlier filter never wins, and a failed reference or product request does not wipe the shown catalog.
(async () => {
 const browser=await launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:
   'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/auth/telegram',route=>route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
  const types=[{id:'1',name:'Уход'},{id:'2',name:'Борода'},{id:'3',name:'Волосы'}];
  const requests={products:0,brands:0,types:0};
  // Per-request behaviour: delay (ms) and failure, decided by the test before each step.
  let productDelay=()=>0,productFail=()=>false,referenceFail=false;
  await page.route('**/api/catalog/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/brands')||url.pathname.endsWith('/types')){
    const table=url.pathname.endsWith('/brands')?'brands':'types';requests[table]++;
    if(referenceFail)return route.fulfill({status:400,contentType:'application/problem+json',json:{status:400,title:'x',code:'request_failed'}});
    return route.fulfill({json:table==='brands'?[{id:'1',name:'Бренд'}]:types});
   }
   requests.products++;
   const typeId=url.searchParams.get('typeId')??'all';
   const delay=productDelay(typeId);if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
   if(productFail(typeId))return route.fulfill({status:400,contentType:'application/problem+json',json:{status:400,title:'x',code:'request_failed'}}).catch(()=>{});
   const items=Array.from({length:3},(_,i)=>({id:`${typeId}${i}`,name:`Товар ${typeId}-${i}`,brandName:'Бренд',imagePath:null,priceRub:100,hasPriceRange:false}));
   return route.fulfill({json:{items,page:1,pageSize:20,hasMore:false}}).catch(()=>{}); // the page may have aborted it
  });
  await page.route('**/api/admin/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:types});
   if(route.request().method()==='GET')return route.fulfill({json:{items:[],page:1,pageSize:20,hasMore:false}});
   const input=route.request().postDataJSON();
   return route.fulfill({status:201,json:{id:'9',name:input.name,description:null}});
  });
  const button=text=>page.getByRole('button',{name:text,exact:true});
  const names=()=>page.locator('.product-card h2').allTextContents();
  const shows=async typeId=>page.waitForFunction(typeId=>document.querySelector('.product-card h2')?.textContent===`Товар ${typeId}-0`,typeId);
  const busy=()=>page.locator('.product-grid').getAttribute('aria-busy');

  await page.goto(base);await shows('all');
  await page.waitForTimeout(300);
  // 1. One request each on the first view, even with the development double effect.
  assert.deepEqual(requests,{products:1,brands:1,types:1});

  const listTop=await page.locator('.product-grid').evaluate(element=>element.getBoundingClientRect().top+scrollY);
  // 2. A filter change asks only for products; the previous list stays, marked as updating.
  productDelay=()=>700;
  await button('Борода').click();
  await page.getByText('Обновляем…',{exact:true}).waitFor();
  assert.equal(await page.locator('.catalog-status').textContent(),'Обновляем каталог…','announced in the live region');
  const gridTop=()=>page.locator('.product-grid').evaluate(element=>element.getBoundingClientRect().top+scrollY);
  assert.equal(await gridTop(),listTop,'the list does not jump while updating');
  assert.deepEqual(await names(),['Товар all-0','Товар all-1','Товар all-2'],'previous list kept while loading');
  assert.equal(await busy(),'true');
  assert.equal(await page.locator('.empty-state').count(),0);
  await shows('2');
  assert.equal(await busy(),'false');
  assert.equal(await page.getByText('Обновляем…',{exact:true}).count(),0);
  assert.equal(await page.locator('.catalog-status').textContent(),'');
  assert.deepEqual(requests,{products:2,brands:1,types:1},'references not reloaded');

  // 3. Answers out of order: the slow answer for an earlier choice never replaces the last choice.
  productDelay=typeId=>typeId==='1'?900:100;
  await button('Уход').click();await button('Волосы').click();
  await shows('3');
  await page.waitForTimeout(1200);
  assert.equal((await names())[0],'Товар 3-0','late answer for the earlier filter ignored');
  assert.equal(await page.locator('select[aria-label="Тип косметики"]').inputValue(),'3');
  productDelay=()=>0;

  // 4. Products fail while a list is shown: the list stays with an honest notice; retry recovers.
  productFail=typeId=>typeId==='1';
  await button('Уход').click();
  await page.getByText('Не удалось обновить каталог, показаны прежние товары.',{exact:false}).waitFor();
  assert.equal((await names())[0],'Товар 3-0');
  assert.equal(await busy(),'false');
  productFail=()=>false;
  await page.locator('.catalog-status').getByRole('button',{name:'Попробовать снова'}).click();
  await shows('1');
  assert.equal(await page.getByText(/Не удалось обновить каталог/).count(),0);

  // 5. Opening the admin panel without saving and coming back does not reload references.
  const before={...requests};
  await button('Управление магазином').click();await button('← В каталог').click();await shows('1');
  await page.waitForTimeout(300);
  assert.equal(requests.brands,before.brands);assert.equal(requests.types,before.types);

  // 6. After a save in the admin panel the catalog loads references again.
  await button('Управление магазином').click();
  await page.getByLabel('Название',{exact:true}).fill('Новый бренд');
  await button('Сохранить').click();await page.getByText('Сохранено.',{exact:true}).waitFor();
  await button('← В каталог').click();await shows('1');
  await page.waitForTimeout(300);
  assert.equal(requests.brands,before.brands+1,'references reloaded after an admin save');

  // 7. References fail on a fresh start: products are shown, filters say they are unavailable; retry brings them.
  referenceFail=true;
  await page.goto(`${base}/?typeId=1`);await shows('1');
  await page.getByText('Фильтры временно недоступны.',{exact:false}).waitFor();
  assert.equal(await page.locator('.type-shortcuts').count(),0);
  assert.equal(await page.locator('select[aria-label="Тип косметики"] option:checked').textContent(),'Выбранный фильтр');
  referenceFail=false;
  await page.locator('.catalog-status').getByRole('button',{name:'Повторить'}).click();
  await button('Борода').waitFor();
  assert.equal(await page.getByText(/Фильтры временно недоступны/).count(),0);
  assert.equal(await page.locator('select[aria-label="Тип косметики"] option:checked').textContent(),'Уход');

  // 8. Products fail with nothing shown yet: the full error screen, as before.
  productFail=()=>true;
  await page.goto(base);
  await page.getByText('Не удалось загрузить каталог',{exact:true}).waitFor();
  productFail=()=>false;
  await page.locator('.empty-state').getByRole('button',{name:'Попробовать снова'}).click();
  await shows('all');
  assert.deepEqual(errors,[]);
  console.log('PASS: references once, previous list marked while loading, out-of-order answers, product failure keeps list, admin visit without/with save, reference failure keeps products, first-load failure.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
