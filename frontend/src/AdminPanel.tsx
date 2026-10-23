import { useState } from 'react';
import { AdminReferences } from './AdminReferences';
import { AdminProducts } from './AdminProducts';

export function AdminPanel({ telegramId }: { telegramId: string }) {
  const [tab, setTab] = useState<'references' | 'products'>('references');
  return <><div className="tabs" aria-label="Раздел управления">
    <button aria-pressed={tab === 'references'} onClick={() => setTab('references')}>Справочники</button>
    <button aria-pressed={tab === 'products'} onClick={() => setTab('products')}>Товары</button>
  </div>{tab === 'references' ? <AdminReferences /> : <AdminProducts telegramId={telegramId} />}</>;
}
