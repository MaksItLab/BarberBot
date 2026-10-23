import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { connectTelegram, connectBackButton, hasTelegramLaunch } from './telegram';
import { Catalog } from './Catalog';
import { ProductDetail } from './ProductDetail';
import { useTelegramUser } from './auth';
import { describeError } from './api';
import { AdminPanel } from './AdminPanel';
import { onCatalogChange } from './catalogApi';
import { keepFocusedFieldVisible } from './keyboard';
import type { CatalogRestore } from './Catalog';

const readLocation = () => ({ path: window.location.pathname, search: window.location.search });

/**
 * U07: the catalog entry in history remembers its scroll and loaded pages. They are used only for the
 * same catalog generation: after an admin save the list is new and starts from the top.
 */
type CatalogEntry = { catalogScroll?: number; catalogPages?: number; catalogGeneration?: number };
const catalogEntry = (): CatalogEntry => (window.history.state ?? {}) as CatalogEntry;
function savedCatalog(generation: number): CatalogRestore | null {
  const entry = catalogEntry();
  if (entry.catalogGeneration !== generation) return null;
  return { scroll: entry.catalogScroll ?? 0, pages: Math.min(5, Math.max(1, Math.floor(entry.catalogPages ?? 1))) };
}

export function App() {
  const auth = useTelegramUser();
  const [location, setLocation] = useState(readLocation);
  const productId = /^\/products\/([^/]+)$/.exec(location.path)?.[1];
  const isAdmin = location.path === '/admin';
  const [catalogVisited, setCatalogVisited] = useState(!productId);
  // Every entry we add carries the generation, so a reload continues from it instead of from 0.
  const [catalogGeneration, setCatalogGeneration] = useState(() => catalogEntry().catalogGeneration ?? 0);
  useEffect(() => onCatalogChange(() => setCatalogGeneration(value => value + 1)), []);
  const onCatalog = !productId && !isAdmin;
  // The admin address has no filter: the hidden catalog keeps the one it was left with.
  const catalogSearch = useRef(location.search);
  if (onCatalog || productId) catalogSearch.current = location.search;
  useEffect(keepFocusedFieldVisible, []);
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
    let disconnect = connectTelegram();
    const initialize = () => { disconnect(); disconnect = connectTelegram(); };
    const pop = () => setLocation(readLocation());
    window.addEventListener('load', initialize);
    window.addEventListener('popstate', pop);
    return () => { disconnect(); window.removeEventListener('load', initialize); window.removeEventListener('popstate', pop); };
  }, []);
  // U06: back on the catalog, focus returns to what opened the screen; the admin screen focuses its heading.
  const returnFocus = useRef<string | null>(null);
  const adminTitle = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (!productId) setCatalogVisited(true);
    window.scrollTo(0, onCatalog ? savedCatalog(catalogGeneration)?.scroll ?? 0 : 0);
    if (isAdmin) adminTitle.current?.focus({ preventScroll: true });
    if (onCatalog && returnFocus.current) {
      document.querySelector<HTMLElement>(returnFocus.current)?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [productId, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps -- only on a screen change

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

  // Filters replace the address instead of adding history entries: "Back" means one level up everywhere,
  // as the Telegram button does, and a filtered address can still be copied.
  function filter(value: string) {
    if (location.path === '/' && new URLSearchParams(location.search).toString() === value) return;
    window.history.replaceState({ catalogGeneration }, '', value ? `/?${value}` : '/');
    setLocation(readLocation());
  }
  /** Leaves the catalog for a screen one level down; a second tap while it opens adds nothing. */
  function leaveCatalog(state: { shopProduct?: true; shopAdmin?: true }, url: string) {
    if (window.location.pathname !== '/') return;
    window.history.replaceState({ ...catalogEntry(), catalogScroll: window.scrollY, catalogGeneration }, '', window.location.href);
    window.history.pushState({ ...state, catalogGeneration }, '', url);
    setLocation(readLocation());
  }
  /** Loaded pages of the catalog, kept in its history entry for a reload. */
  function rememberPages(pages: number) {
    if (window.location.pathname === '/')
      window.history.replaceState({ ...catalogEntry(), catalogPages: pages, catalogGeneration }, '', window.location.href);
  }
  function openProduct(id: string) {
    returnFocus.current = `[data-product-id="${CSS.escape(id)}"]`;
    leaveCatalog({ shopProduct: true }, `/products/${encodeURIComponent(id)}${location.search}`);
  }
  return <main className="store">
    <header className="store-header"><a className="store-identity" href="/" onClick={event => {
      if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); filter(''); window.scrollTo(0, 0);
      }
    }} aria-label="Магазин косметики — в каталог"><span className="brand-mark" aria-hidden="true">C<span>•</span></span>
      <span className="brand-title">КОСМЕТИКА</span></a></header>
    {auth.user?.role === 'Admin' && <p className="eyebrow">Администратор</p>}
    {auth.user?.role === 'Admin' && !isAdmin && <button className="text-button admin-entry" onClick={() => {
      returnFocus.current = '.admin-entry';
      if (window.location.pathname === '/') leaveCatalog({ shopAdmin: true }, '/admin');
      else { window.history.pushState({ shopAdmin: true, catalogGeneration }, '', '/admin'); setLocation(readLocation()); }
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
    {catalogVisited && <div hidden={!onCatalog}><Catalog key={catalogGeneration} search={catalogSearch.current} active={onCatalog}
      restore={onCatalog ? savedCatalog(catalogGeneration) : null} onPages={rememberPages} onFilter={filter} onOpen={openProduct} /></div>}
    {productId && <ProductDetail key={productId} id={productId} onBack={back} />}
    {isAdmin && <section className="admin-section"><button className="text-button back-button" onClick={back}>← В каталог</button><p className="eyebrow">Рабочее пространство</p><h1 ref={adminTitle} tabIndex={-1}>Управление магазином</h1>
      {auth.user?.role === 'Admin' ? <AdminPanel telegramId={auth.user.telegramId} /> : <p role="status">{auth.status === 'loading' ? 'Проверяем права…' : 'Управление доступно администратору при входе через Telegram.'}</p>}
    </section>}
    <footer className="store-footer"><span>КОСМЕТИКА / ТВОЙ ВЫБОР</span><a href="#top" onClick={event => { event.preventDefault(); window.scrollTo({top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}); }}>Наверх ↑</a></footer>
  </main>;
}
