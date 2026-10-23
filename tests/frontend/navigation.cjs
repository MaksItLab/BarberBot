const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// U07: "Back" is one level up everywhere; the catalog keeps its filter, pages and scroll on return,
// rebuilds them after a reload, and navigation during loading or repeated taps never breaks history.
(async () => {
 const browser=await launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:`
   const handlers=new Set();
   window.__back={visible:false,handlers};
   window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){},
    BackButton:{show(){__back.visible=true},hide(){__back.visible=false},onClick(fn){handlers.add(fn)},offClick(fn){handlers.delete(fn)}}}};`}));
  await page.route('**/api/auth/telegram',route=>route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
  let detailDelay=0,hidden=new Set(),failPage=0,pageRequests=[];
  await page.route('**/api/catalog/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд'}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'},{id:'2',name:'Борода'}]});
   const detail=/\/products\/(\d+)$/.exec(url.pathname)?.[1];
   if(detail){
    if(detailDelay)await new Promise(resolve=>setTimeout(resolve,detailDelay));
    if(hidden.has(detail))return route.fulfill({status:404,contentType:'application/problem+json',json:{status:404,code:'not_found',title:'x'}}).catch(()=>{});
    return route.fulfill({json:{id:detail,name:`Товар ${detail}`,description:'Описание',brandName:'Бренд',brandDescription:null,typeName:'Уход',imagePath:null,
     variants:[{id:'1',volume:'50 мл',size:null,shade:null,priceRub:100}]}}).catch(()=>{});
   }
   const number=Number(url.searchParams.get('page')??1);pageRequests.push(number);
   if(number===failPage)return route.fulfill({status:400,contentType:'application/problem+json',json:{status:400,code:'request_failed',title:'x'}});
   const type=url.searchParams.get('typeId')??'0';
   const items=Array.from({length:20},(_,i)=>{const id=String((number-1)*20+i+1);return {id:type+id.padStart(3,'0'),name:`Товар ${type}${id.padStart(3,'0')}`,brandName:'Бренд',imagePath:null,priceRub:100,hasPriceRange:false};});
   return route.fulfill({json:{items,page:number,pageSize:20,hasMore:number<4}});
  });
  await page.route('**/api/admin/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
   if(route.request().method()==='GET')return route.fulfill({json:{items:[],page:1,pageSize:20,hasMore:false}});
   return route.fulfill({status:201,json:{id:'9',name:route.request().postDataJSON().name,description:null}});
  });
  const button=text=>page.getByRole('button',{name:text,exact:true});
  const cards=()=>page.locator('.product-card').count();
  const scrollY=()=>page.evaluate(()=>Math.round(window.scrollY));
  const historyLength=()=>page.evaluate(()=>history.length);
  const back=page=>page.evaluate(()=>{assert(window.__back.handlers.size===1,'one Telegram back handler');[...window.__back.handlers][0]();function assert(ok,m){if(!ok)throw new Error(m);}});
  const more=async()=>{const total=await cards()+20;await button('Показать ещё').click();await page.waitForFunction(total=>document.querySelectorAll('.product-card').length===total,total);};
  /** Scrolls to a card and opens it without the click itself moving the page. */
  const openAt=async name=>{
   await page.getByRole('heading',{name,exact:true}).evaluate(element=>window.scrollTo(0,element.getBoundingClientRect().top+scrollY-300));
   const at=await scrollY();
   await page.getByRole('heading',{name,exact:true}).evaluate(element=>element.closest('a').click());
   await page.locator('.detail h1').waitFor();return at;
  };
  const atCatalog=async()=>{await page.getByRole('heading',{name:'Каталог',exact:true}).waitFor();await page.waitForTimeout(150);};

  await page.goto(`${base}/?typeId=1`);await page.getByRole('heading',{name:'Товар 1001',exact:true}).waitFor();
  const start=await historyLength();

  // 1. Filters replace the address: no history entries, the Telegram button stays hidden in the catalog.
  await button('Борода').click();await page.getByRole('heading',{name:'Товар 2001',exact:true}).waitFor();
  await button('Уход').click();await page.getByRole('heading',{name:'Товар 1001',exact:true}).waitFor();
  assert.equal(await historyLength(),start,'filters add no history entries');
  assert.match(page.url(),/\?typeId=1$/);
  assert.equal(await page.evaluate(()=>window.__back.visible),false);

  // 2. Product → Telegram "Back", browser "Back" and "← В каталог": filter, 60 cards and scroll are kept.
  await more();await more();
  for(const leave of ['telegram','browser','button']){
   const at=await openAt('Товар 1045');
   assert.equal(await page.evaluate(()=>window.__back.visible),true);
   assert.equal(await historyLength(),start+1);
   if(leave==='telegram')await back(page);else if(leave==='browser')await page.goBack();else await button('← В каталог').click();
   await atCatalog();
   assert.equal(await cards(),60,`${leave}: pages kept`);
   assert.ok(Math.abs(await scrollY()-at)<=2,`${leave}: scroll ${await scrollY()} vs ${at}`);
   assert.match(page.url(),/\?typeId=1$/);
   assert.equal(await page.evaluate(()=>window.__back.visible),false);
  }

  // 3. The admin panel without saving: the same list and position on return.
  await page.evaluate(()=>window.scrollTo(0,1500));const adminAt=await scrollY();
  await button('Управление магазином').evaluate(element=>element.click()); // without scrolling to the button
  await button('← В каталог').click();await atCatalog();
  assert.equal(await cards(),60);assert.ok(Math.abs(await scrollY()-adminAt)<=2,`scroll kept after the admin panel: ${await scrollY()} vs ${adminAt}, state ${JSON.stringify(await page.evaluate(()=>history.state))}`);

  // 4. After a save in the admin panel: a fresh list from the top.
  await page.evaluate(()=>window.scrollTo(0,1500));
  await button('Управление магазином').click();
  await page.getByLabel('Название',{exact:true}).fill('Новый бренд');await button('Сохранить').click();
  await page.getByText('Сохранено.',{exact:true}).waitFor();
  await back(page);await atCatalog();
  assert.equal(await cards(),20,'fresh list after a save');assert.equal(await scrollY(),0);

  // 5. Reload on a product, then back: the pages are loaded again and the scroll restored.
  await more();await more();
  const reloadAt=await openAt('Товар 1050');
  await page.reload();await page.locator('.detail h1').waitFor();
  pageRequests=[];
  await button('← В каталог').click();await page.waitForFunction(()=>document.querySelectorAll('.product-card').length===60);
  await page.waitForTimeout(200);
  assert.deepEqual(pageRequests,[1,2,3],'pages requested in order');
  assert.ok(Math.abs(await scrollY()-reloadAt)<=2,`scroll after reload ${await scrollY()} vs ${reloadAt}`);

  // 6. Reload on the catalog itself; a failure on page 3 keeps pages 1–2 and offers more.
  failPage=3;await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('.product-card').length===40);
  await button('Показать ещё').waitFor();failPage=0;
  await more();assert.equal(await cards(),60);

  // 7. A double tap on a card adds one entry; one "Back" returns to the catalog.
  await page.goto(`${base}/`);await button('Уход').click(); // a new entry, so none is left ahead
  await page.getByRole('heading',{name:'Товар 1003',exact:true}).waitFor();
  const before=await historyLength();
  await page.getByRole('heading',{name:'Товар 1003',exact:true}).evaluate(element=>{const link=element.closest('a');link.click();link.click();});
  await page.locator('.detail h1').waitFor();
  assert.equal(await historyLength(),before+1,`one entry for a double tap: ${await historyLength()} vs ${before}`);
  await back(page);await atCatalog();

  // 8. "Back" while the product is still loading: the late answer does not change the screen.
  detailDelay=900;
  await page.getByRole('heading',{name:'Товар 1004',exact:true}).evaluate(element=>element.closest('a').click());
  await page.getByText('Открываем товар…',{exact:true}).waitFor();
  await back(page);await atCatalog();await page.waitForTimeout(1100);
  assert.equal(await page.locator('.detail').count(),0);assert.match(page.url(),/\?typeId=1$/);
  detailDelay=0;

  // 9. A product hidden while open: reopening shows "Товар недоступен" with a way back.
  await page.getByRole('heading',{name:'Товар 1005',exact:true}).evaluate(element=>element.closest('a').click());
  await page.locator('.detail h1').waitFor();
  hidden.add('1005');await page.reload();
  await page.getByRole('heading',{name:'Товар недоступен',exact:true}).waitFor();
  await button('← В каталог').click();await atCatalog();
  assert.equal(await page.evaluate(()=>window.__back.handlers.size),0,'no Telegram handler left in the catalog');
  assert.deepEqual(errors,[]);
  console.log('PASS: filters without history entries, return via Telegram/browser/button keeps filter+pages+scroll, admin without/with save, reload on product and catalog restores pages, partial restore, double tap, back during loading, hidden product, one back handler.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
