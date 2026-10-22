import { useEffect, useRef, useState } from 'react';
import { ApiError, authorizedJson } from './api';

export type Brand = { id: string; name: string; description: string | null };
export type CosmeticType = { id: string; name: string };
export const errorText = (error: unknown) => error instanceof ApiError ? error.message : 'Не удалось сохранить. Проверьте подключение и повторите.';

export function AdminReferences() {
  const [tab, setTab] = useState<'brands' | 'types'>('brands');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [types, setTypes] = useState<CosmeticType[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const saveRequest = useRef<AbortController | null>(null);
  useEffect(() => () => saveRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    Promise.all([authorizedJson<Brand[]>('/api/admin/brands', 'GET', undefined, controller.signal),
      authorizedJson<CosmeticType[]>('/api/admin/types', 'GET', undefined, controller.signal)])
      .then(([newBrands, newTypes]) => {
        if (!controller.signal.aborted) { setBrands(newBrands); setTypes(newTypes); setStatus('ready'); }
      }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [attempt]);
  function reset() { setId(null); setName(''); setDescription(''); setMessage(''); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true); setMessage('');
    try {
      await authorizedJson(`/api/admin/${tab}${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST',
        { name, ...(tab === 'brands' ? { description } : {}) }, controller.signal);
      if (!controller.signal.aborted) { reset(); setMessage('Сохранено.'); setAttempt(value => value + 1); }
    } catch (error) { if (!controller.signal.aborted) setMessage(errorText(error)); }
    finally { if (!controller.signal.aborted) setSaving(false); }
  }
  const rows = tab === 'brands' ? brands : types;
  return <section className="admin-references">
    <h2>Бренды и типы косметики</h2>
    <div className="tabs" aria-label="Справочники">
      <button disabled={saving} aria-pressed={tab === 'brands'} onClick={() => { setTab('brands'); reset(); }}>Бренды</button>
      <button disabled={saving} aria-pressed={tab === 'types'} onClick={() => { setTab('types'); reset(); }}>Типы косметики</button>
    </div>
    <form className="admin-form" onSubmit={event => void save(event)}>
      <h3>{id ? 'Редактирование' : 'Новая запись'}</h3>
      <label>Название<input aria-label="Название" required maxLength={tab === 'brands' ? 160 : 100} value={name} onChange={event => setName(event.target.value)} disabled={saving} /></label>
      {tab === 'brands' && <label>Описание бренда<textarea aria-label="Описание бренда" maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} disabled={saving} /></label>}
      <div className="form-actions"><button disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
        {id && <button type="button" className="text-button" disabled={saving} onClick={reset}>Отменить</button>}</div>
      {message && <p role="status">{message}</p>}
    </form>
    {status === 'loading' ? <p role="status">Загружаем справочники…</p> : status === 'error'
      ? <div role="alert"><p>Не удалось загрузить справочники.</p><button onClick={() => setAttempt(value => value + 1)}>Повторить</button></div>
      : <ul className="admin-list">{rows.length === 0 && <li>Записей пока нет.</li>}{rows.map(row => <li key={row.id}>
        <span>{row.name}</span><button className="text-button" disabled={saving} aria-label={`Изменить ${row.name}`} onClick={() => {
          setId(row.id); setName(row.name); setDescription('description' in row && typeof row.description === 'string' ? row.description : ''); setMessage('');
          document.querySelector('.admin-form input')?.scrollIntoView({ block: 'center' });
        }}>Изменить</button>
      </li>)}</ul>}
  </section>;
}
