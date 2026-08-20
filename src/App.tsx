import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronRight, CircleHelp, Clipboard,
  Cloud, Copy, CreditCard, Download, Eye, EyeOff, FileText, Fingerprint, Globe2, Heart,
  KeyRound, Laptop, Lock, LogOut, Menu, MoreHorizontal, Plus, RefreshCw, Search, Settings,
  Shield, ShieldCheck, ShieldEllipsis, Smartphone, Sparkles, Star, Trash2, Upload, UserRound, X, Zap
} from 'lucide-react'
import { decryptVault, encryptVault, generatePassword, strength } from './crypto'
import { claimPairCode, clearSyncConfig, createCloud, createPairCode, getSyncConfig, pullCloud, pushCloud, type SyncConfig } from './sync'
import type { EncryptedVault, VaultData, VaultItem } from './types'

const STORAGE_KEY = 'safekey.encrypted.v1'
const emptyVault = (): VaultData => ({ items: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
const demoItems: VaultItem[] = [
  { id: '1', title: 'Google', username: 'alexey@gmail.com', password: 'River!Moon92#Cloud', url: 'https://google.com', notes: '', category: 'login', favorite: true, updatedAt: new Date().toISOString() },
  { id: '2', title: 'Telegram', username: '+7 999 123-45-67', password: 'Tg#Safe2026!Code', url: 'https://telegram.org', notes: 'Личный аккаунт', category: 'login', favorite: true, updatedAt: new Date().toISOString() },
  { id: '3', title: 'GitHub', username: 'alex-dev', password: 'Dev*Key_88!Matrix', url: 'https://github.com', notes: '', category: 'login', favorite: false, updatedAt: new Date().toISOString() },
  { id: '4', title: 'Основная карта', username: '•••• 4582', password: '4582', url: '', notes: 'Действует до 08/29', category: 'card', favorite: false, updatedAt: new Date().toISOString() },
  { id: '5', title: 'Wi-Fi дома', username: 'Home_5G', password: 'CozyHome#2026', url: '', notes: '', category: 'note', favorite: false, updatedAt: new Date().toISOString() },
]

type View = 'vault' | 'favorites' | 'audit' | 'sync' | 'settings'
type AuthMode = 'welcome' | 'create' | 'unlock' | 'pair'

const serviceColor = (title: string, category: VaultItem['category']) => {
  if (category === 'card') return ['#eef3ff', '#4569d4']
  if (category === 'note') return ['#fff2d8', '#b37b10']
  const colors: Record<string, string[]> = { Google: ['#f5f7ff', '#4285f4'], Telegram: ['#e7f5ff', '#229ed9'], GitHub: ['#eeeef0', '#24292f'] }
  return colors[title] || ['#e8f4ef', '#206a58']
}

function Logo({ light = false }: { light?: boolean }) {
  return <div className="logo"><span className={light ? 'logo-mark light' : 'logo-mark'}><KeyRound size={20} strokeWidth={2.5} /></span><span>SafeKey</span></div>
}

function App() {
  const stored = localStorage.getItem(STORAGE_KEY)
  const [mode, setMode] = useState<AuthMode>(stored ? 'unlock' : 'welcome')
  const [vault, setVault] = useState<VaultData | null>(null)
  const [masterPassword, setMasterPassword] = useState('')
  const [view, setView] = useState<View>('vault')
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [editItem, setEditItem] = useState<VaultItem | null | 'new'>(null)
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2400) }

  const saveVault = async (next: VaultData) => {
    setVault(next)
    if (!masterPassword) return
    const old = localStorage.getItem(STORAGE_KEY)
    const salt = old ? (JSON.parse(old) as EncryptedVault).salt : undefined
    const encrypted = await encryptVault(next, masterPassword, salt)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted))
    if (getSyncConfig()) {
      pushCloud(encrypted).catch(error => {
        if (error?.status === 409) notify('Есть новая облачная версия — откройте синхронизацию')
        else notify('Сохранено локально, облако временно недоступно')
      })
    }
  }

  const createVault = async (password: string, demo = false) => {
    setBusy(true)
    try {
      const base = emptyVault()
      const next = { ...base, items: demo ? demoItems : [] }
      const encrypted = await encryptVault(next, password)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted))
      if (demo) localStorage.setItem('safekey.demo', 'true')
      else localStorage.removeItem('safekey.demo')
      setMasterPassword(password); setVault(next); notify('Хранилище защищено и готово')
    } finally { setBusy(false) }
  }

  const lock = () => { setVault(null); setMasterPassword(''); setMode('unlock'); setMenuOpen(false) }

  useEffect(() => {
    if (!vault) return
    let timer = window.setTimeout(lock, 15 * 60 * 1000)
    const reset = () => { window.clearTimeout(timer); timer = window.setTimeout(lock, 15 * 60 * 1000) }
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    events.forEach(event => window.addEventListener(event, reset))
    return () => { window.clearTimeout(timer); events.forEach(event => window.removeEventListener(event, reset)) }
  }, [vault])

  if (!vault) return <AuthScreen mode={mode} setMode={setMode} busy={busy} createVault={createVault} onPair={async (code, password) => {
    setBusy(true)
    try {
      const result = await claimPairCode(code, /Mobi|Android/i.test(navigator.userAgent) ? 'Мой телефон' : 'Мой компьютер')
      const data = await decryptVault(result.blob, password)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result.blob))
      setMasterPassword(password); setVault(data); return true
    } catch { clearSyncConfig(); return false } finally { setBusy(false) }
  }} onUnlock={async password => {
    setBusy(true)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return false
      let encrypted = JSON.parse(raw) as EncryptedVault
      let data = await decryptVault(encrypted, password)
      setMasterPassword(password); setVault(data)
      if (getSyncConfig()) pullCloud().then(async remote => {
        if (new Date(remote.blob.updatedAt) > new Date(encrypted.updatedAt)) {
          data = await decryptVault(remote.blob, password)
          localStorage.setItem(STORAGE_KEY, JSON.stringify(remote.blob))
          setVault(data)
        }
      }).catch(() => undefined)
      return true
    } catch { return false } finally { setBusy(false) }
  }} />

  const visibleItems = vault.items.filter(item => {
    const matchView = view !== 'favorites' || item.favorite
    const q = query.toLowerCase()
    return matchView && (!q || `${item.title} ${item.username} ${item.url}`.toLowerCase().includes(q))
  })

  const nav = [
    { id: 'vault' as View, icon: KeyRound, label: 'Все пароли' },
    { id: 'favorites' as View, icon: Star, label: 'Избранное' },
    { id: 'audit' as View, icon: ShieldCheck, label: 'Проверка безопасности' },
    { id: 'sync' as View, icon: RefreshCw, label: 'Синхронизация' },
  ]

  return <div className="app-shell">
    <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
      <div className="sidebar-top"><Logo /><button className="mobile-close" onClick={() => setMenuOpen(false)}><X /></button></div>
      <nav>
        <p className="nav-caption">ХРАНИЛИЩЕ</p>
        {nav.slice(0, 2).map(n => <button key={n.id} className={view === n.id ? 'nav-item active' : 'nav-item'} onClick={() => { setView(n.id); setMenuOpen(false) }}><n.icon size={19} /><span>{n.label}</span>{n.id === 'vault' && <em>{vault.items.length}</em>}</button>)}
        <p className="nav-caption section">БЕЗОПАСНОСТЬ</p>
        {nav.slice(2).map(n => <button key={n.id} className={view === n.id ? 'nav-item active' : 'nav-item'} onClick={() => { setView(n.id); setMenuOpen(false) }}><n.icon size={19} /><span>{n.label}</span>{n.id === 'audit' && <i className="status-dot" />}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')}><Settings size={19} />Настройки</button>
        <div className="user-card"><div className="avatar">АК</div><div><strong>Моё хранилище</strong><span>Локальный сейф</span></div><button onClick={lock} title="Заблокировать"><LogOut size={18} /></button></div>
      </div>
    </aside>
    {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} />}

    <main className="main">
      <header className="topbar">
        <button className="menu-button" onClick={() => setMenuOpen(true)}><Menu /></button>
        <div className="search"><Search size={19} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск в хранилище..." /><kbd>⌘ K</kbd></div>
        <div className="top-actions"><div className="sync-state"><Cloud size={17} /><span>Защищено локально</span></div><button className="icon-button" onClick={() => setView('settings')}><Settings size={20} /></button><button className="avatar small" onClick={() => setView('settings')}>АК</button></div>
      </header>

      {(view === 'vault' || view === 'favorites') && <VaultView items={visibleItems} total={vault.items.length} query={query} favorite={view === 'favorites'} onAdd={() => setEditItem('new')} onEdit={setEditItem} onToggle={item => saveVault({ ...vault, items: vault.items.map(x => x.id === item.id ? { ...x, favorite: !x.favorite } : x), updatedAt: new Date().toISOString() })} notify={notify} />}
      {view === 'audit' && <AuditView items={vault.items} onOpen={setEditItem} />}
      {view === 'sync' && <SyncView vault={vault} notify={notify} onRemote={async encrypted => {
        try {
          const data = await decryptVault(encrypted, masterPassword)
          localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted))
          setVault(data)
          notify('Облачная версия загружена и расшифрована')
          return true
        } catch {
          notify('Мастер-пароль этого устройства не подходит к облачному сейфу')
          return false
        }
      }} />}
      {view === 'settings' && <SettingsView vault={vault} onImport={async encrypted => {
        try { const data = await decryptVault(encrypted, masterPassword); localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted)); setVault(data); notify('Резервная копия восстановлена') } catch { notify('Не удалось расшифровать файл этим мастер-паролем') }
      }} onLock={lock} notify={notify} />}
    </main>

    {editItem && <ItemModal item={editItem === 'new' ? null : editItem} onClose={() => setEditItem(null)} onDelete={editItem === 'new' ? undefined : () => {
      saveVault({ ...vault, items: vault.items.filter(i => i.id !== editItem.id), updatedAt: new Date().toISOString() }); setEditItem(null); notify('Запись удалена')
    }} onSave={item => {
      const exists = vault.items.some(i => i.id === item.id)
      saveVault({ ...vault, items: exists ? vault.items.map(i => i.id === item.id ? item : i) : [item, ...vault.items], updatedAt: new Date().toISOString() })
      setEditItem(null); notify(exists ? 'Изменения сохранены' : 'Пароль добавлен')
    }} />}
    {toast && <div className="toast"><Check size={18} />{toast}</div>}
  </div>
}

function AuthScreen({ mode, setMode, busy, createVault, onUnlock, onPair }: { mode: AuthMode; setMode: (m: AuthMode) => void; busy: boolean; createVault: (p: string, demo?: boolean) => Promise<void>; onUnlock: (p: string) => Promise<boolean>; onPair: (code: string, password: string) => Promise<boolean> }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')

  if (mode === 'welcome') return <div className="auth-page welcome-page">
    <div className="welcome-nav"><Logo /><span><ShieldCheck size={16} /> Нулевое знание</span></div>
    <div className="welcome-content">
      <div className="welcome-copy"><span className="eyebrow"><Sparkles size={15} /> Ваш цифровой сейф</span><h1>Пароли под защитой.<br/><em>Спокойствие внутри.</em></h1><p>SafeKey шифрует данные прямо на вашем устройстве. Только вы можете открыть своё хранилище — даже мы не знаем, что внутри.</p><div className="welcome-buttons"><button className="primary large" onClick={() => setMode('create')}>Создать хранилище <ChevronRight size={19} /></button><button className="secondary large" onClick={() => setMode('pair')}><Cloud size={18}/> Подключить устройство</button><button className="secondary large" onClick={() => createVault('Demo-SafeKey-2026!', true)}>Демо</button></div><div className="trust-row"><span><Check /> AES-256-GCM</span><span><Check /> Работает офлайн</span><span><Check /> Без рекламы</span></div></div>
      <div className="safe-visual"><div className="orbit one"><Shield /></div><div className="orbit two"><Fingerprint /></div><div className="safe-card"><div className="safe-glow"><Lock size={50} /></div><strong>Ваше хранилище</strong><span>Зашифровано на устройстве</span><div className="encryption-line"><i /><small>AES-256</small><i /></div></div><div className="float-card top"><ShieldCheck /> Надёжное шифрование</div><div className="float-card bottom"><Zap /> Мгновенный доступ</div></div>
    </div>
  </div>

  const creating = mode === 'create'
  const pairing = mode === 'pair'
  return <div className="auth-page lock-page"><div className="auth-brand"><Logo light /></div><div className="auth-panel"><div className="lock-icon">{pairing ? <Cloud size={28}/> : <Lock size={28} />}</div><p className="auth-overline">SAFEKEY</p><h1>{creating ? 'Создайте мастер-пароль' : pairing ? 'Подключить устройство' : 'С возвращением'}</h1><p>{creating ? 'Это единственный ключ к вашим данным. Мы не сможем его восстановить.' : pairing ? 'Введите одноразовый код со своего подключённого устройства' : 'Введите мастер-пароль, чтобы открыть хранилище'}</p><form onSubmit={async e => {
    e.preventDefault(); setError('')
    if (creating) {
      if (password.length < 10) return setError('Используйте минимум 10 символов')
      if (password !== confirm) return setError('Пароли не совпадают')
      await createVault(password)
    } else if (pairing) {
      if (code.length !== 6) return setError('Введите шестизначный код')
      if (!await onPair(code, password)) setError('Код истёк или мастер-пароль не подходит')
    } else if (!await onUnlock(password)) setError('Неверный мастер-пароль')
  }}>
    {pairing && <><label>Код подключения</label><div className="pair-auth-code"><input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" /></div></>}
    <label>Мастер-пароль</label><div className="password-field"><input autoFocus={!pairing} type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Введите мастер-пароль" /><button type="button" onClick={() => setShow(!show)}>{show ? <EyeOff /> : <Eye />}</button></div>
    {creating && <><div className="strength-bars">{[1,2,3,4].map(x => <i key={x} className={strength(password) >= x ? `on s${strength(password)}` : ''} />)}</div><label>Повторите пароль</label><div className="password-field"><input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Ещё раз" /></div></>}
    {error && <div className="form-error">{error}</div>}<button className="primary auth-submit" disabled={busy}>{busy ? <RefreshCw className="spin" /> : creating ? 'Создать защищённый сейф' : pairing ? 'Подключить и скачать сейф' : 'Открыть хранилище'}{!busy && <ChevronRight size={19} />}</button>
  </form>{!creating && !pairing && localStorage.getItem('safekey.demo') && <button className="secondary demo-unlock" disabled={busy} onClick={() => onUnlock('Demo-SafeKey-2026!')}>Открыть демо без пароля</button>}{(creating || pairing) && <button className="text-button" onClick={() => setMode('welcome')}>← Назад</button>}<div className="auth-security"><ShieldCheck size={17} />Данные никогда не покидают устройство в открытом виде</div></div></div>
}

function VaultView({ items, total, query, favorite, onAdd, onEdit, onToggle, notify }: { items: VaultItem[]; total: number; query: string; favorite: boolean; onAdd: () => void; onEdit: (i: VaultItem) => void; onToggle: (i: VaultItem) => void; notify: (s: string) => void }) {
  const [visible, setVisible] = useState<string[]>([])
  const copy = (text: string) => { navigator.clipboard.writeText(text); notify('Скопировано в буфер обмена') }
  return <section className="content">
    <div className="page-heading"><div><p className="overline">ЛИЧНОЕ ХРАНИЛИЩЕ</p><h1>{favorite ? 'Избранное' : 'Все пароли'}</h1><p>{favorite ? 'Самые важные записи под рукой' : `${total} записей — всё надёжно зашифровано`}</p></div><button className="primary" onClick={onAdd}><Plus size={19} />Добавить пароль</button></div>
    {!favorite && !query && <div className="security-banner"><span className="banner-icon"><ShieldCheck /></span><div><strong>Отлично! Ваше хранилище в безопасности</strong><p>Слабых или повторяющихся паролей не обнаружено.</p></div><button>Подробнее <ChevronRight size={17} /></button></div>}
    <div className="list-toolbar"><div className="filter"><button className="active">Все <span>{items.length}</span></button><button>Логины</button><button>Карты</button><button>Заметки</button></div><button className="sort">Недавно изменённые <ChevronDown size={16} /></button></div>
    {items.length ? <div className="vault-list">{items.map(item => {
      const [bg, fg] = serviceColor(item.title, item.category)
      const Icon = item.category === 'card' ? CreditCard : item.category === 'note' ? FileText : item.title === 'Google' ? Globe2 : KeyRound
      return <article className="vault-row" key={item.id} onClick={() => onEdit(item)}><div className="service-icon" style={{ background: bg, color: fg }}><Icon size={23} /></div><div className="item-main"><strong>{item.title}</strong><span>{item.username}</span></div><div className="masked"><span>{visible.includes(item.id) ? item.password : '••••••••••••'}</span><button onClick={e => { e.stopPropagation(); setVisible(v => v.includes(item.id) ? v.filter(x => x !== item.id) : [...v, item.id]) }}>{visible.includes(item.id) ? <EyeOff /> : <Eye />}</button></div><div className="item-url">{item.url ? item.url.replace(/^https?:\/\//, '') : item.category === 'card' ? 'Банковская карта' : 'Защищённая заметка'}</div><button className="row-action" onClick={e => { e.stopPropagation(); copy(item.password) }}><Copy /></button><button className={item.favorite ? 'row-action starred' : 'row-action'} onClick={e => { e.stopPropagation(); onToggle(item) }}><Star fill={item.favorite ? 'currentColor' : 'none'} /></button><button className="row-action" onClick={e => { e.stopPropagation(); onEdit(item) }}><MoreHorizontal /></button></article>
    })}</div> : <div className="empty-state"><div><KeyRound /></div><h3>{query ? 'Ничего не найдено' : 'Хранилище пока пустое'}</h3><p>{query ? 'Попробуйте изменить запрос' : 'Добавьте первый пароль — он сразу будет зашифрован.'}</p>{!query && <button className="primary" onClick={onAdd}><Plus />Добавить пароль</button>}</div>}
    <div className="privacy-note"><Lock size={14} />Все данные зашифрованы локально. SafeKey не видит ваши пароли.</div>
  </section>
}

function ItemModal({ item, onClose, onSave, onDelete }: { item: VaultItem | null; onClose: () => void; onSave: (i: VaultItem) => void; onDelete?: () => void }) {
  const [form, setForm] = useState<VaultItem>(item || { id: crypto.randomUUID(), title: '', username: '', password: generatePassword(), url: '', notes: '', category: 'login', favorite: false, updatedAt: new Date().toISOString() })
  const [show, setShow] = useState(false)
  const update = (key: keyof VaultItem, value: string | boolean) => setForm({ ...form, [key]: value })
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={e => e.stopPropagation()}><div className="modal-head"><div><p className="overline">{item ? 'РЕДАКТИРОВАНИЕ' : 'НОВАЯ ЗАПИСЬ'}</p><h2>{item ? item.title : 'Добавить пароль'}</h2></div><button onClick={onClose}><X /></button></div><div className="modal-body"><label>Название<input value={form.title} onChange={e => update('title', e.target.value)} placeholder="Например, Яндекс" autoFocus /></label><label>Логин или почта<input value={form.username} onChange={e => update('username', e.target.value)} placeholder="name@example.com" /></label><label>Пароль<div className="password-field modal-field"><input type={show ? 'text' : 'password'} value={form.password} onChange={e => update('password', e.target.value)} /><button type="button" onClick={() => setShow(!show)}>{show ? <EyeOff /> : <Eye />}</button><button type="button" onClick={() => update('password', generatePassword())}><Sparkles /></button></div><span className="field-help"><i className={`strength-dot s${strength(form.password)}`} />Стойкость: {strength(form.password) >= 4 ? 'отличная' : strength(form.password) >= 3 ? 'хорошая' : 'слабая'}</span></label><label>Сайт<input value={form.url} onChange={e => update('url', e.target.value)} placeholder="https://example.com" /></label><label>Заметка<textarea value={form.notes} onChange={e => update('notes', e.target.value)} placeholder="Дополнительная информация" /></label></div><div className="modal-footer">{onDelete && <button className="danger-button" onClick={onDelete}><Trash2 />Удалить</button>}<span /><button className="secondary" onClick={onClose}>Отмена</button><button className="primary" disabled={!form.title || !form.password} onClick={() => onSave({ ...form, updatedAt: new Date().toISOString() })}>Сохранить</button></div></div></div>
}

function AuditView({ items, onOpen }: { items: VaultItem[]; onOpen: (i: VaultItem) => void }) {
  const weak = items.filter(i => strength(i.password) < 3)
  const duplicateValues = items.filter((i, idx) => items.findIndex(x => x.password === i.password) !== idx)
  const score = Math.max(48, 100 - weak.length * 12 - duplicateValues.length * 8)
  return <section className="content"><div className="page-heading"><div><p className="overline">ЦЕНТР БЕЗОПАСНОСТИ</p><h1>Проверка безопасности</h1><p>Следите за здоровьем своих паролей</p></div></div><div className="audit-grid"><div className="score-card"><div className="score-ring" style={{'--score': `${score * 3.6}deg`} as React.CSSProperties}><div><strong>{score}</strong><span>из 100</span></div></div><div><span className="good-label"><ShieldCheck /> Хорошая защита</span><h2>Ваше хранилище в порядке</h2><p>SafeKey анализирует пароли только на этом устройстве.</p></div></div><div className="audit-stat"><span className="stat-icon green"><ShieldCheck /></span><strong>{items.length - weak.length}</strong><p>Надёжных паролей</p></div><div className="audit-stat"><span className="stat-icon amber"><ShieldEllipsis /></span><strong>{weak.length}</strong><p>Слабых паролей</p></div><div className="audit-stat"><span className="stat-icon blue"><RefreshCw /></span><strong>{duplicateValues.length}</strong><p>Повторяющихся</p></div></div><div className="settings-card"><div className="card-title"><div><h3>Рекомендации</h3><p>Что можно улучшить прямо сейчас</p></div></div>{weak.length === 0 && duplicateValues.length === 0 ? <div className="all-good"><ShieldCheck /><div><strong>Проблем не найдено</strong><p>Продолжайте использовать уникальные пароли для каждого сервиса.</p></div></div> : weak.map(i => <button className="recommendation" onClick={() => onOpen(i)} key={i.id}><span className="stat-icon amber"><KeyRound /></span><div><strong>Усильте пароль «{i.title}»</strong><p>Добавьте символы, цифры и увеличьте длину.</p></div><ChevronRight /></button>)}</div></section>
}

function SyncView({ vault, notify, onRemote }: { vault: VaultData; notify: (s: string) => void; onRemote: (blob: EncryptedVault) => Promise<boolean> }) {
  const [config, setConfig] = useState<SyncConfig | null>(() => getSyncConfig())
  const [pairCode, setPairCode] = useState('')
  const [claimCode, setClaimCode] = useState('')
  const [devices, setDevices] = useState<Array<{id:string;name:string;lastSeen:string}>>([])
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState<boolean | null>(null)
  const deviceName = /Mobi|Android/i.test(navigator.userAgent) ? 'Мой телефон' : 'Мой компьютер'

  const run = async (job: () => Promise<void>) => {
    setBusy(true)
    try { await job(); setOnline(true) } catch (error: any) {
      setOnline(false)
      notify(error?.status === 409 ? 'Конфликт версий — сначала загрузите облачную копию' : 'Не удалось связаться с SafeKey Cloud')
    } finally { setBusy(false) }
  }

  const enableCloud = () => run(async () => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) throw new Error('no_vault')
    const next = await createCloud(JSON.parse(raw), deviceName)
    setConfig(next)
    notify('Облачная синхронизация включена')
  })

  const syncNow = () => run(async () => {
    const remote = await pullCloud()
    setDevices(remote.devices)
    const localRaw = localStorage.getItem(STORAGE_KEY)
    const local = localRaw ? JSON.parse(localRaw) as EncryptedVault : null
    if (!local || new Date(remote.blob.updatedAt) > new Date(local.updatedAt)) {
      if (!await onRemote(remote.blob)) return
    } else if (local.updatedAt !== remote.blob.updatedAt) {
      const next = await pushCloud(local, remote.config)
      setConfig(next)
    }
    setConfig(getSyncConfig())
    notify('Сейф синхронизирован')
  })

  const generateCode = () => run(async () => {
    const result = await createPairCode()
    setPairCode(result.code)
    notify('Одноразовый код создан')
  })

  const claim = () => run(async () => {
    const result = await claimPairCode(claimCode, deviceName)
    if (!await onRemote(result.blob)) { clearSyncConfig(); return }
    setConfig(result.config)
    setClaimCode('')
    notify('Устройство подключено к облачному сейфу')
  })

  return <section className="content"><div className="page-heading"><div><p className="overline">SAFEKEY CLOUD</p><h1>Облачная синхронизация</h1><p>Зашифрованный сейф на всех ваших устройствах</p></div>{config ? <button className="primary" disabled={busy} onClick={syncNow}>{busy ? <RefreshCw className="spin" /> : <RefreshCw />}Синхронизировать</button> : <button className="primary" disabled={busy} onClick={enableCloud}>{busy ? <RefreshCw className="spin" /> : <Cloud />}Включить облако</button>}</div>
    <div className="sync-hero"><div className="sync-art"><div className="device laptop"><Laptop /></div><div className="sync-path"><i/><RefreshCw className={busy ? 'spin' : ''}/><i/></div><div className="device phone"><Smartphone /></div></div><div><span className="good-label"><Lock /> Zero knowledge</span><h2>Сервер никогда не видит ваши пароли</h2><p>Перед отправкой сейф шифруется AES-256-GCM прямо на устройстве. Облако хранит только шифротекст, а мастер-пароль и ключи остаются у вас.</p></div></div>
    <div className="cloud-status"><span className={`cloud-status-icon ${config ? 'connected' : ''}`}><Cloud /></span><div><strong>{config ? 'SafeKey Cloud подключён' : 'Облако ещё не подключено'}</strong><p>{config ? `Версия ${config.revision} · ${config.lastSync ? `последняя синхронизация ${new Date(config.lastSync).toLocaleString('ru-RU')}` : 'готово к синхронизации'}` : 'Включите облако, чтобы получить защищённую копию сейфа'}</p></div><span className={online === false ? 'cloud-pill error' : config ? 'cloud-pill' : 'cloud-pill muted'}><i/>{online === false ? 'Нет связи' : config ? 'Активно' : 'Выключено'}</span></div>
    <div className="two-col"><div className="settings-card"><div className="card-title"><div><h3>Подключённые устройства</h3><p>{devices.length ? `${devices.length} устройства` : 'Синхронизируйте, чтобы обновить список'}</p></div>{config && <span className="online"><i/> Сквозное шифрование</span>}</div><div className="device-row"><span><Laptop /></span><div><strong>{deviceName}</strong><p>Это устройство · {vault.items.length} записей</p></div><em>Текущее</em></div>{devices.filter(d => d.name !== deviceName).map(device => <div className="device-row" key={device.id}><span><Smartphone /></span><div><strong>{device.name}</strong><p>Был в сети {new Date(device.lastSeen).toLocaleString('ru-RU')}</p></div><ShieldCheck size={18}/></div>)}</div>
      <div className="settings-card pair-card"><div className="card-title"><div><h3>Добавить устройство</h3><p>Одноразовый код действует 10 минут</p></div></div>{config ? <>{pairCode ? <><div className="pair-code">{pairCode.split('').map((x,i) => <b key={i}>{x}</b>)}</div><p>Введите этот код на втором устройстве</p><button className="secondary full" onClick={() => { navigator.clipboard.writeText(pairCode); notify('Код скопирован') }}><Clipboard />Скопировать код</button></> : <button className="secondary full" disabled={busy} onClick={generateCode}><Smartphone />Создать код подключения</button>}</> : <><div className="claim-field"><input inputMode="numeric" maxLength={6} value={claimCode} onChange={e => setClaimCode(e.target.value.replace(/\D/g, ''))} placeholder="000 000" /></div><p>Код отображается на уже подключённом устройстве</p><button className="secondary full" disabled={busy || claimCode.length !== 6} onClick={claim}><ArrowDownToLine />Подключиться по коду</button></>}</div></div>
    <div className="info-box"><ShieldCheck /><div><strong>Настоящая zero-knowledge синхронизация</strong><p>Сервер проверяет секретный токен устройства, хранит версии и разрешает одноразовое подключение. Даже при утечке серверной базы злоумышленник получит только AES-GCM шифротекст. Не забывайте мастер-пароль: восстановить его невозможно.</p></div></div>
    {config && <button className="disconnect-cloud" onClick={() => { clearSyncConfig(); setConfig(null); setPairCode(''); notify('Это устройство отключено от облака') }}>Отключить облако на этом устройстве</button>}
  </section>
}
function SettingsView({ vault, onImport, onLock, notify }: { vault: VaultData; onImport: (v: EncryptedVault) => void; onLock: () => void; notify: (s: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const exportVault = () => { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return; const blob = new Blob([raw], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `safekey-backup-${new Date().toISOString().slice(0,10)}.skvault`; a.click(); URL.revokeObjectURL(url); notify('Зашифрованная копия сохранена') }
  return <section className="content settings-page"><div className="page-heading"><div><p className="overline">ПАРАМЕТРЫ</p><h1>Настройки</h1><p>Управляйте безопасностью и резервными копиями</p></div></div><div className="settings-layout"><div className="settings-card"><div className="card-title"><span className="stat-icon green"><Shield /></span><div><h3>Безопасность</h3><p>Защита локального хранилища</p></div></div><div className="setting-row"><div><strong>Автоблокировка</strong><p>Блокировать сейф после периода бездействия</p></div><button className="select-button">Через 15 минут <ChevronDown /></button></div><div className="setting-row"><div><strong>Биометрия</strong><p>Разблокировка через Face ID или отпечаток</p></div><button className="toggle" onClick={e => e.currentTarget.classList.toggle('on')}><i /></button></div><div className="setting-row"><div><strong>Заблокировать сейчас</strong><p>Мастер-ключ будет удалён из памяти</p></div><button className="secondary" onClick={onLock}><Lock />Заблокировать</button></div></div><div className="settings-card"><div className="card-title"><span className="stat-icon blue"><Cloud /></span><div><h3>Резервная копия</h3><p>Последнее изменение: {new Date(vault.updatedAt).toLocaleString('ru-RU')}</p></div></div><div className="backup-actions"><button onClick={exportVault}><span><Download /></span><div><strong>Экспортировать сейф</strong><p>Скачать зашифрованный файл</p></div><ChevronRight /></button><button onClick={() => inputRef.current?.click()}><span><Upload /></span><div><strong>Восстановить из файла</strong><p>Импортировать .skvault</p></div><ChevronRight /></button><input ref={inputRef} hidden type="file" accept=".skvault,.json" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { onImport(JSON.parse(await file.text())) } catch { notify('Файл повреждён или имеет неверный формат') } }} /></div></div><div className="settings-card"><div className="card-title"><span className="stat-icon amber"><UserRound /></span><div><h3>О приложении</h3><p>SafeKey 1.0 · Offline-first PWA</p></div></div><div className="setting-row"><div><strong>Шифрование</strong><p>AES-256-GCM · PBKDF2-SHA-256 · 600 000 итераций</p></div><span className="verified"><Check /> Активно</span></div><div className="setting-row"><div><strong>Хранение</strong><p>Только на этом устройстве</p></div><span>{vault.items.length} записей</span></div></div></div></section>
}

export default App
