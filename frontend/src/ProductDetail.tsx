import { useEffect, useRef, useState } from 'react';
import { ApiError, formatPrice, getJson } from './api';
import type { ProductDetails, ProductVariant } from './api';
import { ProductImage } from './Catalog';

const variantName = (variant: ProductVariant) => [variant.volume, variant.size && `Размер ${variant.size}`,
  variant.shade && `Оттенок ${variant.shade}`].filter(Boolean).join(' · ') || 'Стандартный вариант';

export function ProductDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [product, setProduct] = useState<ProductDetails | null>(null);
  const [variantId, setVariantId] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (status === 'ready') title.current?.focus({preventScroll: true});
  }, [status]);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    getJson<ProductDetails>(`/api/catalog/products/${encodeURIComponent(id)}`, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        setProduct(value); setVariantId(value.variants[0]?.id ?? '');
        setStatus(value.variants.length ? 'ready' : 'missing');
      }
    }).catch(error => {
      if (!controller.signal.aborted) setStatus(error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
    });
    return () => controller.abort();
  }, [id, attempt]);
  const variant = product?.variants.find(value => value.id === variantId);

  return <section className="detail">
    <button className="text-button back-button" onClick={onBack}>← В каталог</button>
    {status === 'ready' && product && variant ? <>
      <div className="detail-layout"><ProductImage path={product.imagePath} name={product.name} /><div className="detail-content">
      <p className="eyebrow">{product.brandName} · {product.typeName}</p>
      <h1 ref={title} tabIndex={-1}>{product.name}</h1>
      <p className="detail-price" aria-live="polite">{formatPrice(variant.priceRub)}</p>
      {product.variants.length > 1 && <fieldset className="variant-list"><legend>Выберите вариант</legend>
        {product.variants.map(value => <label key={value.id} className={value.id === variantId ? 'variant selected' : 'variant'}>
          <input type="radio" name="variant" value={value.id} checked={value.id === variantId} onChange={() => setVariantId(value.id)} />
          <span>{variantName(value)}<small>{formatPrice(value.priceRub)}</small></span>
        </label>)}
      </fieldset>}
      <p className="selected-variant" aria-live="polite"><span>{product.variants.length > 1 ? 'Выбрано' : 'Вариант'}</span>{variantName(variant)}</p>
      <h2>О товаре</h2><p className="description">{product.description}</p>
      <details className="brand-details"><summary>О бренде {product.brandName}</summary><p className="description">{product.brandDescription || 'Описание бренда пока не добавлено.'}</p></details>
      </div></div>
    </> : <div className="empty-state" aria-live="polite" aria-busy={status === 'loading'}>
      <h1>{status === 'loading' ? 'Открываем товар…' : status === 'missing' ? 'Товар недоступен' : 'Не удалось загрузить товар'}</h1>
      <p>{status === 'missing' ? 'Возможно, товар скрыт. Посмотрите другие товары в каталоге.'
        : status === 'loading' ? 'Подождите немного.' : 'Проверьте подключение и попробуйте ещё раз.'}</p>
      {status === 'error' && <button onClick={() => setAttempt(value => value + 1)}>Попробовать снова</button>}
    </div>}
  </section>;
}
