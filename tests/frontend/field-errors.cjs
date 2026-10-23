const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// U03: errors are shown at their fields, the first one takes the focus, and the input is never cleared.
(async () => {
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:
   'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  await page.route('**/api/auth/telegram',route=>route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
  const requestId='4bf92f3577b34da6a3ce929d0e0e4736';
  let answer=null;const saves=[];
  await page.route('**/api/admin/**',route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
   if(request.method()==='GET')return route.fulfill({json:{items:[],page:1,pageSize:20,hasMore:false}});
   saves.push(request.postDataJSON());
   return route.fulfill(answer);
  });
  const label=text=>page.getByLabel(text,{exact:true});
  const button=text=>page.getByRole('button',{name:text,exact:true});
  const focused=()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label')??document.activeElement?.textContent);
  /** The message the field points to with aria-describedby, or null when the field is not marked. */
  const fieldError=locator=>locator.evaluate(element=>element.getAttribute('aria-invalid')==='true'
   ?document.getElementById(element.getAttribute('aria-describedby'))?.textContent??'missing':null);
  await page.goto(base);
  await button('Управление магазином').click();await button('Товары').click();
  await button('Добавить товар').click();

  // 1. Simple rules are checked before sending: every invalid field is marked, the first gets the focus.
  await button('Добавить вариант').click();
  await label('Цена варианта 1').fill('100');
  await label('Цена варианта 2').fill('1,234');
  await button('Сохранить товар').click();
  await page.getByText('Исправьте отмеченные поля.',{exact:true}).waitFor();
  assert.equal(saves.length,0,'nothing is sent');
  assert.equal(await fieldError(label('Название товара')),'Заполните поле «Название товара».');
  assert.equal(await fieldError(label('Описание товара')),'Заполните поле «Описание товара».');
  assert.equal(await fieldError(label('Цена варианта 1')),null);
  assert.equal(await fieldError(label('Цена варианта 2')),'Укажите цену в рублях, не более двух знаков после запятой.');
  assert.equal(await focused(),'Название товара');
  // Correcting a field removes only its own message.
  await label('Название товара').fill('Крем');
  assert.equal(await fieldError(label('Название товара')),null);
  assert.equal(await fieldError(label('Описание товара')),'Заполните поле «Описание товара».');
  await label('Описание товара').fill('Описание');
  await label('Цена варианта 2').fill('200');
  await label('Оттенок варианта 2',{exact:true}).fill('Очень длинный оттенок');

  // 2. The server names the rejected field by its path: it is marked and focused, the form keeps every value.
  const title='Поле «Оттенок» — не более 120 символов.';
  answer={status:400,contentType:'application/problem+json',json:{status:400,title,code:'validation_failed',requestId,errors:{'variants[1].shade':[title]}}};
  await button('Сохранить товар').click();
  await page.getByText(`${title} Код обращения: 4bf92f35.`,{exact:true}).waitFor();
  assert.equal(saves.length,1);
  assert.equal(await fieldError(label('Оттенок варианта 2')),title);
  assert.equal(await focused(),'Оттенок варианта 2');
  assert.equal(await label('Название товара').inputValue(),'Крем');
  assert.equal(await label('Цена варианта 2').inputValue(),'200');

  // 3. A rejected variant as a whole: the message on that variant takes the focus.
  answer={status:400,contentType:'application/problem+json',json:{status:400,title:'Выберите корректное значение: Вариант.',code:'validation_failed',requestId,errors:{'variants[0].id':['Выберите корректное значение: Вариант.']}}};
  await button('Сохранить товар').click();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('field-error'));
  assert.equal(await focused(),'Выберите корректное значение: Вариант.');
  assert.equal(await fieldError(label('Оттенок варианта 2')),null,'old server messages are replaced');

  // 4. Malformed paths are ignored; a failure without fields shows only the general message.
  answer={status:400,contentType:'application/problem+json',json:{status:400,title:'Бренд или тип больше не существует. Обновите справочники.',code:'validation_failed',requestId,errors:{'<img src=x>':['x'],'name':[42]}}};
  await button('Сохранить товар').click();
  await page.getByText('Бренд или тип больше не существует. Обновите справочники. Код обращения: 4bf92f35.',{exact:true}).waitFor();
  assert.equal(await page.locator('[aria-invalid="true"]').count(),0);
  assert.equal(await page.locator('.field-error').count(),0);

  // 5. Removing a new variant drops messages tied to positions, so none points at the wrong row.
  // With a third row, a stale "variants[1]" message would land on the former third variant.
  await button('Добавить вариант').click();
  await label('Цена варианта 3').fill('300');
  answer={status:400,contentType:'application/problem+json',json:{status:400,title,code:'validation_failed',requestId,errors:{'variants[1].shade':[title]}}};
  await button('Сохранить товар').click();
  await page.getByText(`${title} Код обращения: 4bf92f35.`,{exact:true}).waitFor();
  await button('Убрать новый вариант 1').click();
  assert.equal(await page.locator('.field-error').count(),0);
  assert.equal(await label('Оттенок варианта 1').inputValue(),'Очень длинный оттенок');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: client checks before sending, field marks with descriptions, focus on first error, server field paths incl. whole variant, malformed paths ignored, input kept.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
