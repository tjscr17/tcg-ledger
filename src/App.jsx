import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Search, Plus, X, TrendingUp, TrendingDown, Folder, Trash2, DollarSign, Anchor, ChevronRight, Package, BarChart3, RefreshCw, Cloud, HardDrive, ImageOff } from 'lucide-react';
import { store, MODE, VAULT_LABEL } from './storage.js';
import { loadCatalog, loadPriceHistory, groupBySet } from './catalog.js';

const COLOR_TOKENS = {
  Red: '#c8442a', Blue: '#2d5d8f', Green: '#3d7a4a', Yellow: '#d4a23a',
  Purple: '#6b4a8a', Black: '#2a2a2a', Multicolor: '#7a6a4a',
};
const fallbackColor = (color) => COLOR_TOKENS[color] || '#5a4d3a';

const RARITY_LABELS = {
  L: 'Leader', SR: 'Super Rare', SEC: 'Secret Rare', R: 'Rare',
  UC: 'Uncommon', C: 'Common', P: 'Promo', SP: 'Special', TR: 'Treasure',
};
const CONDITIONS = ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

const uid = () => Math.random().toString(36).slice(2, 10);

// ============================================================================
export default function App() {
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(null);

  const [collections, setCollections] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState('collection');
  const [activeCollectionId, setActiveCollectionId] = useState(null);
  const [detailCard, setDetailCard] = useState(null);
  const [addingCard, setAddingCard] = useState(null);

  // Load card catalog
  useEffect(() => {
    (async () => {
      try {
        const cards = await loadCatalog();
        setCatalog(cards);
      } catch (e) {
        console.error(e);
        setCatalogError(e.message);
      } finally {
        setCatalogLoading(false);
      }
    })();
  }, []);

  // Load user data
  const refreshData = useCallback(async () => {
    const [cols, ents] = await Promise.all([store.list('collections'), store.list('entries')]);
    let cs = cols;
    if (cs.length === 0) {
      const seed = await store.insert('collections', { id: uid(), name: 'Main Vault', created_at: new Date().toISOString() });
      cs = [seed].filter(Boolean);
    }
    setCollections(cs);
    setEntries(ents);
    setActiveCollectionId(prev => prev || cs[0]?.id || null);
  }, []);

  useEffect(() => {
    (async () => {
      try { await refreshData(); }
      finally { setLoading(false); }
    })();
    // Realtime sync (shared mode only)
    const unsubC = store.subscribe('collections', refreshData);
    const unsubE = store.subscribe('entries', refreshData);
    return () => { unsubC(); unsubE(); };
  }, [refreshData]);

  // Quick catalog lookup
  const catalogIndex = useMemo(() => {
    const m = new Map();
    for (const c of catalog) m.set(c.id, c);
    return m;
  }, [catalog]);

  const addCollection = async (name) => {
    const created = await store.insert('collections', { id: uid(), name, created_at: new Date().toISOString() });
    if (created) setCollections([...collections, created]);
  };

  const deleteCollection = async (id) => {
    if (collections.length <= 1) return;
    if (!confirm('Delete this vault and all its entries? This cannot be undone.')) return;
    await store.remove('collections', id);
    await store.removeWhere('entries', (e) => e.collection_id === id);
    setCollections(collections.filter(c => c.id !== id));
    setEntries(entries.filter(e => e.collection_id !== id));
    if (activeCollectionId === id) setActiveCollectionId(collections.find(c => c.id !== id)?.id || null);
  };

  const addEntry = async (entry) => {
    const created = await store.insert('entries', {
      ...entry,
      id: uid(),
      added_at: new Date().toISOString(),
    });
    if (created) setEntries([...entries, created]);
  };

  const updateEntry = async (id, patch) => {
    const updated = await store.update('entries', id, patch);
    if (updated) setEntries(entries.map(e => e.id === id ? updated : e));
  };

  const removeEntry = async (id) => {
    await store.remove('entries', id);
    setEntries(entries.filter(e => e.id !== id));
  };

  const activeCollection = collections.find(c => c.id === activeCollectionId);
  const activeEntries = entries.filter(e => e.collection_id === activeCollectionId);

  if (loading || catalogLoading) {
    return (
      <div className="op-shell op-loading">
        <Anchor size={42} className="op-loading-icon" />
        <div className="op-loading-text">
          {catalogLoading ? 'Pulling the bounty board…' : 'Hoisting the colors…'}
        </div>
        <div className="op-loading-sub">Loading card catalog from OPTCGAPI</div>
      </div>
    );
  }

  return (
    <div className="op-shell">
      <Header
        view={view} setView={setView}
        collections={collections}
        activeCollectionId={activeCollectionId} setActiveCollectionId={setActiveCollectionId}
        addCollection={addCollection} deleteCollection={deleteCollection}
      />

      {catalogError && (
        <div className="op-banner op-banner-warn">
          Couldn't reach the OPTCGAPI card catalog ({catalogError}). Some features may be limited.
        </div>
      )}

      <main className="op-main">
        {view === 'collection' && (
          <CollectionView
            collection={activeCollection}
            entries={activeEntries}
            catalogIndex={catalogIndex}
            onSearchClick={() => setView('search')}
            onCardClick={(card) => setDetailCard(card)}
            onRemoveEntry={removeEntry}
            onEditEntry={updateEntry}
          />
        )}
        {view === 'search' && (
          <SearchView
            catalog={catalog}
            onAddCard={setAddingCard}
            onCardClick={setDetailCard}
          />
        )}
      </main>

      {addingCard && (
        <AddCardModal
          card={addingCard}
          collections={collections}
          activeCollectionId={activeCollectionId}
          onClose={() => setAddingCard(null)}
          onSave={async (entry) => { await addEntry(entry); setAddingCard(null); }}
        />
      )}

      {detailCard && (
        <CardDetailDrawer
          card={detailCard}
          entries={entries.filter(e => e.card_id === detailCard.id)}
          collections={collections}
          onClose={() => setDetailCard(null)}
          onAddToCollection={() => { setAddingCard(detailCard); setDetailCard(null); }}
          onRemoveEntry={removeEntry}
        />
      )}

      <ModeIndicator />
    </div>
  );
}

// ============================================================================
function Header({ view, setView, collections, activeCollectionId, setActiveCollectionId, addCollection, deleteCollection }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const menuRef = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const active = collections.find(c => c.id === activeCollectionId);

  return (
    <header className="op-header">
      <div className="op-brand">
        <div className="op-brand-mark"><Anchor size={22} strokeWidth={2.5} /></div>
        <div>
          <div className="op-brand-name">THE LEDGER</div>
          <div className="op-brand-sub">One Piece TCG · Collection Tracker</div>
        </div>
      </div>

      <nav className="op-nav">
        <button className={`op-nav-btn ${view === 'collection' ? 'is-active' : ''}`} onClick={() => setView('collection')}>
          <Folder size={15} /> Collection
        </button>
        <button className={`op-nav-btn ${view === 'search' ? 'is-active' : ''}`} onClick={() => setView('search')}>
          <Search size={15} /> Search
        </button>
      </nav>

      <div className="op-collection-picker" ref={menuRef}>
        <button className="op-collection-btn" onClick={() => setMenuOpen(!menuOpen)}>
          <span className="op-collection-label">Vault</span>
          <span className="op-collection-name">{active?.name || '—'}</span>
          <ChevronRight size={14} className={`op-chev ${menuOpen ? 'is-open' : ''}`} />
        </button>
        {menuOpen && (
          <div className="op-collection-menu">
            {collections.map(c => (
              <div key={c.id} className={`op-collection-item ${c.id === activeCollectionId ? 'is-active' : ''}`}>
                <button className="op-collection-item-btn" onClick={() => { setActiveCollectionId(c.id); setMenuOpen(false); }}>
                  {c.name}
                </button>
                {collections.length > 1 && (
                  <button className="op-collection-del" onClick={() => deleteCollection(c.id)} title="Delete vault">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            <div className="op-collection-new">
              <input
                placeholder="New vault name"
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newColName.trim()) {
                    addCollection(newColName.trim());
                    setNewColName('');
                  }
                }}
              />
              <button onClick={() => { if (newColName.trim()) { addCollection(newColName.trim()); setNewColName(''); } }}>
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

function ModeIndicator() {
  return (
    <div className="op-mode-indicator" title={MODE === 'shared' ? `Shared vault: ${VAULT_LABEL}` : 'Local-only storage on this device'}>
      {MODE === 'shared' ? <Cloud size={12} /> : <HardDrive size={12} />}
      <span>{MODE === 'shared' ? `shared · ${VAULT_LABEL}` : 'local'}</span>
    </div>
  );
}

// ============================================================================
function CollectionView({ collection, entries, catalogIndex, onSearchClick, onCardClick, onRemoveEntry, onEditEntry }) {
  const stats = useMemo(() => {
    let totalPaid = 0, totalMarket = 0;
    for (const e of entries) {
      totalPaid += Number(e.purchase_price) || 0;
      const card = catalogIndex.get(e.card_id);
      if (card) totalMarket += card.marketPrice || 0;
    }
    return { totalPaid, totalMarket, count: entries.length };
  }, [entries, catalogIndex]);

  const profit = stats.totalMarket - stats.totalPaid;
  const profitPct = stats.totalPaid > 0 ? (profit / stats.totalPaid) * 100 : 0;

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Active Vault</div>
          <h1 className="op-page-title">{collection?.name || 'No collection'}</h1>
          <div className="op-page-sub">{stats.count} {stats.count === 1 ? 'card' : 'cards'} logged in this vault</div>
        </div>
        <button className="op-btn-primary" onClick={onSearchClick}>
          <Plus size={16} /> Add Cards
        </button>
      </div>

      <div className="op-stats">
        <Stat label="Paid In" value={`$${stats.totalPaid.toFixed(2)}`} />
        <Stat label="Market Value" value={`$${stats.totalMarket.toFixed(2)}`} accent />
        <Stat
          label={profit >= 0 ? 'Unrealized Gain' : 'Unrealized Loss'}
          value={`${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`}
          sub={`${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`}
          tone={profit >= 0 ? 'pos' : 'neg'}
        />
        <Stat label="Cards Tracked" value={stats.count} />
      </div>

      {entries.length === 0 ? (
        <div className="op-empty">
          <Package size={36} strokeWidth={1.2} />
          <div className="op-empty-title">This vault is empty</div>
          <div className="op-empty-sub">Search the One Piece TCG catalog and add your first card to start tracking.</div>
          <button className="op-btn-primary" onClick={onSearchClick}>
            <Search size={15} /> Open the Catalog
          </button>
        </div>
      ) : (
        <div className="op-entries">
          {entries.map(entry => {
            const card = catalogIndex.get(entry.card_id);
            if (!card) {
              return (
                <div key={entry.id} className="op-entry op-entry-missing">
                  <div className="op-entry-missing-text">Card {entry.card_id} not found in catalog</div>
                  <button className="op-entry-remove" onClick={() => onRemoveEntry(entry.id)}><X size={15} /></button>
                </div>
              );
            }
            const delta = (card.marketPrice || 0) - (Number(entry.purchase_price) || 0);
            return (
              <EntryRow
                key={entry.id}
                entry={entry}
                card={card}
                delta={delta}
                onClick={() => onCardClick(card)}
                onRemove={() => onRemoveEntry(entry.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone, accent }) {
  return (
    <div className={`op-stat ${accent ? 'is-accent' : ''} ${tone ? `is-${tone}` : ''}`}>
      <div className="op-stat-label">{label}</div>
      <div className="op-stat-value">{value}</div>
      {sub && <div className="op-stat-sub">{sub}</div>}
    </div>
  );
}

function EntryRow({ entry, card, delta, onClick, onRemove }) {
  return (
    <div className="op-entry">
      <button className="op-entry-main" onClick={onClick}>
        <CardThumb card={card} size={48} />
        <div className="op-entry-info">
          <div className="op-entry-cardname">{card.name}</div>
          <div className="op-entry-cardset">
            <span className="op-entry-id">{card.id}</span> · {card.setName} · {RARITY_LABELS[card.rarity] || card.rarity}
          </div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Condition</div>
          <div className="op-entry-cell-val">{entry.condition || '—'}</div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Owner</div>
          <div className="op-entry-cell-val">{entry.owner_name || '—'}</div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Paid</div>
          <div className="op-entry-cell-val">${Number(entry.purchase_price || 0).toFixed(2)}</div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Market</div>
          <div className="op-entry-cell-val">${(card.marketPrice || 0).toFixed(2)}</div>
        </div>
        <div className={`op-entry-delta ${delta >= 0 ? 'is-pos' : 'is-neg'}`}>
          {delta >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {delta >= 0 ? '+' : ''}${delta.toFixed(2)}
        </div>
      </button>
      <button className="op-entry-remove" onClick={onRemove} title="Remove from vault">
        <X size={15} />
      </button>
    </div>
  );
}

function CardThumb({ card, size = 60 }) {
  const [errored, setErrored] = useState(false);
  if (!card.imageUrl || errored) {
    return (
      <div
        className="op-card-thumb-fallback"
        style={{ width: size, height: size * 1.4, background: `linear-gradient(135deg, ${fallbackColor(card.color)} 0%, ${fallbackColor(card.color)}aa 100%)` }}
      >
        <ImageOff size={size / 3} opacity={0.5} />
      </div>
    );
  }
  return (
    <img
      src={card.imageUrl}
      alt={card.name}
      className="op-card-thumb"
      style={{ width: size, height: size * 1.4 }}
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}

// ============================================================================
function SearchView({ catalog, onAddCard, onCardClick }) {
  const [q, setQ] = useState('');
  const [rarityFilter, setRarityFilter] = useState('all');
  const [colorFilter, setColorFilter] = useState('all');
  const [setFilter, setSetFilter] = useState('all');
  const [sortBy, setSortBy] = useState('set'); // 'set' | 'name' | 'price-desc' | 'price-asc'

  // All distinct sets, sorted
  const sets = useMemo(() => {
    const m = new Map();
    for (const c of catalog) {
      if (!c.setId) continue;
      if (!m.has(c.setId)) m.set(c.setId, { id: c.setId, name: c.setName });
    }
    return Array.from(m.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [catalog]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return catalog.filter(c => {
      if (rarityFilter !== 'all' && c.rarity !== rarityFilter) return false;
      if (colorFilter !== 'all' && c.color !== colorFilter) return false;
      if (setFilter !== 'all' && c.setId !== setFilter) return false;
      if (!needle) return true;
      return (c.name || '').toLowerCase().includes(needle) ||
        (c.id || '').toLowerCase().includes(needle) ||
        (c.setName || '').toLowerCase().includes(needle) ||
        (c.text || '').toLowerCase().includes(needle);
    });
  }, [catalog, q, rarityFilter, colorFilter, setFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sortBy === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sortBy === 'price-desc') arr.sort((a, b) => (b.marketPrice || 0) - (a.marketPrice || 0));
    else if (sortBy === 'price-asc') arr.sort((a, b) => (a.marketPrice || 0) - (b.marketPrice || 0));
    else arr.sort((a, b) => {
      if (a.setId !== b.setId) return (a.setId || '').localeCompare(b.setId || '');
      return (a.id || '').localeCompare(b.id || '');
    });
    return arr;
  }, [filtered, sortBy]);

  // When sorting by set, group; otherwise flat list
  const grouped = useMemo(() => sortBy === 'set' ? groupBySet(sorted) : null, [sortBy, sorted]);

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Catalog</div>
          <h1 className="op-page-title">Card Search</h1>
          <div className="op-page-sub">{catalog.length.toLocaleString()} cards indexed · live prices from OPTCGAPI</div>
        </div>
      </div>

      <div className="op-search-bar">
        <Search size={18} className="op-search-icon" />
        <input
          autoFocus
          className="op-search-input"
          placeholder="Search by name, card ID, set, or card text…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="op-search-clear" onClick={() => setQ('')}>
            <X size={16} />
          </button>
        )}
      </div>

      <div className="op-filters">
        <FilterGroup label="Set" value={setFilter} onChange={setSetFilter} options={[
          { v: 'all', l: 'All Sets' },
          ...sets.map(s => ({ v: s.id, l: `${s.id} · ${s.name}` })),
        ]} mode="select" />

        <FilterGroup label="Rarity" value={rarityFilter} onChange={setRarityFilter} options={[
          { v: 'all', l: 'All' }, { v: 'L', l: 'Leader' }, { v: 'SR', l: 'Super Rare' },
          { v: 'SEC', l: 'Secret' }, { v: 'R', l: 'Rare' }, { v: 'UC', l: 'Uncommon' },
          { v: 'C', l: 'Common' }, { v: 'P', l: 'Promo' },
        ]} />

        <FilterGroup label="Color" value={colorFilter} onChange={setColorFilter} options={[
          { v: 'all', l: 'All' }, { v: 'Red', l: 'Red' }, { v: 'Blue', l: 'Blue' },
          { v: 'Green', l: 'Green' }, { v: 'Yellow', l: 'Yellow' },
          { v: 'Purple', l: 'Purple' }, { v: 'Black', l: 'Black' },
        ]} />

        <FilterGroup label="Sort" value={sortBy} onChange={setSortBy} options={[
          { v: 'set', l: 'By Set' },
          { v: 'name', l: 'Name' },
          { v: 'price-desc', l: 'Price ↓' },
          { v: 'price-asc', l: 'Price ↑' },
        ]} />
      </div>

      <div className="op-results-count">
        {sorted.length.toLocaleString()} {sorted.length === 1 ? 'result' : 'results'}
        {(q || rarityFilter !== 'all' || colorFilter !== 'all' || setFilter !== 'all') && (
          <button className="op-clear-filters" onClick={() => {
            setQ(''); setRarityFilter('all'); setColorFilter('all'); setSetFilter('all');
          }}>Clear filters</button>
        )}
      </div>

      {grouped ? (
        <div>
          {grouped.map(group => (
            <SetGroup
              key={group.setId}
              group={group}
              onAddCard={onAddCard}
              onCardClick={onCardClick}
            />
          ))}
        </div>
      ) : (
        <div className="op-card-grid">
          {sorted.map(card => (
            <CardTile key={card.id} card={card} onAddCard={onAddCard} onCardClick={onCardClick} />
          ))}
        </div>
      )}
    </div>
  );
}

function SetGroup({ group, onAddCard, onCardClick }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="op-set-group">
      <button className="op-set-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="op-set-header-id">{group.setId}</div>
        <div className="op-set-header-name">{group.setName}</div>
        <div className="op-set-header-count">{group.cards.length}</div>
        <ChevronRight size={16} className={`op-chev ${!collapsed ? 'is-open' : ''}`} />
      </button>
      {!collapsed && (
        <div className="op-card-grid">
          {group.cards.map(card => (
            <CardTile key={card.id} card={card} onAddCard={onAddCard} onCardClick={onCardClick} />
          ))}
        </div>
      )}
    </div>
  );
}

function CardTile({ card, onAddCard, onCardClick }) {
  return (
    <div className="op-card-tile">
      <button className="op-card-tile-main" onClick={() => onCardClick(card)}>
        <div className="op-card-tile-art">
          <CardArt card={card} />
          <div className="op-card-tile-rarity">{card.rarity}</div>
          {card.isParallel && <div className="op-card-tile-parallel">PARALLEL</div>}
        </div>
        <div className="op-card-tile-body">
          <div className="op-card-tile-id">{card.id}</div>
          <div className="op-card-tile-name">{card.name}</div>
          <div className="op-card-tile-set">{card.setName}</div>
          <div className="op-card-tile-price">
            <span className="op-card-tile-price-label">Market</span>
            <span className="op-card-tile-price-val">${(card.marketPrice || 0).toFixed(2)}</span>
          </div>
        </div>
      </button>
      <button className="op-card-tile-add" onClick={() => onAddCard(card)}>
        <Plus size={14} /> Add to Vault
      </button>
    </div>
  );
}

function CardArt({ card }) {
  const [errored, setErrored] = useState(false);
  if (!card.imageUrl || errored) {
    return (
      <div className="op-card-art-fallback" style={{ background: `linear-gradient(135deg, ${fallbackColor(card.color)} 0%, ${fallbackColor(card.color)}aa 100%)` }}>
        <div className="op-card-art-fallback-name">{card.name}</div>
        <div className="op-card-art-fallback-id">{card.id}</div>
      </div>
    );
  }
  return (
    <img
      src={card.imageUrl}
      alt={card.name}
      className="op-card-art-img"
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}

function FilterGroup({ label, value, onChange, options, mode }) {
  if (mode === 'select') {
    return (
      <div className="op-filter-group">
        <div className="op-filter-label">{label}</div>
        <select className="op-filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      </div>
    );
  }
  return (
    <div className="op-filter-group">
      <div className="op-filter-label">{label}</div>
      <div className="op-filter-pills">
        {options.map(o => (
          <button
            key={o.v}
            className={`op-filter-pill ${value === o.v ? 'is-active' : ''}`}
            onClick={() => onChange(o.v)}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
function AddCardModal({ card, collections, activeCollectionId, onClose, onSave }) {
  const [collectionId, setCollectionId] = useState(activeCollectionId);
  const [condition, setCondition] = useState('Near Mint');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [contributions, setContributions] = useState([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const addContribRow = () => setContributions([...contributions, { name: '', amount: '' }]);
  const updateContrib = (i, patch) => setContributions(contributions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeContrib = (i) => setContributions(contributions.filter((_, idx) => idx !== i));

  const contribTotal = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const priceNum = Number(purchasePrice) || 0;
  const contribMismatch = contributions.length > 0 && Math.abs(contribTotal - priceNum) > 0.01;

  const handleSave = async () => {
    setSaving(true);
    const entry = {
      card_id: card.id,
      collection_id: collectionId,
      condition,
      purchase_price: priceNum,
      owner_name: ownerName.trim() || null,
      contributions: contributions.filter(c => c.name.trim() && Number(c.amount) > 0).map(c => ({ name: c.name.trim(), amount: Number(c.amount) })),
      notes: notes.trim(),
    };
    await onSave(entry);
    setSaving(false);
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          <div className="op-modal-art-wrap">
            <CardArt card={card} />
          </div>
          <div>
            <div className="op-eyebrow">Logging acquisition</div>
            <div className="op-modal-title">{card.name}</div>
            <div className="op-modal-sub">{card.id} · {card.setName} · {RARITY_LABELS[card.rarity] || card.rarity}</div>
            <div className="op-modal-market">
              Market: <strong>${(card.marketPrice || 0).toFixed(2)}</strong>
              {card.inventoryPrice > 0 && <> · Inventory: <strong>${card.inventoryPrice.toFixed(2)}</strong></>}
            </div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-row">
            <Field label="Vault">
              <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Condition">
              <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>

          <div className="op-form-row">
            <Field label="Total paid (USD)">
              <input
                type="number" step="0.01" placeholder="0.00"
                value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)}
              />
            </Field>
            <Field label="Owner (who keeps the card)">
              <input
                type="text" placeholder="e.g. Luffy"
                value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
              />
            </Field>
          </div>

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Who paid what</div>
                <div className="op-form-section-sub">Split cost between people. Leave empty if one person paid in full.</div>
              </div>
              <button className="op-btn-ghost" onClick={addContribRow}>
                <Plus size={14} /> Add split
              </button>
            </div>

            {contributions.map((c, i) => (
              <div key={i} className="op-contrib-row">
                <input
                  type="text" placeholder="Name"
                  value={c.name} onChange={(e) => updateContrib(i, { name: e.target.value })}
                />
                <div className="op-contrib-amount">
                  <DollarSign size={13} />
                  <input
                    type="number" step="0.01" placeholder="0.00"
                    value={c.amount} onChange={(e) => updateContrib(i, { amount: e.target.value })}
                  />
                </div>
                <button className="op-contrib-remove" onClick={() => removeContrib(i)}><X size={14} /></button>
              </div>
            ))}

            {contributions.length > 0 && (
              <div className={`op-contrib-check ${contribMismatch ? 'is-warn' : 'is-ok'}`}>
                Splits total: <strong>${contribTotal.toFixed(2)}</strong> of <strong>${priceNum.toFixed(2)}</strong>
                {contribMismatch && <span> · doesn't match total paid</span>}
              </div>
            )}
          </div>

          <Field label="Notes (optional)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where bought, condition notes, etc." />
          </Field>

          <div className="op-form-actions">
            <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save to Vault'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="op-field">
      <span className="op-field-label">{label}</span>
      {children}
    </label>
  );
}

// ============================================================================
function CardDetailDrawer({ card, entries, collections, onClose, onAddToCollection, onRemoveEntry }) {
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    loadPriceHistory(card.id).then(h => {
      if (!cancelled) {
        setHistory(h);
        setHistoryLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [card.id]);

  const trend = useMemo(() => {
    if (history.length < 2) return 0;
    const first = history[0].price, last = history[history.length - 1].price;
    return first > 0 ? ((last - first) / first) * 100 : 0;
  }, [history]);

  return (
    <div className="op-drawer-backdrop" onClick={onClose}>
      <div className="op-drawer" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>

        <div className="op-drawer-hero">
          <div className="op-drawer-hero-img">
            <CardArt card={card} />
          </div>
          <div className="op-drawer-hero-meta">
            <div className="op-drawer-hero-id">{card.id}</div>
            <div className="op-drawer-hero-rarity">{RARITY_LABELS[card.rarity] || card.rarity}</div>
            <div className="op-drawer-hero-name">{card.name}</div>
            <div className="op-drawer-hero-set">{card.setName}</div>
            {card.text && <div className="op-drawer-hero-text">{card.text}</div>}
          </div>
        </div>

        <div className="op-drawer-body">
          <div className="op-price-grid">
            <PriceCell label="Market" value={`$${(card.marketPrice || 0).toFixed(2)}`} accent />
            <PriceCell label="Inventory" value={`$${(card.inventoryPrice || 0).toFixed(2)}`} />
            <PriceCell
              label="14d trend"
              value={historyLoading ? '…' : `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`}
              tone={trend >= 0 ? 'pos' : 'neg'}
            />
          </div>

          <div className="op-section-title"><BarChart3 size={15} /> 14-day price history</div>
          {historyLoading ? (
            <div className="op-empty-mini">Loading price history…</div>
          ) : history.length < 2 ? (
            <div className="op-empty-mini">Not enough history available for this card yet.</div>
          ) : (
            <PriceChart data={history} color={fallbackColor(card.color)} />
          )}

          <div className="op-section-title"><Folder size={15} /> Copies in your vaults ({entries.length})</div>
          {entries.length === 0 ? (
            <div className="op-empty-mini">No copies of this card logged yet.</div>
          ) : (
            <div className="op-detail-entries">
              {entries.map(entry => {
                const col = collections.find(c => c.id === entry.collection_id);
                return (
                  <div key={entry.id} className="op-detail-entry">
                    <div className="op-detail-entry-head">
                      <div>
                        <div className="op-detail-entry-collection">{col?.name || 'Unknown vault'}</div>
                        <div className="op-detail-entry-meta">
                          {entry.condition} · Paid ${Number(entry.purchase_price || 0).toFixed(2)} · Owned by {entry.owner_name || '—'}
                        </div>
                      </div>
                      <button className="op-detail-entry-remove" onClick={() => onRemoveEntry(entry.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {entry.contributions && entry.contributions.length > 0 && (
                      <div className="op-detail-entry-splits">
                        {entry.contributions.map((c, i) => (
                          <span key={i} className="op-split-chip">{c.name}: ${Number(c.amount).toFixed(2)}</span>
                        ))}
                      </div>
                    )}
                    {entry.notes && <div className="op-detail-entry-notes">{entry.notes}</div>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="op-drawer-actions">
            <button className="op-btn-primary" onClick={onAddToCollection}>
              <Plus size={15} /> Log another copy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PriceCell({ label, value, tone, accent }) {
  return (
    <div className={`op-price-cell ${accent ? 'is-accent' : ''} ${tone ? `is-${tone}` : ''}`}>
      <div className="op-price-cell-label">{label}</div>
      <div className="op-price-cell-val">{value}</div>
    </div>
  );
}

function PriceChart({ data, color }) {
  const W = 600, H = 160, P = 22;
  const prices = data.map(d => d.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const pts = data.map((d, i) => {
    const x = P + (i / Math.max(1, data.length - 1)) * (W - P * 2);
    const y = H - P - ((d.price - min) / range) * (H - P * 2);
    return { x, y, price: d.price, date: d.date };
  });
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const area = `${path} L ${pts[pts.length - 1].x} ${H - P} L ${pts[0].x} ${H - P} Z`;

  return (
    <div className="op-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="op-chart-svg">
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#chartFill)" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3" fill={color} />
        ))}
      </svg>
      <div className="op-chart-axis">
        <span>{data[0].date}</span>
        <span>${min.toFixed(2)} – ${max.toFixed(2)}</span>
        <span>{data[data.length - 1].date}</span>
      </div>
    </div>
  );
}
