import { useEffect, useLayoutEffect, useState } from 'react';
import { connectTelegram, connectBackButton, hasTelegramLaunch } from './telegram';
import { Catalog } from './Catalog';
import { ProductDetail } from './ProductDetail';
import { useTelegramUser } from './auth';
import { describeError } from './api';
import { AdminPanel } from './AdminPanel';

const readLocation = () => ({ path: window.location.pathname, search: window.location.search });

export function App() {
  const auth = useTelegramUser();
  const [location, setLocation] = useState(readLocation);
  const productId = /^\/products\/([^/]+)$/.exec(location.path)?.[1];
  const isAdmin = location.path === '/admin';
  const [catalogVisited, setCatalogVisited] = useState(!productId);
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
    let disconnect = connectTelegram();
    const initialize = () => { disconnect(); disconnect = connectTelegram(); };
    const pop = () => setLocation(readLocation());
    window.addEventListener('load', initialize);
    window.addEventListener('popstate', pop);
    return () => { disconnect(); window.removeEventListener('load', initialize); window.removeEventListener('popstate', pop); };
  }, []);
  useLayoutEffect(() => {
    if (!productId) setCatalogVisited(true);
    window.scrollTo(0, productId || isAdmin ? 0 : window.history.state?.catalogScroll ?? 0);
  }, [productId, isAdmin]);

  function back() {
    if (window.history.state?.shopProduct || window.history.state?.shopAdmin) window.history.back();
    else {
      window.history.replaceState(null, '', `/${location.search}`);
      setLocation(readLocation());
    }
  }
  useEffect(() => {
    let disconnect = connectBackButton(Boolean(productId) || isAdmin, back);
    const initialize = () => { disconnect(); disconnect = connectBackButton(Boolean(productId) || isAdmin, back); };
    window.addEventListener('load', initialize);
    return () => { disconnect(); window.removeEventListener('load', initialize); };
  }, [productId, isAdmin, location.search]);

  function filter(value: string) {
    if (location.path === '/' && new URLSearchParams(location.search).toString() === value) return;
    window.history.pushState(null, '', value ? `/?${value}` : '/');
    setLocation(readLocation());
  }
  function openProduct(id: string) {
    window.history.replaceState({ ...window.history.state, catalogScroll: window.scrollY }, '', window.location.href);
    window.history.pushState({ shopProduct: true }, '', `/products/${encodeURIComponent(id)}${location.search}`);
    setLocation(readLocation());
  }
  return <main className="store">
    <header className="store-header"><a className="store-identity" href="/" onClick={event => {
      if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); filter(''); window.scrollTo(0, 0);
      }
    }} aria-label="Магазин косметики — в каталог"><span className="brand-mark" aria-hidden="true">C<span>•</span></span>
      <span className="brand-title">КОСМЕТИКА</span></a></header>
    {auth.user?.role === 'Admin' && <p className="eyebrow">Администратор</p>}
    {auth.user?.role === 'Admin' && !isAdmin && <button className="text-button" onClick={() => {
      window.history.pushState({ shopAdmin: true }, '', '/admin'); setLocation(readLocation());
    }}>Управление магазином</button>}
    {auth.status === 'loading' && <p role="status">Проверяем вход через Telegram…</p>}
    {auth.status === 'guest' && hasTelegramLaunch && <aside className="auth-notice" role="status">
      <p>Telegram не передал данные для входа. Закройте магазин и откройте его заново кнопкой бота.</p>
      <button className="text-button" onClick={auth.retry}>Повторить вход</button>
    </aside>}
    {(auth.status === 'expired' || auth.status === 'error' || auth.status === 'forbidden') && <aside className="auth-notice" role="status">
      <p>{auth.status === 'expired' ? 'Для управления магазином откройте приложение заново из Telegram.'
        : auth.status === 'forbidden' ? 'У вашего аккаунта нет прав для управления магазином.'
        : describeError(auth.error, 'Не удалось проверить вход. Проверьте подключение и повторите попытку.')}</p>
      <button className="text-button" onClick={auth.retry}>Повторить вход</button>
    </aside>}
    {catalogVisited && !isAdmin && <div hidden={Boolean(productId)}><Catalog search={location.search} onFilter={filter} onOpen={openProduct} /></div>}
    {productId && <ProductDetail key={productId} id={productId} onBack={back} />}
    {isAdmin && <section className="admin-section"><button className="text-button back-button" onClick={back}>← В каталог</button><p className="eyebrow">Рабочее пространство</p><h1>Управление магазином</h1>
      {auth.user?.role === 'Admin' ? <AdminPanel /> : <p role="status">{auth.status === 'loading' ? 'Проверяем права…' : 'Управление доступно администратору при входе через Telegram.'}</p>}
    </section>}
    <footer className="store-footer"><span>КОСМЕТИКА / ТВОЙ ВЫБОР</span><a href="#top" onClick={event => { event.preventDefault(); window.scrollTo({top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}); }}>Наверх ↑</a></footer>
  </main>;
}
