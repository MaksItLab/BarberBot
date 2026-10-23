const assert = require('node:assert/strict');
const {launch} = require('./browser.cjs');
const base = process.env.SHOP_UI_URL || 'http://127.0.0.1:5173';
// U06: contrast measured on the rendered pixels, visible focus, target sizes, live regions present before
// their text, focus returning to what opened a screen, the keyboard path, and 200 % text at 320 px.

/** In the page: worst contrast of each text against the pixels behind it (text made transparent first). */
async function worstTextContrast(page) {
 const texts=await page.evaluate(()=>{
  document.activeElement?.blur(); // the focus ring is not what the text sits on
  const out=[];
  for(const element of document.querySelectorAll('body *')){
   const own=[...element.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent.trim()).join(' ');
   if(!own||element.closest('[aria-hidden="true"],[hidden],.sr-only'))continue;
   // The box of the text itself, not of its element: rounded corners and padding are not behind the letters.
   // Only the element's own text nodes: a label around an input must not count the input's border.
   const boxes=[...element.childNodes].filter(node=>node.nodeType===3&&node.textContent.trim()).map(node=>{
    const range=document.createRange();range.selectNode(node);return range.getBoundingClientRect();});
   const left=Math.min(...boxes.map(b=>b.left)),top=Math.min(...boxes.map(b=>b.top));
   const rect={x:left,y:top,top,left,width:Math.max(...boxes.map(b=>b.right))-left,height:Math.max(...boxes.map(b=>b.bottom))-top};
   rect.bottom=rect.top+rect.height;rect.right=rect.left+rect.width;
   const style=getComputedStyle(element);
   if(style.visibility==='hidden'||rect.width<1||rect.top<0||rect.bottom>innerHeight||rect.right>innerWidth)continue;
   const size=parseFloat(style.fontSize),bold=Number(style.fontWeight)>=700;
   out.push({text:own.slice(0,40),color:style.color,large:size>=24||(bold&&size>=18.66),x:rect.x,y:rect.y,w:rect.width,h:rect.height});
  }
  document.documentElement.classList.add('__hide-text');
  const hide=document.createElement('style');hide.id='__hide';hide.textContent='.__hide-text body *{color:transparent!important;caret-color:transparent!important}';
  document.head.append(hide);return out;});
 const shot=(await page.screenshot()).toString('base64');
 const result=await page.evaluate(async({shot,texts})=>{
  const image=new Image();image.src=`data:image/png;base64,${shot}`;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const context=canvas.getContext('2d');context.drawImage(image,0,0);
  const scale=image.width/innerWidth;
  const channel=value=>{value/=255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;};
  const luminance=([r,g,b])=>0.2126*channel(r)+0.7152*channel(g)+0.0722*channel(b);
  const ratio=(a,b)=>(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  return texts.map(text=>{
   const fg=luminance(text.color.match(/\d+(\.\d+)?/g).slice(0,3).map(Number));
   const data=context.getImageData(Math.floor(text.x*scale),Math.floor(text.y*scale),Math.max(1,Math.ceil(text.w*scale)),Math.max(1,Math.ceil(text.h*scale))).data;
   let worst=Infinity;for(let i=0;i<data.length;i+=12)worst=Math.min(worst,ratio(fg,luminance([data[i],data[i+1],data[i+2]])));
   return {...text,worst:Math.round(worst*100)/100};
  });
 },{shot,texts});
 await page.evaluate(()=>{document.documentElement.classList.remove('__hide-text');document.getElementById('__hide').remove();});
 return result.filter(text=>text.worst<(text.large?3:4.5));
}

(async () => {
 const browser=await launch();
 try {
  const errors=[];
  async function open(options){
   const page=await (await browser.newContext(options)).newPage();
   page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/**',route=>route.fulfill({contentType:'application/javascript',body:`
    const handlers=new Set();window.__back={handlers};
    window.Telegram={WebApp:{initData:"test-only",ready(){},expand(){},colorScheme:"light",onEvent(){},offEvent(){},
     BackButton:{show(){},hide(){},onClick(fn){handlers.add(fn)},offClick(fn){handlers.delete(fn)}}}};`}));
   await page.route('**/api/auth/telegram',route=>route.fulfill({json:{telegramId:'9000000001',role:'Admin'}}));
   const long='Шампунь укрепляющий для ежедневного применения с очень длинным названием';
   await page.route('**/api/catalog/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд с длинным названием'}]});
    if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'},{id:'2',name:'Борода'}]});
    const detail=/\/products\/(\d+)$/.exec(url.pathname)?.[1];
    if(detail)return route.fulfill({json:{id:detail,name:long,description:'Описание',brandName:'Бренд',brandDescription:null,typeName:'Уход',imagePath:null,
     variants:[{id:'1',volume:'50 мл',size:null,shade:null,priceRub:100},{id:'2',volume:'100 мл',size:null,shade:'02',priceRub:12345.5}]}});
    const number=Number(url.searchParams.get('page')??1);
    const items=Array.from({length:20},(_,i)=>({id:String((number-1)*20+i+1),name:i%2?long:'Крем',brandName:'Бренд',imagePath:null,priceRub:990,hasPriceRange:i%3===0}));
    return route.fulfill({json:{items,page:number,pageSize:20,hasMore:number<3}});
   });
   await page.route('**/api/admin/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/brands'))return route.fulfill({json:[{id:'1',name:'Бренд',description:null}]});
    if(url.pathname.endsWith('/types'))return route.fulfill({json:[{id:'1',name:'Уход'}]});
    if(route.request().method()==='GET')return route.fulfill({json:{items:[],page:1,pageSize:20,hasMore:false}});
    return route.fulfill({status:201,json:{id:'9',name:'Новый',description:null}});
   });
   return page;
  }
  let page=await open({viewport:{width:390,height:844}});
  const button=text=>page.getByRole('button',{name:text,exact:true});
  const active=()=>page.evaluate(()=>{const e=document.activeElement;return e?.dataset.productId?`card ${e.dataset.productId}`:e?.getAttribute('aria-label')||e?.textContent?.trim().slice(0,40)||e?.tagName;});

  /** Every element reached by Tab has a visible outline of at least 2 px and 3:1 against the pixels around it. */
  async function checkFocusRing(limit,label){
   await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
   const seen=[];
   for(let i=0;i<limit;i++){
    await page.keyboard.press('Tab');
    const ring=await page.evaluate(()=>{const e=document.activeElement;if(!e||e===document.body)return null;
     const s=getComputedStyle(e),r=e.getBoundingClientRect();
     return {name:(e.getAttribute('aria-label')||e.textContent||e.tagName).trim().slice(0,30),style:s.outlineStyle,width:parseFloat(s.outlineWidth),
      offset:parseFloat(s.outlineOffset)||0,color:s.outlineColor,x:r.x,y:r.y,w:r.width,h:r.height};});
    if(!ring)break;seen.push(ring.name);
    assert.notEqual(ring.style,'none',`${label}: no outline on "${ring.name}"`);
    assert.ok(ring.width>=2,`${label}: outline ${ring.width}px on "${ring.name}"`);
    const shot=(await page.screenshot()).toString('base64');
    const worst=await page.evaluate(async({shot,ring})=>{
     const image=new Image();image.src=`data:image/png;base64,${shot}`;await image.decode();
     const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
     const context=canvas.getContext('2d');context.drawImage(image,0,0);const scale=image.width/innerWidth;
     const channel=v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;};
     const lum=([r,g,b])=>0.2126*channel(r)+0.7152*channel(g)+0.0722*channel(b);
     const fg=lum(ring.color.match(/\d+/g).slice(0,3).map(Number));
     // At each side the ring must stand out from what is next to it on at least one side: inside or outside.
     const contrast=(x,y)=>{const [r,g,b]=context.getImageData(Math.floor(x*scale),Math.floor(y*scale),1,1).data;
      const l=lum([r,g,b]);return (Math.max(l,fg)+0.05)/(Math.min(l,fg)+0.05);};
     const inner=ring.offset/2,outer=ring.offset+ring.width+2;
     const sides=[[ring.x+ring.w/2,ring.y,0,-1],[ring.x+ring.w/2,ring.y+ring.h,0,1],[ring.x,ring.y+ring.h/2,-1,0],[ring.x+ring.w,ring.y+ring.h/2,1,0]];
     let worst=Infinity;
     for(const [x,y,dx,dy] of sides){
      const [ox,oy]=[x+dx*outer,y+dy*outer];if(ox<0||oy<0||ox>=innerWidth||oy>=innerHeight)continue;
      worst=Math.min(worst,Math.max(contrast(x+dx*inner,y+dy*inner),contrast(ox,oy)));
     }
     return worst;},{shot,ring});
    assert.ok(worst>=3,`${label}: focus ring contrast ${worst.toFixed(2)} on "${ring.name}"`);
   }
   return seen;
  }
  /** No target under 24 px; outside running text, none under 44 px high. */
  async function checkTargets(label){
   const small=await page.evaluate(()=>[...document.querySelectorAll('button,a[href],select,input,textarea,summary,label.variant,label.checkbox-label')]
    .filter(e=>e.offsetParent!==null&&!(e.matches('input[type=radio],input[type=checkbox]')&&e.closest('label')))
    .map(e=>{const r=e.getBoundingClientRect();return {name:(e.getAttribute('aria-label')||e.textContent||e.tagName).trim().slice(0,30),w:r.width,h:r.height,inline:Boolean(e.closest('p'))};})
    .filter(t=>t.w<24||t.h<24||(!t.inline&&t.h<44)));
   assert.deepEqual(small,[],`${label}: small targets`);
  }
  const noOverflow=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label}: horizontal scroll`);

  // 1. Catalog: contrast, focus ring, targets; the live region is there before any text.
  await page.goto(base);await page.locator('.product-card').first().waitFor();
  {const low=await worstTextContrast(page);assert.deepEqual(low,[],`catalog contrast ${JSON.stringify(low)}`);}
  const order=await checkFocusRing(14,'catalog');
  assert.ok(order.indexOf('Бренд')<order.indexOf('Тип косметики')&&order.includes('Всё'),`tab order ${order}`);
  await checkTargets('catalog');
  assert.equal(await page.locator('.catalog-status[role="status"]').count(),1);
  assert.equal(await page.locator('.catalog-status').textContent(),'');

  // 2. "Показать ещё" announces how many products are shown, with the Russian plural.
  await button('Показать ещё').click();await page.waitForFunction(()=>document.querySelectorAll('.product-card').length===40);
  assert.equal(await page.locator('.catalog-status').textContent(),'Показано 40 товаров.');
  await button('Показать ещё').click();await page.waitForFunction(()=>document.querySelectorAll('.product-card').length===60);
  assert.equal(await page.locator('.catalog-status').textContent(),'Показано 60 товаров.');

  // 3. Keyboard: a card opens with Enter, the product heading takes the focus, a variant is chosen with arrows,
  // and back on the catalog the focus returns to that card.
  await page.locator('[data-product-id="21"]').focus();await page.keyboard.press('Enter');
  await page.locator('.detail h1').waitFor();
  await page.waitForFunction(()=>document.activeElement?.matches('.detail h1'));
  {const low=await worstTextContrast(page);assert.deepEqual(low,[],`product contrast ${JSON.stringify(low)}`);}
  await checkTargets('product');
  await page.getByRole('radio',{name:/50 мл/}).focus();await page.keyboard.press('ArrowDown');
  assert.match(await page.locator('.detail-price').innerText(),/12\s?345,5/);
  await checkFocusRing(6,'product');
  await page.evaluate(()=>[...window.__back.handlers][0]());
  await page.locator('.product-card').first().waitFor();
  assert.equal(await active(),'card 21','focus back on the opened card');

  // 4. The admin screen focuses its heading; the save result goes into a region that existed before;
  // coming back, focus returns to "Управление магазином".
  await page.evaluate(()=>window.scrollTo(0,0));
  await button('Управление магазином').click();
  assert.equal(await active(),'Управление магазином');
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');
  const status=page.locator('.form-status[role="status"]');
  await status.waitFor({state:'attached'});assert.equal(await status.textContent(),'');
  await page.getByLabel('Название',{exact:true}).fill('Новый');await button('Сохранить').click();
  await page.getByText('Сохранено.',{exact:true}).waitFor();assert.equal(await status.textContent(),'Сохранено.');
  await button('Товары').click();await button('Добавить товар').click();
  {const low=await worstTextContrast(page);assert.deepEqual(low,[],`admin form contrast ${JSON.stringify(low)}`);}
  await checkTargets('admin form');
  await checkFocusRing(12,'admin form');
  await button('← В каталог').click();await page.locator('.product-card').first().waitFor();
  assert.equal(await active(),'Управление магазином','focus back on the admin entry');

  // 5. A phone at 320 px with 200 % text: no horizontal scroll on the catalog, the product and the form.
  page=await open({viewport:{width:320,height:640},isMobile:true,hasTouch:true});
  await page.goto(base);await page.locator('.product-card').first().waitFor();
  const size=()=>page.locator('.product-card h2').first().evaluate(element=>parseFloat(getComputedStyle(element).fontSize));
  const normal=await size();
  await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
   const style=document.createElement('style');style.textContent='html{-webkit-text-size-adjust:200%;text-size-adjust:200%}';document.head.append(style);}));
  await page.reload();await page.locator('.product-card').first().waitFor();
  assert.equal(await size(),normal*2,'text really doubled');
  await noOverflow('catalog 320 px');
  await page.locator('[data-product-id="2"]').click();await page.locator('.detail h1').waitFor();await noOverflow('product 320 px');
  await page.goBack();await button('Управление магазином').click();await button('Товары').click();await button('Добавить товар').click();
  await noOverflow('admin form 320 px');
  assert.deepEqual(errors,[]);
  console.log('PASS: pixel contrast on catalog/product/form, focus ring 2px and 3:1, tab order, targets 24/44 px, live regions present before text, plural count, focus to heading and back to the opener, keyboard variant choice, 320 px without overflow.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
