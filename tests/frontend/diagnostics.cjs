const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
const requestId = '4bf92f3577b34da6a3ce929d0e0e4736';
(async () => {
 const browser=await launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:
   'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  let loginMode='database';
  await page.route('**/api/auth/telegram',route=>loginMode==='network'?route.abort():loginMode==='database'
   ?route.fulfill({status:503,headers:{'X-Request-Id':requestId},json:{code:'database_unavailable',requestId,
     title:'База данных временно недоступна. Повторите попытку позже.'}})
   :route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
  let postMode='conflict';
  await page.route('**/api/admin/**',route=>{
   const request=route.request();
   if(request.method()==='GET')return route.fulfill({json:[]});
   // An HTML error page from a proxy still carries the header with the request id.
   if(postMode==='proxy-html')return route.fulfill({status:502,headers:{'X-Request-Id':requestId},contentType:'text/html',body:'<html>Bad gateway</html>'});
   return route.fulfill({status:409,json:{code:'conflict',requestId,title:'Бренд с таким названием уже существует.'}});
  });

  await page.goto(base);
  // A database outage during login is reported as such, with a reference for the server log.
  await page.getByText('База данных временно недоступна. Повторите попытку позже. Код обращения: 4bf92f35.',{exact:true}).waitFor();
  // A dropped login is a plain connection problem: login is safe to repeat, nothing to check.
  loginMode='network';
  await page.getByRole('button',{name:'Повторить вход',exact:true}).click();
  await page.getByText('Нет связи с сервером. Проверьте интернет и повторите.',{exact:true}).waitFor();
  loginMode='ok';
  await page.getByRole('button',{name:'Повторить вход',exact:true}).click();
  await page.getByRole('button',{name:'Управление магазином',exact:true}).click();
  await page.getByText('Записей пока нет.',{exact:true}).waitFor();

  await page.getByLabel('Название',{exact:true}).fill('Дубль');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.getByText('Бренд с таким названием уже существует. Код обращения: 4bf92f35.',{exact:true}).waitFor();

  postMode='proxy-html';
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.getByText('Сервер не подтвердил сохранение. Обновите список и проверьте изменения, прежде чем повторять. Код обращения: 4bf92f35.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Название',{exact:true}).inputValue(),'Дубль');
  assert.deepEqual(errors,[]);
  console.log('PASS: database outage and dropped connection at login, request reference in messages, proxy HTML error with header, form retained.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
