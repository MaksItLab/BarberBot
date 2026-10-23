import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, authorizedJson, isUnknownOutcome } from './api';
import { invalidateCatalog } from './catalogApi';
import { errorText } from './AdminReferences';
import type { Brand, CosmeticType } from './AdminReferences';
import { draftKey, draftTime, openDraftStore, readDraft, writeDraft } from './drafts';
import type { DraftFields, DraftVariantFields, ProductDraft } from './drafts';
import { confirmClosing } from './telegram';

type Variant = { id: string; volume: string | null; size: string | null; shade: string | null; priceRub: number; isVisible: boolean };
export type AdminProduct = { id: string; name: string; description: string; brandId: string; typeId: string; imagePath: string | null; isVisible: boolean; version: string; variants: Variant[] };
type Summary = { id: string; name: string; brandName: string; isVisible: boolean };
type ProductPage = { items: Summary[]; page: number; pageSize: number; hasMore: boolean };
type DraftVariant = { key: string; id?: string; volume: string; size: string; shade: string; price: string; isVisible: boolean };
const newVariant = (): DraftVariant => ({ key: crypto.randomUUID(), volume: '', size: '', shade: '', price: '', isVisible: true });
const toDraft = (variant: Variant): DraftVariant => ({
  key: variant.id, id: variant.id, volume: variant.volume ?? '', size: variant.size ?? '', shade: variant.shade ?? '',
  price: String(variant.priceRub), isVisible: variant.isVisible,
});

/** What another admin changed between the version this form started from and the current one. */
function changedFields(from: AdminProduct, to: AdminProduct): string[] {
  const fields: [string, boolean][] = [
    ['название', from.name !== to.name], ['описание', from.description !== to.description],
    ['бренд', from.brandId !== to.brandId], ['тип', from.typeId !== to.typeId],
    ['изображение', from.imagePath !== to.imagePath], ['видимость товара', from.isVisible !== to.isVisible],
    ['варианты', JSON.stringify(from.variants) !== JSON.stringify(to.variants)],
  ];
  return fields.filter(([, changed]) => changed).map(([label]) => label);
}

function isProduct(value: unknown, id: string): value is AdminProduct {
  const product = value as Partial<AdminProduct> | undefined;
  return product?.id === id && typeof product.version === 'string' && Array.isArray(product.variants);
}

type Errors = Record<string, string>;
const PRICE = /^\d+(?:[.,]\d{1,2})?$/;
const strip = ({ key: _key, ...row }: DraftVariant): DraftVariantFields => row;
const fromFields = (row: DraftVariantFields): DraftVariant => ({ ...row, key: row.id ?? crypto.randomUUID() });
/** The form as it is for a product version with no unsaved changes. */
function fieldsOf(product: AdminProduct | null, brands: Brand[], types: CosmeticType[]): DraftFields {
  return {
    name: product?.name ?? '', description: product?.description ?? '', brandId: product?.brandId ?? brands[0]?.id ?? '',
    typeId: product?.typeId ?? types[0]?.id ?? '', imagePath: product?.imagePath ?? '', visible: product?.isVisible ?? false,
    variants: (product ? product.variants.map(toDraft) : [newVariant()]).map(strip),
  };
}

/** Simple rules checked before sending; the server checks all of them again and names the field it rejects. */
function checkFields(fields: DraftFields): Errors {
  const errors: Errors = {};
  if (!fields.name.trim()) errors.name = 'Заполните поле «Название товара».';
  if (!fields.description.trim()) errors.description = 'Заполните поле «Описание товара».';
  fields.variants.forEach((variant, index) => {
    if (!PRICE.test(variant.price.trim())) errors[`variants[${index}].priceRub`] = 'Укажите цену в рублях, не более двух знаков после запятой.';
  });
  return errors;
}

function ProductEditor({ value, telegramId, brands, types, onSaved, onReplace, onClose }: {
  value: AdminProduct | null; telegramId: string; brands: Brand[]; types: CosmeticType[]; onSaved: (product: AdminProduct) => void;
  onReplace: (product: AdminProduct) => void; onClose: () => void;
}) {
  const [name, setName] = useState(value?.name ?? '');
  const [description, setDescription] = useState(value?.description ?? '');
  const [brandId, setBrandId] = useState(value?.brandId ?? brands[0]?.id ?? '');
  const [typeId, setTypeId] = useState(value?.typeId ?? types[0]?.id ?? '');
  const [imagePath, setImagePath] = useState(value?.imagePath ?? '');
  const [visible, setVisible] = useState(value?.isVisible ?? false);
  const [variants, setVariants] = useState<DraftVariant[]>(value ? value.variants.map(toDraft) : [newVariant()]);
  // The version this form's changes apply to; replaced only by an explicit choice after a conflict.
  const [base, setBase] = useState(value);
  const [conflict, setConflict] = useState<AdminProduct | null>(null);
  // saving → saved (parent) | failed (message) | checking → saved | not saved | unknown (check again)
  const [phase, setPhase] = useState<'editing' | 'saving' | 'checking' | 'unknown'>('editing');
  const saving = phase === 'saving' || phase === 'checking';
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [focusRequest, setFocusRequest] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const request = useRef<AbortController | null>(null);
  // One key per opened form: every attempt to save it repeats the same intent. After a confirmed
  // save the editor is remounted for the new version and gets a new key.
  const saveKey = useRef<string>(crypto.randomUUID());
  // Draft (R06): nothing is written until a stored draft was offered and answered, so it is never overwritten unseen.
  const [store] = useState(openDraftStore);
  const key = draftKey(telegramId, value?.id ?? null);
  const [draftState, setDraftState] = useState<'loading' | 'offer' | 'ready'>(store ? 'loading' : 'ready');
  const [offer, setOffer] = useState<ProductDraft | null>(null);
  const [unstored, setUnstored] = useState(!store);
  const stored = useRef(false), finished = useRef(false), flush = useRef<(() => void) | null>(null);
  const fields: DraftFields = { name, description, brandId, typeId, imagePath, visible, variants: variants.map(strip) };
  const snapshot = JSON.stringify(fields);
  const dirty = snapshot !== JSON.stringify(fieldsOf(base, brands, types));
  const unconfirmed = phase !== 'editing';
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!store) return;
    let active = true;
    readDraft(store, key).then(draft => {
      if (!active) return;
      stored.current = draft !== null;
      if (draft && (draft.base?.id ?? null) === (value?.id ?? null)
        && (draft.unconfirmed || JSON.stringify(draft.fields) !== JSON.stringify(fieldsOf(value, brands, types)))) {
        setOffer(draft); setDraftState('offer');
      } else setDraftState('ready');
    }).catch(() => { if (active) { setUnstored(true); setDraftState('ready'); } });
    return () => { active = false; };
    // Read once per opened form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!store || draftState !== 'ready' || finished.current || (!dirty && !unconfirmed && !stored.current)) return;
    const write = () => {
      flush.current = null;
      if (finished.current) return;
      const keep = dirty || unconfirmed;
      stored.current = keep;
      (keep ? writeDraft(store, key, { savedAt: Date.now(), base, saveKey: saveKey.current, unconfirmed, fields }) : store.remove(key))
        .then(() => setUnstored(false), () => setUnstored(true));
    };
    flush.current = write;
    // A sent save is recorded at once: if the app closes now, the restored form knows to check the outcome.
    const timer = window.setTimeout(write, unconfirmed ? 0 : 500);
    return () => window.clearTimeout(timer);
    // `fields` is represented by `snapshot`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, base, unconfirmed, draftState]);
  // Leaving the form (closing it, an expired login) keeps the last input that was still waiting for its delay.
  useEffect(() => () => flush.current?.(), []);
  useEffect(() => dirty || unconfirmed ? confirmClosing() : undefined, [dirty, unconfirmed]);
  useEffect(() => {
    if (focusRequest) form.current?.querySelector<HTMLElement>('[data-error="true"]')?.focus();
  }, [focusRequest]);
  /** Ends this form's draft: after a confirmed save or an explicit choice to drop the input. */
  function forget() {
    finished.current = true; flush.current = null; stored.current = false;
    void store?.remove(key).catch(() => undefined);
  }
  function saved(product: AdminProduct) { forget(); onSaved(product); }
  function applyFields(next: DraftFields) {
    setName(next.name); setDescription(next.description); setBrandId(next.brandId); setTypeId(next.typeId);
    setImagePath(next.imagePath); setVisible(next.visible); setVariants(next.variants.map(fromFields)); setErrors({});
  }
  function restore(draft: ProductDraft) {
    applyFields(draft.fields); setBase(draft.base); saveKey.current = draft.saveKey;
    setOffer(null); setDraftState('ready'); setMessage('');
    // The app closed while a save was on its way: find out whether it happened before saving again.
    if (draft.unconfirmed) void check(start());
  }
  function rejectOffer() {
    stored.current = false; void store?.remove(key).catch(() => undefined);
    setOffer(null); setDraftState('ready');
  }
  function discard() {
    applyFields(fieldsOf(base, brands, types)); setMessage('');
    stored.current = false; void store?.remove(key).catch(() => undefined);
  }
  function clear(path: string) { if (errors[path]) setErrors(({ [path]: _removed, ...rest }) => rest); }
  function update(key: string, patch: Partial<DraftVariant>, path?: string) {
    if (path) clear(path);
    setVariants(previous => previous.map(variant => variant.key === key ? { ...variant, ...patch } : variant));
  }
  const errorId = (path: string) => `${id}-${path.replace(/[^A-Za-z0-9]/g, '-')}`;
  /** Marks an input: it is announced as invalid, described by its message and focused first. */
  const invalid = (path: string) => errors[path]
    ? { 'aria-invalid': true, 'aria-describedby': errorId(path), 'data-error': 'true' } : {};
  /** The message under a field. A message with no input of its own (a whole variant) takes the focus itself. */
  const fieldError = (path: string, focusable = false) => errors[path]
    ? <span className="field-error" id={errorId(path)} {...(focusable ? { tabIndex: -1, 'data-error': 'true' } : {})}>{errors[path]}</span> : null;
  function showErrors(next: Errors, text: string) {
    setErrors(next); setMessage(text); setFocusRequest(value => value + 1);
  }
  /** Asks the server whether this form's save happened, without writing again. */
  async function check(controller: AbortController) {
    setPhase('checking'); setMessage('Уточняем, сохранился ли товар…');
    try {
      const operation = await authorizedJson<{ kind: string; productId: string }>(`/api/admin/operations/${saveKey.current}`, 'GET', undefined, controller.signal);
      const product = await authorizedJson<AdminProduct>(`/api/admin/products/${operation.productId}`, 'GET', undefined, controller.signal);
      if (!controller.signal.aborted) saved(product);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'operation_not_found') {
        setPhase('editing'); setMessage('Товар не сохранён. Можно сохранить ещё раз.');
      } else {
        setPhase('unknown');
        setMessage(`Не удалось уточнить, сохранился ли товар. Проверьте ещё раз или сохраните повторно: дубль не появится. ${errorText(error)}`);
      }
    }
  }
  function start(): AbortController {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    return controller;
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (saving || draftState !== 'ready') return;
    const local = checkFields(fields);
    if (Object.keys(local).length) { showErrors(local, 'Исправьте отмеченные поля.'); return; }
    const controller = start();
    setPhase('saving'); setMessage(''); setErrors({});
    try {
      const result = await authorizedJson<AdminProduct>(`/api/admin/products${value ? `/${value.id}` : ''}`, value ? 'PUT' : 'POST', {
        name, description, brandId, typeId, imagePath, isVisible: visible, version: base?.version ?? null,
        variants: variants.map(variant => ({ id: variant.id ?? null, volume: variant.volume, size: variant.size, shade: variant.shade,
          priceRub: Number(variant.price.trim().replace(',', '.')), isVisible: variant.isVisible })),
      }, controller.signal, saveKey.current);
      if (!controller.signal.aborted) saved(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      // "Saved" is shown only after confirmation; an unknown outcome is checked instead of being reported as a failure.
      if (isUnknownOutcome(error)) { await check(controller); return; }
      setPhase('editing');
      if (value && error instanceof ApiError && error.code === 'conflict' && isProduct(error.current, value.id)) {
        setConflict(error.current); setMessage(''); return;
      }
      if (error instanceof ApiError && error.fieldErrors) {
        // A rejected variant id is shown on the variant as a whole.
        const next = Object.fromEntries(Object.entries(error.fieldErrors).map(([path, text]) => [path.replace(/^(variants\[\d+\])\.id$/, '$1'), text]));
        showErrors(next, errorText(error)); return;
      }
      setMessage(errorText(error));
    }
  }
  /**
   * Three-way merge onto the new version: a field this admin did not touch takes the other admin's value,
   * a field this admin changed keeps the typed value. Saving stays an explicit action.
   */
  function applyMine(current: AdminProduct) {
    if (!base) return;
    const overwritten: string[] = [];
    const pick = <T,>(mine: T, original: T, theirs: T, label: string, set: (value: T) => void) => {
      if (mine === original) set(theirs);
      else if (theirs !== original && theirs !== mine) overwritten.push(label);
    };
    pick(name, base.name, current.name, 'название', setName);
    pick(description, base.description, current.description, 'описание', setDescription);
    pick(brandId, base.brandId, current.brandId, 'бренд', setBrandId);
    pick(typeId, base.typeId, current.typeId, 'тип', setTypeId);
    pick(imagePath, base.imagePath ?? '', current.imagePath ?? '', 'изображение', setImagePath);
    pick(visible, base.isVisible, current.isVisible, 'видимость товара', setVisible);
    const same = (row: DraftVariant, variant: Variant) => JSON.stringify({ ...row, key: '' }) === JSON.stringify({ ...toDraft(variant), key: '' });
    setVariants([
      ...variants.map((row, index) => {
        const original = base.variants.find(variant => variant.id === row.id), theirs = current.variants.find(variant => variant.id === row.id);
        if (!original || !theirs) return row;
        if (same(row, original)) return toDraft(theirs);
        if (!same(toDraft(theirs), original) && !same(row, theirs)) overwritten.push(`вариант ${index + 1}`);
        return row;
      }),
      // Variants added by the other admin cannot be dropped: the server keeps existing variants.
      ...current.variants.filter(variant => !variants.some(row => row.id === variant.id)).map(toDraft),
    ]);
    setBase(current); setConflict(null); setErrors({});
    setMessage(`Изменения коллеги подставлены в поля, которые вы не меняли.${overwritten.length
      ? ` Ваши правки заменят его значения: ${overwritten.join(', ')}.` : ''} Проверьте форму и нажмите «Сохранить товар».`);
  }
  return <form ref={form} className="admin-form product-editor" noValidate onSubmit={event => void save(event)}>
    {offer && <div role="alert" className="draft-notice">
      <p>Найден несохранённый черновик от {draftTime(offer.savedAt)}.{offer.unconfirmed ? ' Его сохранение не было подтверждено: после восстановления проверим, сохранился ли товар.' : ''}</p>
      <div className="form-actions">
        <button type="button" onClick={() => restore(offer)}>Восстановить</button>
        <button type="button" className="text-button" onClick={rejectOffer}>Отбросить</button>
      </div>
    </div>}
    <fieldset disabled={saving || draftState !== 'ready'}>
      <legend>{value ? 'Редактирование товара' : 'Новый товар'}</legend>
      <label>Название товара<input aria-label="Название товара" value={name} onChange={event => { clear('name'); setName(event.target.value); }} required maxLength={200} {...invalid('name')} /></label>
      {fieldError('name')}
      <label>Описание товара<textarea aria-label="Описание товара" value={description} onChange={event => { clear('description'); setDescription(event.target.value); }} required maxLength={12000} {...invalid('description')} /></label>
      {fieldError('description')}
      <label>Бренд<select aria-label="Бренд товара" value={brandId} onChange={event => { clear('brandId'); setBrandId(event.target.value); }} required {...invalid('brandId')}>{brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>
      {fieldError('brandId')}
      <label>Тип косметики<select aria-label="Тип товара" value={typeId} onChange={event => { clear('typeId'); setTypeId(event.target.value); }} required {...invalid('typeId')}>{types.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
      {fieldError('typeId')}
      <label>Изображение (необязательно)<input aria-label="Путь изображения" value={imagePath} onChange={event => { clear('imagePath'); setImagePath(event.target.value); }} placeholder="/images/cream.webp" maxLength={1024} {...invalid('imagePath')} /></label>
      {fieldError('imagePath')}
      <label className="checkbox-label"><input type="checkbox" checked={visible} onChange={event => { clear('isVisible'); setVisible(event.target.checked); }} {...invalid('isVisible')} />Показывать товар в каталоге</label>
      {fieldError('isVisible')}
      <h3>Варианты</h3>
      {fieldError('variants', true)}
      {variants.map((variant, index) => {
        const path = `variants[${index}]`;
        return <fieldset className="variant-editor" key={variant.key}>
          <legend>Вариант {index + 1}</legend>
          {fieldError(path, true)}
          <label>Объём<input aria-label={`Объём варианта ${index + 1}`} value={variant.volume} onChange={event => update(variant.key, { volume: event.target.value }, `${path}.volume`)} maxLength={64} {...invalid(`${path}.volume`)} /></label>
          {fieldError(`${path}.volume`)}
          <label>Размер<input aria-label={`Размер варианта ${index + 1}`} value={variant.size} onChange={event => update(variant.key, { size: event.target.value }, `${path}.size`)} maxLength={64} {...invalid(`${path}.size`)} /></label>
          {fieldError(`${path}.size`)}
          <label>Оттенок<input aria-label={`Оттенок варианта ${index + 1}`} value={variant.shade} onChange={event => update(variant.key, { shade: event.target.value }, `${path}.shade`)} maxLength={120} {...invalid(`${path}.shade`)} /></label>
          {fieldError(`${path}.shade`)}
          <label>Цена, ₽<input aria-label={`Цена варианта ${index + 1}`} inputMode="decimal" value={variant.price} onChange={event => update(variant.key, { price: event.target.value }, `${path}.priceRub`)} required {...invalid(`${path}.priceRub`)} /></label>
          {fieldError(`${path}.priceRub`)}
          <label className="checkbox-label"><input type="checkbox" checked={variant.isVisible} onChange={event => update(variant.key, { isVisible: event.target.checked })} />Показывать вариант</label>
          {/* Indexes shift when a row goes away, so messages tied to positions are dropped with it. */}
          {!variant.id && <button type="button" className="text-button" onClick={() => {
            setErrors(previous => Object.fromEntries(Object.entries(previous).filter(([path]) => !path.startsWith('variants'))));
            setVariants(previous => previous.filter(row => row.key !== variant.key));
          }}>Убрать новый вариант {index + 1}</button>}
        </fieldset>;
      })}
      <button type="button" className="text-button" disabled={variants.length >= 100} onClick={() => setVariants(previous => [...previous, newVariant()])}>Добавить вариант</button>
      <div className="form-actions"><button>{phase === 'saving' ? 'Сохраняем…' : phase === 'checking' ? 'Уточняем…' : 'Сохранить товар'}</button>
        {phase === 'unknown' && <button type="button" onClick={() => void check(start())}>Проверить ещё раз</button>}
        {dirty && phase === 'editing' && <button type="button" className="text-button" onClick={discard}>Отбросить черновик</button>}
        <button type="button" className="text-button" onClick={onClose}>Закрыть форму</button></div>
    </fieldset>
    {unstored && <p role="status">Черновик не сохраняется на этом устройстве: не закрывайте форму до сохранения.</p>}
    {conflict && base && <div role="alert" className="conflict-notice">
      <p>Товар уже изменил другой администратор{changedFields(base, conflict).length
        ? `: ${changedFields(base, conflict).join(', ')}` : ''}. Ваши изменения в форме сохранены.</p>
      <div className="form-actions">
        <button type="button" onClick={() => applyMine(conflict)}>Перенести мои изменения на новую версию</button>
        <button type="button" className="text-button" onClick={() => { forget(); onReplace(conflict); }}>Открыть новую версию без моих изменений</button>
      </div>
    </div>}
    {message && <p role={phase === 'checking' ? 'status' : 'alert'}>{message}</p>}
  </form>;
}

export function AdminProducts({ telegramId }: { telegramId: string }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ProductPage | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]), [types, setTypes] = useState<CosmeticType[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<AdminProduct | null | undefined>();
  const [message, setMessage] = useState('');
  const [opening, setOpening] = useState(false);
  const openRequest = useRef<AbortController | null>(null);
  useEffect(() => () => openRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); setStatus('loading');
    Promise.all([authorizedJson<ProductPage>(`/api/admin/products?page=${page}`, 'GET', undefined, controller.signal),
      authorizedJson<Brand[]>('/api/admin/brands', 'GET', undefined, controller.signal),
      authorizedJson<CosmeticType[]>('/api/admin/types', 'GET', undefined, controller.signal)]).then(([products, newBrands, newTypes]) => {
        if (!controller.signal.aborted) { setData(products); setBrands(newBrands); setTypes(newTypes); setStatus('ready'); }
      }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [page, attempt]);
  async function open(id: string) {
    openRequest.current?.abort(); const controller = new AbortController(); openRequest.current = controller;
    setOpening(true); setMessage('');
    try {
      const product = await authorizedJson<AdminProduct>(`/api/admin/products/${id}`, 'GET', undefined, controller.signal);
      if (!controller.signal.aborted) { setDraft(product); window.scrollTo(0, 0); }
    } catch (error) { if (!controller.signal.aborted) setMessage(errorText(error)); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  }
  return <section>
    <h2>Товары</h2>
    {status === 'ready' && (!brands.length || !types.length) && <p>Сначала добавьте бренд и тип косметики в справочниках.</p>}
    <button disabled={status !== 'ready' || !brands.length || !types.length || opening} onClick={() => { setDraft(null); setMessage(''); }}>Добавить товар</button>
    {message && <p role="status">{message}</p>}
    {draft !== undefined && <ProductEditor key={draft ? `${draft.id}:${draft.version}` : 'new'} value={draft} telegramId={telegramId} brands={brands} types={types}
      onClose={() => setDraft(undefined)} onReplace={product => { setDraft(product); setMessage(''); }} onSaved={product => { invalidateCatalog(); setDraft(product); setMessage('Товар сохранён.'); setAttempt(value => value + 1); }} />}
    {status === 'loading' ? <p role="status">Загружаем товары…</p> : status === 'error'
      ? <div role="alert"><p>Не удалось загрузить товары.</p><button onClick={() => setAttempt(value => value + 1)}>Повторить</button></div>
      : <><ul className="admin-list">{data?.items.length === 0 && <li>Товаров пока нет.</li>}{data?.items.map(product => <li key={product.id}>
        <span>{product.name}<small>{product.brandName} · {product.isVisible ? 'Опубликован' : 'Скрыт'}</small></span>
        <button className="text-button" disabled={opening} aria-label={`Изменить ${product.name}`} onClick={() => void open(product.id)}>Изменить</button>
      </li>)}</ul><div className="form-actions">
        {page > 1 && <button onClick={() => setPage(value => value - 1)}>Предыдущая страница</button>}
        {data?.hasMore && <button onClick={() => setPage(value => value + 1)}>Следующая страница</button>}
      </div></>}
  </section>;
}
