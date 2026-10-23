const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// R07: a version conflict shows what the other admin changed and never overwrites anything silently.
(async () => {
 const browser=await launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:
   'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  await page.route('**/api/auth/telegram',route=>route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
  const variant=(id,volume,price)=>({id,volume,size:null,shade:null,priceRub:price,isVisible:true});
  const opened={id:'7',name:'Крем',description:'Описание',brandId:'1',typeId:'1',imagePath:null,isVisible:true,version:'v1',variants:[variant('1','50 мл',100)]};
  // Meanwhile another admin renamed it, changed the price of variant 1 and added variant 2.
  let server={...opened,name:'Крем коллеги',version:'v2',variants:[variant('1','50 мл',120),variant('2','100 мл',200)]};
  const puts=[];
  await page.route('**/api/admin/**',route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
   if(url.pathname==='/api/admin/products')return route.fulfill({json:{items:[{id:'7',name:'Крем',brandName:'Бренд',isVisible:true}],page:1,pageSize:20,hasMore:false}});
   if(request.method()==='GET')return route.fulfill({json:puts.length?server:opened});
   const body=request.postDataJSON();puts.push(body);
   if(body.version!==server.version)return route.fulfill({status:409,json:{code:'conflict',title:'Товар уже изменён другим администратором.',current:server}});
   server={...server,...body,id:'7',version:'v3',variants:body.variants.map((value,index)=>({...value,id:value.id??String(index+1)}))};
   return route.fulfill({json:server});
  });
  await page.goto(base);
  await page.getByRole('button',{name:'Управление магазином',exact:true}).click();
  await page.getByRole('button',{name:'Товары',exact:true}).click();
  await page.getByRole('button',{name:'Изменить Крем',exact:true}).click();
  await page.getByLabel('Описание товара',{exact:true}).fill('Моё описание');
  await page.getByLabel('Цена варианта 1',{exact:true}).fill('150');
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();

  await page.getByText('Товар уже изменил другой администратор: название, варианты. Ваши изменения в форме сохранены.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Описание товара',{exact:true}).inputValue(),'Моё описание');
  assert.equal(puts.length,1);

  await page.getByRole('button',{name:'Перенести мои изменения на новую версию',exact:true}).click();
  await page.getByText('Изменения коллеги подставлены в поля, которые вы не меняли. Ваши правки заменят его значения: вариант 1. Проверьте форму и нажмите «Сохранить товар».',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Название товара',{exact:true}).inputValue(),'Крем коллеги');
  assert.equal(await page.getByLabel('Описание товара',{exact:true}).inputValue(),'Моё описание');
  assert.equal(await page.getByLabel('Цена варианта 1',{exact:true}).inputValue(),'150');
  assert.equal(await page.getByLabel('Объём варианта 2',{exact:true}).inputValue(),'100 мл');
  assert.equal(puts.length,1,'applying is not a save');

  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await page.getByText('Товар сохранён.',{exact:true}).waitFor();
  const saved=puts.at(-1);
  assert.equal(saved.version,'v2');assert.equal(saved.name,'Крем коллеги');assert.equal(saved.description,'Моё описание');
  assert.deepEqual(saved.variants.map(value=>[value.id,value.priceRub]),[['1',150],['2',200]]);

  // Second conflict: the admin chooses the other version and drops their own input explicitly.
  server={...server,description:'Ещё одна правка',version:'v4'};
  await page.getByLabel('Название товара',{exact:true}).fill('Моё название');
  await page.getByRole('button',{name:'Сохранить товар',exact:true}).click();
  await page.getByText(/^Товар уже изменил другой администратор: описание\./).waitFor();
  await page.getByRole('button',{name:'Открыть новую версию без моих изменений',exact:true}).click();
  await page.getByText('Редактирование товара',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Название товара',{exact:true}).inputValue(),'Крем коллеги');
  assert.equal(await page.getByLabel('Описание товара',{exact:true}).inputValue(),'Ещё одна правка');
  assert.deepEqual(errors,[]);
  console.log('PASS: conflict shows changed fields, keeps input, three-way merge on explicit choice, explicit discard.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
