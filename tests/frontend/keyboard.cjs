const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// U04 (laboratory part): when the visible area shrinks as the keyboard opens, the field being edited is
// brought back above it; a visible field or a focused button does not move the page. Real keyboards and
// Telegram versions are checked on devices (docs/device-protocol.md), not here.
(async () => {
 const browser=await launch();
 try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:
   'window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/auth/telegram',route=>route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
  await page.route('**/api/catalog/**',route=>route.fulfill({json:route.request().url().includes('/products')?{items:[],page:1,pageSize:20,hasMore:false}:[]}));
  await page.route('**/api/admin/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
   if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
   return route.fulfill({json:{items:[],page:1,pageSize:20,hasMore:false}});
  });
  const button=text=>page.getByRole('button',{name:text,exact:true});
  await page.goto(base);
  await button('Управление магазином').click();await button('Товары').click();await button('Добавить товар').click();
  const field=page.getByLabel('Цена варианта 1',{exact:true});
  const visible=()=>field.evaluate(element=>{const box=element.getBoundingClientRect(),view=window.visualViewport;
   return box.top>=view.offsetTop&&box.bottom<=view.offsetTop+view.height;});
  const keyboard=async open=>{await page.setViewportSize({width:390,height:open?420:844});await page.waitForTimeout(250);};
  /** Puts the field near the bottom of the full screen, as a tap there would leave it, and focuses it. */
  const focusLow=async()=>{
   await field.evaluate(element=>{window.scrollBy(0,element.getBoundingClientRect().bottom-(innerHeight-40));element.focus({preventScroll:true});});
  };

  // 1. The keyboard opens over a field low on the screen: the field is brought above it.
  await focusLow();
  assert.equal(await visible(),true);
  await keyboard(true);
  assert.equal(await visible(),true,'field visible above the keyboard');

  // 2. The keyboard closes: nothing jumps.
  let before=await page.evaluate(()=>scrollY);
  await keyboard(false);
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-before)<=1,'no jump when the keyboard closes');

  // 3. A field already visible above the keyboard does not move the page.
  await field.evaluate(element=>{window.scrollBy(0,element.getBoundingClientRect().top-100);element.focus({preventScroll:true});});
  before=await page.evaluate(()=>scrollY);
  await keyboard(true);
  assert.equal(await page.evaluate(()=>scrollY),before,'visible field: no scroll');
  await keyboard(false);

  // 4. A focused button is not an input: the page stays where it is.
  await focusLow();
  await button('Сохранить товар').evaluate(element=>element.focus({preventScroll:true}));
  before=await page.evaluate(()=>scrollY);
  await keyboard(true);
  assert.equal(await page.evaluate(()=>scrollY),before,'button focused: no scroll');
  await keyboard(false);

  // 5. A tall field (description) keeps its top visible rather than its bottom.
  const description=page.getByLabel('Описание товара',{exact:true});
  await description.fill('строка\n'.repeat(30));
  await description.evaluate(element=>{element.style.height='600px';}); // stretched by the user (resize: vertical)
  assert.ok(await description.evaluate(element=>element.getBoundingClientRect().height)>420,'the field is taller than the visible area');
  await description.evaluate(element=>{window.scrollBy(0,element.getBoundingClientRect().top-(innerHeight-60));element.focus({preventScroll:true});});
  await keyboard(true);
  const top=await description.evaluate(element=>element.getBoundingClientRect().top-window.visualViewport.offsetTop);
  assert.ok(top>=0&&top<420,`top of a tall field visible: ${top}`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: field brought above the keyboard, no jump on close, visible field and focused button untouched, tall field keeps its top.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
