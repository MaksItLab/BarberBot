import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatPrice, localImage } from './api';
import { loadReferences, sharedGet } from './catalogApi';
import type { CatalogOption, ProductPage, ProductSummary } from './api';

type ProductsState = {
  items: ProductSummary[]; hasMore: boolean; page: number; status: 'loading' | 'ready' | 'error'; moreError: boolean;
};
type ReferencesState = { brands: CatalogOption[]; types: CatalogOption[]; status: 'loading' | 'ready' | 'error' };
/** U07: what the catalog's history entry remembers, to rebuild the list after a reload. */
export type CatalogRestore = { scroll: number; pages: number };
const plural = new Intl.PluralRules('ru-RU');
const productsWord = (count: number) => ({ one: 'товар', few: 'товара' } as Record<string, string>)[plural.select(count)] ?? 'товаров';
const noProducts: ProductsState = { items: [], hasMore: false, page: 1, status: 'loading', moreError: false };

export function ProductImage({ path, name }: { path: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  const src = localImage(path);
  const illustration = name.length % 2 === 0 ? 'jar' : 'bottle';
  return <div className="product-image">{src && !failed
    ? <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} />
    : <div className="image-placeholder" aria-label="Без изображения" role="img">
      <img src={`/images/design/${illustration}-illustration.webp`} alt="" loading="lazy" />
      <span className="placeholder-caption">Иллюстрация</span></div>}</div>;
}

export function Catalog({ search, active, restore, onPages, onFilter, onOpen }: {
  search: string; active: boolean; restore: CatalogRestore | null; onPages: (pages: number) => void;
  onFilter: (value: string) => void; onOpen: (id: string) => void;
}) {
  const params = new URLSearchParams(search);
  const brandId = params.get('brandId') ?? '';
  const typeId = params.get('typeId') ?? '';
  const filterKey = new URLSearchParams();
  if (brandId) filterKey.set('brandId', brandId);
  if (typeId) filterKey.set('typeId', typeId);
  const key = filterKey.toString();
  const [state, setState] = useState<ProductsState>(noProducts);
  const [references, setReferences] = useState<ReferencesState>({ brands: [], types: [], status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [referencesAttempt, setReferencesAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<AbortController | null>(null);
  const requestKey = useRef('');
  // Taken at mount and used by the first load only; cleared when applied, so a re-run effect still sees it.
  const restoreRef = useRef(restore && { ...restore, key });
  const activeRef = useRef(active);
  activeRef.current = active;
  const [pendingScroll, setPendingScroll] = useState<number | null>(null);
  const [shown, setShown] = useState(''); // announced after "Показать ещё", which adds cards out of the reader's sight
  useLayoutEffect(() => {
    if (pendingScroll === null) return;
    if (activeRef.current) window.scrollTo(0, pendingScroll);
    setPendingScroll(null);
  }, [pendingScroll]);

  // U01: products of the current filter. The previous list stays on screen, marked, until the new answer;
  // an answer for an earlier filter is dropped because its request is aborted first.
  useEffect(() => {
    const controller = new AbortController();
    requestKey.current = key;
    moreRequest.current?.abort();
    setLoadingMore(false);
    setState(previous => ({ ...previous, status: 'loading', moreError: false }));
    setShown('');
    const wanted = restoreRef.current?.key === key ? restoreRef.current : null;
    (async () => {
      let page = await sharedGet<ProductPage>(`/api/catalog/products?${key}`, controller.signal);
      let items = page.items;
      // After a reload: the pages loaded before, one after another; a failure keeps what has arrived.
      for (let number = 2; wanted && number <= wanted.pages && page.hasMore; number++) {
        try { page = await sharedGet<ProductPage>(`/api/catalog/products?${key}&page=${number}`, controller.signal); }
        catch (error) { if (controller.signal.aborted) throw error; break; }
        items = [...items, ...page.items];
      }
      return { ...page, items };
    })().then(page => {
      if (controller.signal.aborted) return;
      setState({ ...page, status: 'ready', moreError: false });
      onPages(page.page);
      if (wanted) { restoreRef.current = null; setPendingScroll(wanted.scroll); }
    }).catch(() => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, status: 'error' }));
    });
    return () => { controller.abort(); moreRequest.current?.abort(); };
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps -- onPages only writes the history entry

  // Brands and types, independent of products: their failure never hides the catalog.
  useEffect(() => {
    const controller = new AbortController();
    setReferences(previous => ({ ...previous, status: 'loading' }));
    loadReferences(controller.signal).then(value => {
      if (!controller.signal.aborted) setReferences({ ...value, status: 'ready' });
    }).catch(() => {
      if (!controller.signal.aborted) setReferences(previous => ({ ...previous, status: 'error' }));
    });
    return () => controller.abort();
  }, [referencesAttempt]);

  function filter(name: string, value: string) {
    const next = new URLSearchParams(key);
    if (value) next.set(name, value); else next.delete(name);
    onFilter(next.toString());
  }

  async function loadMore() {
    if (loadingMore || !state.hasMore || state.status !== 'ready') return;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    setState(previous => ({ ...previous, moreError: false }));
    try {
      const page = await sharedGet<ProductPage>(`/api/catalog/products?${key}&page=${state.page + 1}`, controller.signal);
      if (!controller.signal.aborted && requestKey.current === key) {
        const count = state.items.length + page.items.length;
        setState(previous => ({ ...previous, items: [...previous.items, ...page.items], page: page.page, hasMore: page.hasMore }));
        setShown(`Показано ${count} ${productsWord(count)}.`);
        onPages(page.page);
      }
    } catch {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, moreError: true }));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  const refreshing = state.status === 'loading' && state.items.length > 0;

  function options(values: CatalogOption[], selected: string) {
    return <>{selected && !values.some(option => option.id === selected)
      && <option value={selected}>Выбранный фильтр</option>}
      {values.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</>;
  }

  return <>
    <section className="intro" aria-labelledby="intro-title">
      <h1 id="intro-title">Твой уход. Твой выбор.</h1>
      <div className="care-banner"><img src="/images/design/care-hero.webp" alt="" fetchPriority="high" />
        <p>Каждый день —<br />для себя.</p></div>
    </section>
    <div className="catalog-heading"><h2 id="catalog-title" tabIndex={-1}>Каталог</h2>
      {refreshing && <span className="refresh-note" aria-hidden="true">Обновляем…</span>}</div>
    <section className="filters" aria-label="Фильтры каталога">
      <label><span className="sr-only">Бренд</span><select aria-label="Бренд" value={brandId} onChange={event => filter('brandId', event.target.value)}>
        <option value="">Все бренды</option>{options(references.brands, brandId)}</select></label>
      <label><span className="sr-only">Тип косметики</span><select aria-label="Тип косметики" value={typeId} onChange={event => filter('typeId', event.target.value)}>
        <option value="">Все типы</option>{options(references.types, typeId)}</select></label>
      {(brandId || typeId) && <button className="text-button" onClick={() => onFilter('')}>Сбросить</button>}
    </section>
    <div className="catalog-status" role="status">
      {references.status === 'error' && <p>Фильтры временно недоступны.{' '}
        <button className="text-button" onClick={() => setReferencesAttempt(value => value + 1)}>Повторить</button></p>}
      {refreshing && <p className="sr-only">Обновляем каталог…</p>}
      {shown && <p className="sr-only">{shown}</p>}{/* shown next to the heading, so the list does not jump */}
      {state.status === 'error' && state.items.length > 0 && <p>Не удалось обновить каталог, показаны прежние товары.{' '}
        <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Попробовать снова</button></p>}
    </div>
    {references.types.length > 0 && <div className="type-shortcuts" role="group" aria-label="Быстрый выбор типа косметики">
      <button aria-pressed={!typeId} onClick={() => filter('typeId', '')}>Всё</button>
      {references.types.map(type => <button key={type.id} aria-pressed={type.id === typeId}
        onClick={() => filter('typeId', type.id)}>{type.name}</button>)}
    </div>}
    {state.items.length === 0 ? <section className="empty-state" aria-live="polite" aria-busy={state.status === 'loading'}>
      <h2>{state.status === 'loading' ? 'Загружаем косметику…' : state.status === 'error'
        ? 'Не удалось загрузить каталог' : brandId || typeId ? 'Ничего не найдено' : 'Каталог скоро появится'}</h2>
      <p>{state.status === 'error' ? 'Проверьте подключение и попробуйте ещё раз.'
        : state.status === 'loading' ? 'Подождите немного.' : brandId || typeId
          ? 'Попробуйте изменить или сбросить фильтры.' : 'Здесь появятся товары и цены.'}</p>
      {state.status === 'error' && <button onClick={() => setAttempt(value => value + 1)}>Попробовать снова</button>}
    </section> : <>
      <section className="product-grid" aria-label="Товары" aria-busy={refreshing}>
        {state.items.map(product => <article className="product-card" key={product.id}>
          <a href={`/products/${product.id}${search}`} data-product-id={product.id} onClick={event => {
            if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
              event.preventDefault(); onOpen(product.id);
            }
          }}>
          <ProductImage path={product.imagePath} name={product.name} />
          <p className="product-brand">{product.brandName}</p><h2>{product.name}</h2>
          <p className="product-price">{product.hasPriceRange ? 'от ' : ''}{formatPrice(product.priceRub)}</p>
          </a>
        </article>)}
      </section>
      <div className="pagination" aria-live="polite">
        {state.moreError && <p role="alert">Не удалось загрузить следующие товары. Попробуйте ещё раз.</p>}
        {state.hasMore && state.status === 'ready' && <button disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Загружаем…' : 'Показать ещё'}</button>}
      </div>
    </>}
  </>;
}
