const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
const transportProblem = {code:'secure_transport_unavailable',title:'Не удалось подтвердить защищённое соединение. Повторите попытку.'};
(async () => {
 const browser=await launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:
   'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  let loginCalls=0,loginMode='eventual';
  await page.route('**/api/auth/telegram',route=>{
   loginCalls++;
   return route.fulfill(loginMode==='transport-always'||loginCalls<=2?{status:503,json:transportProblem}:{json:{telegramId:'9000000001',role:'Admin'}});
  });
  const getCalls={brands:0,types:0};
  let postMode='transport-then-ok',postCalls=0,writes=0;
  let accessDenied=false;
  await page.route('**/api/admin/**',route=>{
   const request=route.request();
   assert.equal(request.headers().authorization,'tma test-only');
   if(accessDenied)return route.fulfill({status:403,json:{title:'Недостаточно прав.'}});
   const kind=request.url().endsWith('/brands')?'brands':'types';
   if(request.method()==='GET'){
    getCalls[kind]++;
    return route.fulfill(getCalls[kind]===1?{status:503,json:transportProblem}:{json:[]});
   }
   postCalls++;
   assert.equal(request.postDataJSON().name,'Тестовый бренд');
   if(postMode==='transport-then-ok'){
    if(postCalls<=2)return route.fulfill({status:503,json:transportProblem});
    writes++;
    return route.fulfill({status:201,json:{id:'1',name:'Тестовый бренд',description:null}});
   }
   if(postMode==='transport-always')return route.fulfill({status:503,json:transportProblem});
   if(postMode==='unknown-503')return route.fulfill({status:503,json:null});
   if(postMode==='network')return route.abort();
   return route.fulfill({status:500,json:{title:'Неизвестный результат записи'}});
  });
  await page.goto(base);
  await page.getByRole('button',{name:'Управление магазином',exact:true}).click();
  await page.getByText('Записей пока нет.',{exact:true}).waitFor();
  assert.ok(loginCalls>=3);
  assert.ok(getCalls.brands>=2&&getCalls.types>=2);
  await page.getByText('Администратор',{exact:true}).waitFor();
  await page.getByLabel('Название',{exact:true}).fill('Тестовый бренд');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.getByText('Сохранено.',{exact:true}).waitFor();
  assert.equal(postCalls,3);assert.equal(writes,1);

  postMode='transport-always';postCalls=0;
  await page.getByLabel('Название',{exact:true}).fill('Тестовый бренд');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.getByText(transportProblem.title,{exact:true}).waitFor();
  assert.equal(postCalls,4);assert.equal(writes,1);
  assert.equal(await page.getByLabel('Название',{exact:true}).inputValue(),'Тестовый бренд');
  await page.getByText('Администратор',{exact:true}).waitFor();
  assert.equal(await page.getByText('Управление доступно администратору при входе через Telegram.').count(),0);

  for(const mode of ['unknown-503','unknown-500','network']){
   postMode=mode;postCalls=0;
   await page.getByRole('button',{name:'Сохранить',exact:true}).click();
   // Each unknown outcome tells the admin to check before repeating; none is retried automatically.
   await page.getByText(mode==='network'?'Связь прервалась до ответа сервера. Изменения могли сохраниться: обновите список и проверьте, прежде чем повторять.'
    :mode==='unknown-503'?'Сервер не подтвердил сохранение. Обновите список и проверьте изменения, прежде чем повторять.'
    :'Неизвестный результат записи',{exact:true}).waitFor();
   await page.waitForTimeout(350);
   assert.equal(postCalls,1);assert.equal(writes,1);
   assert.equal(await page.getByLabel('Название',{exact:true}).inputValue(),'Тестовый бренд');
  }
  loginMode='transport-always';
  await page.evaluate(()=>window.dispatchEvent(new Event('load')));
  // The notice now names the failure class instead of a generic connection message.
  await page.getByText('Не удалось подтвердить защищённое соединение. Повторите попытку.',{exact:true}).waitFor();
  await page.getByText('Администратор',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Название',{exact:true}).inputValue(),'Тестовый бренд');
  accessDenied=true;
  await page.getByRole('button',{name:'Типы косметики',exact:true}).click();
  // Trigger a fresh protected read through the panel's remount.
  await page.getByRole('button',{name:'Товары',exact:true}).click();
  await page.getByText('У вашего аккаунта нет прав для управления магазином.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Администратор',{exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: transport retries, retained admin access/form, bounded attempts, single write, no retry for unknown write outcome, real forbidden state.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
