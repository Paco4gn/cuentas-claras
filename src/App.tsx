import { useEffect, useMemo, useState } from 'react'
import Dexie, { type Table } from 'dexie'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  Download,
  LogOut,
  Plus,
  ReceiptText,
  Search,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  Users,
  WalletCards,
} from 'lucide-react'
import './App.css'

type ActorId = 'me' | string
type RecordKind = 'split' | 'debt' | 'payment'
type RecordStatus = 'por-pagar' | 'parcial' | 'pagado'
type DebtDirection = 'owes_me' | 'i_owe'
type PaymentDirection = 'person_paid_me' | 'i_paid_person'
type Tab = 'resumen' | 'nuevo' | 'personas' | 'historial'

interface User {
  id: string
  name: string
  email: string
  passwordHash: string
  salt: string
  createdAt: string
}

interface Person {
  id: string
  userId: string
  name: string
  phone: string
  email: string
  notes: string
  createdAt: string
}

interface LedgerRecord {
  id: string
  userId: string
  kind: RecordKind
  title: string
  amount: number
  currency: 'EUR'
  date: string
  paidBy?: ActorId
  participantIds?: ActorId[]
  shares?: Record<string, number>
  personId?: string
  direction?: DebtDirection | PaymentDirection
  tags: string[]
  status: RecordStatus
  note: string
  createdAt: string
}

interface ImportPayload {
  people?: Person[]
  persons?: Person[]
  records?: LedgerRecord[]
}

class CuentaDb extends Dexie {
  users!: Table<User, string>
  persons!: Table<Person, string>
  records!: Table<LedgerRecord, string>

  constructor() {
    super('cuentas-claras-db')
    this.version(1).stores({
      users: 'id, &email',
      persons: 'id, userId, name',
      records: 'id, userId, date, kind, status',
    })
  }
}

const db = new CuentaDb()
const sessionKey = 'cuentas-claras-session'
const today = new Date().toISOString().slice(0, 10)
const me: ActorId = 'me'

const formatMoney = (value: number) =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value)

const uid = () => crypto.randomUUID()

async function hashPassword(password: string, salt: string) {
  const payload = new TextEncoder().encode(`${salt}:${password}`)
  const digest = await crypto.subtle.digest('SHA-256', payload)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function tagsFromText(value: string) {
  return value
    .split(',')
    .map((tagValue) => tagValue.trim())
    .filter(Boolean)
}

function computeSignedByPerson(record: LedgerRecord) {
  const signed = new Map<string, number>()
  const add = (personId: string, value: number) => {
    signed.set(personId, (signed.get(personId) ?? 0) + value)
  }

  if (record.kind === 'debt' && record.personId) {
    add(record.personId, record.direction === 'owes_me' ? record.amount : -record.amount)
  }

  if (record.kind === 'payment' && record.personId) {
    add(record.personId, record.direction === 'person_paid_me' ? -record.amount : record.amount)
  }

  if (record.kind === 'split' && record.paidBy && record.participantIds && record.shares) {
    if (record.paidBy === me) {
      record.participantIds.forEach((participantId) => {
        if (participantId !== me) add(participantId, record.shares?.[participantId] ?? 0)
      })
    } else if (record.participantIds.includes(me)) {
      add(record.paidBy, -(record.shares[me] ?? 0))
    }
  }

  return signed
}

function emptyShares(people: Person[]) {
  return Object.fromEntries([me, ...people.map((person) => person.id)].map((id) => [id, 0]))
}

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [people, setPeople] = useState<Person[]>([])
  const [records, setRecords] = useState<LedgerRecord[]>([])
  const [tab, setTab] = useState<Tab>('resumen')
  const [query, setQuery] = useState('')
  const [personForm, setPersonForm] = useState({ name: '', phone: '', email: '', notes: '' })
  const [kind, setKind] = useState<RecordKind>('split')
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today)
  const [paidBy, setPaidBy] = useState<ActorId>(me)
  const [participantIds, setParticipantIds] = useState<ActorId[]>([me])
  const [shares, setShares] = useState<Record<string, number>>({})
  const [personId, setPersonId] = useState('')
  const [debtDirection, setDebtDirection] = useState<DebtDirection>('owes_me')
  const [paymentDirection, setPaymentDirection] = useState<PaymentDirection>('person_paid_me')
  const [status, setStatus] = useState<RecordStatus>('por-pagar')
  const [tagText, setTagText] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    const sessionId = localStorage.getItem(sessionKey)
    if (!sessionId) return
    db.users.get(sessionId).then((storedUser) => {
      if (storedUser) setCurrentUser(storedUser)
    })
  }, [])

  useEffect(() => {
    if (!currentUser) return
    Promise.all([
      db.persons.where('userId').equals(currentUser.id).sortBy('name'),
      db.records.where('userId').equals(currentUser.id).reverse().sortBy('date'),
    ]).then(([storedPeople, storedRecords]) => {
      setPeople(storedPeople)
      setRecords(storedRecords.reverse())
      if (!personId && storedPeople[0]) setPersonId(storedPeople[0].id)
      setShares(emptyShares(storedPeople))
    })
  }, [currentUser, personId])

  const balances = useMemo(() => {
    const map = new Map<string, number>()
    records.forEach((record) => {
      computeSignedByPerson(record).forEach((value, id) => {
        map.set(id, (map.get(id) ?? 0) + value)
      })
    })
    return map
  }, [records])

  const summary = useMemo(() => {
    const values = [...balances.values()]
    const owedToMe = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0)
    const owedByMe = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0))
    return { owedToMe, owedByMe, net: owedToMe - owedByMe }
  }, [balances])

  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return records
    return records.filter((record) => {
      const person = people.find((candidate) => candidate.id === record.personId)
      return [record.title, record.note, person?.name, ...record.tags]
        .join(' ')
        .toLowerCase()
        .includes(normalized)
    })
  }, [people, query, records])

  const sortedPeople = useMemo(
    () => [...people].sort((a, b) => Math.abs(balances.get(b.id) ?? 0) - Math.abs(balances.get(a.id) ?? 0)),
    [balances, people],
  )

  const firstPersonId = people[0]?.id ?? ''

  async function refreshData(userId = currentUser?.id) {
    if (!userId) return
    const [storedPeople, storedRecords] = await Promise.all([
      db.persons.where('userId').equals(userId).sortBy('name'),
      db.records.where('userId').equals(userId).reverse().sortBy('date'),
    ])
    setPeople(storedPeople)
    setRecords(storedRecords.reverse())
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')
    const email = authEmail.trim().toLowerCase()
    const password = authPassword.trim()
    if (!email || !password || (authMode === 'register' && !authName.trim())) {
      setAuthError('Completa los campos obligatorios.')
      return
    }

    if (authMode === 'register') {
      const exists = await db.users.where('email').equals(email).first()
      if (exists) {
        setAuthError('Ya existe una cuenta con ese email.')
        return
      }
      const salt = uid()
      const user: User = {
        id: uid(),
        name: authName.trim(),
        email,
        passwordHash: await hashPassword(password, salt),
        salt,
        createdAt: new Date().toISOString(),
      }
      await db.users.add(user)
      localStorage.setItem(sessionKey, user.id)
      setCurrentUser(user)
      return
    }

    const user = await db.users.where('email').equals(email).first()
    if (!user || user.passwordHash !== (await hashPassword(password, user.salt))) {
      setAuthError('Email o contraseña incorrectos.')
      return
    }
    localStorage.setItem(sessionKey, user.id)
    setCurrentUser(user)
  }

  async function addPerson(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser || !personForm.name.trim()) return
    const person: Person = {
      id: uid(),
      userId: currentUser.id,
      name: personForm.name.trim(),
      phone: personForm.phone.trim(),
      email: personForm.email.trim(),
      notes: personForm.notes.trim(),
      createdAt: new Date().toISOString(),
    }
    await db.persons.add(person)
    setPersonForm({ name: '', phone: '', email: '', notes: '' })
    setPersonId(person.id)
    setParticipantIds((current) => [...new Set([...current, person.id])])
    await refreshData()
  }

  function splitEqually() {
    const value = Number(amount)
    if (!value || participantIds.length === 0) return
    const share = Number((value / participantIds.length).toFixed(2))
    const nextShares = { ...shares }
    participantIds.forEach((id, index) => {
      const lastAdjustment = index === participantIds.length - 1 ? value - share * participantIds.length : 0
      nextShares[id] = Number((share + lastAdjustment).toFixed(2))
    })
    setShares(nextShares)
  }

  async function addRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser) return
    const numericAmount = Number(amount)
    if (!title.trim() || !numericAmount || numericAmount <= 0) return

    const record: LedgerRecord = {
      id: uid(),
      userId: currentUser.id,
      kind,
      title: title.trim(),
      amount: numericAmount,
      currency: 'EUR',
      date,
      tags: tagsFromText(tagText),
      status,
      note: note.trim(),
      createdAt: new Date().toISOString(),
    }

    if (kind === 'split') {
      record.paidBy = paidBy
      record.participantIds = participantIds
      record.shares = participantIds.reduce<Record<string, number>>((accumulator, id) => {
        accumulator[id] = Number(shares[id] ?? 0)
        return accumulator
      }, {})
    } else {
      record.personId = personId || firstPersonId
      record.direction = kind === 'debt' ? debtDirection : paymentDirection
    }

    await db.records.add(record)
    setTitle('')
    setAmount('')
    setTagText('')
    setNote('')
    setStatus('por-pagar')
    setKind('split')
    setParticipantIds([me])
    setPaidBy(me)
    setShares(emptyShares(people))
    await refreshData()
    setTab('resumen')
  }

  async function deleteRecord(recordId: string) {
    await db.records.delete(recordId)
    await refreshData()
  }

  async function deletePerson(id: string) {
    const hasRecords = records.some(
      (record) =>
        record.personId === id || record.paidBy === id || record.participantIds?.includes(id),
    )
    if (hasRecords && !window.confirm('Esta persona tiene movimientos. Si la borras tambien se borraran esos movimientos.')) {
      return
    }
    await db.transaction('rw', db.persons, db.records, async () => {
      await db.persons.delete(id)
      if (hasRecords) {
        const related = records.filter(
          (record) =>
            record.personId === id || record.paidBy === id || record.participantIds?.includes(id),
        )
        await db.records.bulkDelete(related.map((record) => record.id))
      }
    })
    await refreshData()
  }

  function toggleParticipant(id: ActorId) {
    setParticipantIds((current) => {
      if (current.includes(id)) return current.filter((candidate) => candidate !== id)
      return [...current, id]
    })
  }

  function exportData() {
    if (!currentUser) return
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), people, records }, null, 2)
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `cuentas-claras-${today}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function importData(event: React.ChangeEvent<HTMLInputElement>) {
    if (!currentUser || !event.target.files?.[0]) return
    const payload = JSON.parse(await event.target.files[0].text()) as ImportPayload
    const importedPeople = (payload.persons ?? payload.people ?? []).map((person) => ({
      ...person,
      userId: currentUser.id,
    }))
    const importedRecords = (payload.records ?? []).map((record) => ({
      ...record,
      userId: currentUser.id,
    }))
    await db.transaction('rw', db.persons, db.records, async () => {
      await db.persons.bulkPut(importedPeople)
      await db.records.bulkPut(importedRecords)
    })
    await refreshData()
    event.target.value = ''
  }

  function signOut() {
    localStorage.removeItem(sessionKey)
    setCurrentUser(null)
  }

  if (!currentUser) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="brand-mark">
            <WalletCards aria-hidden="true" />
          </div>
          <h1>Cuentas claras</h1>
          <p>Deudas, gastos compartidos y pagos al dia en tu iPhone.</p>
          <div className="segmented">
            <button className={authMode === 'register' ? 'active' : ''} onClick={() => setAuthMode('register')} type="button">
              Crear cuenta
            </button>
            <button className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')} type="button">
              Entrar
            </button>
          </div>
          <form onSubmit={submitAuth} className="form-grid">
            {authMode === 'register' && (
              <label>
                Nombre
                <input value={authName} onChange={(event) => setAuthName(event.target.value)} autoComplete="name" />
              </label>
            )}
            <label>
              Email
              <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} type="email" autoComplete="email" />
            </label>
            <label>
              Contraseña
              <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} type="password" autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} />
            </label>
            {authError && <p className="error-text">{authError}</p>}
            <button className="primary-button" type="submit">
              <CheckCircle2 aria-hidden="true" />
              {authMode === 'register' ? 'Crear y entrar' : 'Entrar'}
            </button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Hola, {currentUser.name}</span>
          <h1>Cuentas claras</h1>
        </div>
        <button className="icon-button" type="button" title="Salir" onClick={signOut}>
          <LogOut aria-hidden="true" />
        </button>
      </header>

      <section className="summary-grid">
        <article className="metric positive">
          <ArrowUpRight aria-hidden="true" />
          <span>Me deben</span>
          <strong>{formatMoney(summary.owedToMe)}</strong>
        </article>
        <article className="metric negative">
          <ArrowDownLeft aria-hidden="true" />
          <span>Debo</span>
          <strong>{formatMoney(summary.owedByMe)}</strong>
        </article>
        <article className={`metric ${summary.net >= 0 ? 'positive' : 'negative'}`}>
          <CircleDollarSign aria-hidden="true" />
          <span>Saldo neto</span>
          <strong>{formatMoney(summary.net)}</strong>
        </article>
      </section>

      <nav className="tabs" aria-label="Secciones">
        {[
          ['resumen', BarChart3, 'Resumen'],
          ['nuevo', Plus, 'Nuevo'],
          ['personas', Users, 'Personas'],
          ['historial', ReceiptText, 'Historial'],
        ].map(([id, Icon, label]) => (
          <button key={id as string} className={tab === id ? 'active' : ''} onClick={() => setTab(id as Tab)} type="button">
            <Icon aria-hidden="true" />
            <span>{label as string}</span>
          </button>
        ))}
      </nav>

      {tab === 'resumen' && (
        <section className="content-grid">
          <div className="section-heading">
            <h2>Saldos</h2>
            <button className="secondary-button" type="button" onClick={() => setTab('nuevo')}>
              <Plus aria-hidden="true" />
              Movimiento
            </button>
          </div>
          <div className="person-list">
            {sortedPeople.length === 0 && <EmptyState text="Añade personas para empezar a cuadrar cuentas." />}
            {sortedPeople.map((person) => {
              const balance = balances.get(person.id) ?? 0
              return (
                <article className="person-card" key={person.id}>
                  <div>
                    <h3>{person.name}</h3>
                    <p>{person.phone || person.email || 'Sin contacto'}</p>
                  </div>
                  <strong className={balance >= 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(balance)}</strong>
                  <span>{balance > 0 ? 'me debe' : balance < 0 ? 'le debo' : 'a cero'}</span>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {tab === 'personas' && (
        <section className="content-grid two-columns">
          <form className="panel form-grid" onSubmit={addPerson}>
            <div className="section-heading compact">
              <h2>Persona</h2>
              <UserPlus aria-hidden="true" />
            </div>
            <label>
              Nombre
              <input value={personForm.name} onChange={(event) => setPersonForm({ ...personForm, name: event.target.value })} />
            </label>
            <label>
              Telefono
              <input value={personForm.phone} onChange={(event) => setPersonForm({ ...personForm, phone: event.target.value })} inputMode="tel" />
            </label>
            <label>
              Email
              <input value={personForm.email} onChange={(event) => setPersonForm({ ...personForm, email: event.target.value })} type="email" />
            </label>
            <label>
              Notas
              <textarea value={personForm.notes} onChange={(event) => setPersonForm({ ...personForm, notes: event.target.value })} />
            </label>
            <button className="primary-button" type="submit">
              <Plus aria-hidden="true" />
              Añadir persona
            </button>
          </form>
          <div className="person-list">
            {people.map((person) => (
              <article className="person-card" key={person.id}>
                <div>
                  <h3>{person.name}</h3>
                  <p>{[person.phone, person.email].filter(Boolean).join(' · ') || person.notes || 'Sin datos extra'}</p>
                </div>
                <button className="icon-button danger" type="button" title="Borrar persona" onClick={() => deletePerson(person.id)}>
                  <Trash2 aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'nuevo' && (
        <section className="content-grid">
          <form className="panel form-grid" onSubmit={addRecord}>
            <div className="segmented">
              {[
                ['split', 'Gasto dividido'],
                ['debt', 'Deuda directa'],
                ['payment', 'Pago'],
              ].map(([id, label]) => (
                <button className={kind === id ? 'active' : ''} key={id} onClick={() => setKind(id as RecordKind)} type="button">
                  {label}
                </button>
              ))}
            </div>
            <div className="form-row">
              <label>
                Concepto
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Cena, alquiler, bizum..." />
              </label>
              <label>
                Importe
                <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" step="0.01" inputMode="decimal" />
              </label>
              <label>
                Fecha
                <input value={date} onChange={(event) => setDate(event.target.value)} type="date" />
              </label>
            </div>

            {kind === 'split' ? (
              <div className="split-box">
                <label>
                  Pagado por
                  <select value={paidBy} onChange={(event) => setPaidBy(event.target.value)}>
                    <option value={me}>Yo</option>
                    {people.map((person) => (
                      <option value={person.id} key={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="check-grid">
                  {[{ id: me, name: 'Yo' }, ...people].map((actor) => (
                    <label className="check-row" key={actor.id}>
                      <input checked={participantIds.includes(actor.id)} onChange={() => toggleParticipant(actor.id)} type="checkbox" />
                      <span>{actor.name}</span>
                      <input
                        aria-label={`Parte de ${actor.name}`}
                        disabled={!participantIds.includes(actor.id)}
                        min="0"
                        onChange={(event) => setShares({ ...shares, [actor.id]: Number(event.target.value) })}
                        step="0.01"
                        type="number"
                        value={shares[actor.id] ?? 0}
                      />
                    </label>
                  ))}
                </div>
                <button className="secondary-button" type="button" onClick={splitEqually}>
                  <Users aria-hidden="true" />
                  Dividir igual
                </button>
              </div>
            ) : (
              <div className="form-row">
                <label>
                  Persona
                  <select value={personId || firstPersonId} onChange={(event) => setPersonId(event.target.value)}>
                    {people.map((person) => (
                      <option value={person.id} key={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </label>
                {kind === 'debt' ? (
                  <label>
                    Tipo
                    <select value={debtDirection} onChange={(event) => setDebtDirection(event.target.value as DebtDirection)}>
                      <option value="owes_me">Me debe</option>
                      <option value="i_owe">Le debo</option>
                    </select>
                  </label>
                ) : (
                  <label>
                    Tipo
                    <select value={paymentDirection} onChange={(event) => setPaymentDirection(event.target.value as PaymentDirection)}>
                      <option value="person_paid_me">Me ha pagado</option>
                      <option value="i_paid_person">Le he pagado</option>
                    </select>
                  </label>
                )}
              </div>
            )}

            <div className="form-row">
              <label>
                Estado
                <select value={status} onChange={(event) => setStatus(event.target.value as RecordStatus)}>
                  <option value="por-pagar">Por pagar</option>
                  <option value="parcial">Parcial</option>
                  <option value="pagado">Pagado</option>
                </select>
              </label>
              <label>
                Etiquetas
                <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="casa, viaje, comida" />
              </label>
            </div>
            <label>
              Nota
              <textarea value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button className="primary-button" type="submit" disabled={people.length === 0 && kind !== 'split'}>
              <CheckCircle2 aria-hidden="true" />
              Guardar movimiento
            </button>
          </form>
        </section>
      )}

      {tab === 'historial' && (
        <section className="content-grid">
          <div className="toolbar">
            <label className="search-box">
              <Search aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar" />
            </label>
            <button className="secondary-button" type="button" onClick={exportData}>
              <Download aria-hidden="true" />
              Exportar
            </button>
            <label className="secondary-button file-button">
              <Upload aria-hidden="true" />
              Importar
              <input accept="application/json" onChange={importData} type="file" />
            </label>
          </div>
          <div className="record-list">
            {filteredRecords.length === 0 && <EmptyState text="Todavia no hay movimientos que mostrar." />}
            {filteredRecords.map((record) => (
              <RecordRow
                key={record.id}
                people={people}
                record={record}
                signed={computeSignedByPerson(record)}
                onDelete={() => deleteRecord(record.id)}
              />
            ))}
          </div>
        </section>
      )}
    </main>
  )
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>
}

function RecordRow({
  people,
  record,
  signed,
  onDelete,
}: {
  people: Person[]
  record: LedgerRecord
  signed: Map<string, number>
  onDelete: () => void
}) {
  const signedTotal = [...signed.values()].reduce((sum, value) => sum + value, 0)
  const personNames = [...signed.keys()]
    .map((id) => people.find((person) => person.id === id)?.name)
    .filter(Boolean)
    .join(', ')
  return (
    <article className="record-row">
      <div>
        <div className="record-title">
          <h3>{record.title}</h3>
          <span className={`status ${record.status}`}>{record.status.replace('-', ' ')}</span>
        </div>
        <p>{[record.date, personNames || 'Yo', record.kind].join(' · ')}</p>
        {record.tags.length > 0 && (
          <div className="tag-list">
            {record.tags.map((tagValue) => (
              <span key={tagValue}>
                <Tag aria-hidden="true" />
                {tagValue}
              </span>
            ))}
          </div>
        )}
      </div>
      <strong className={signedTotal >= 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(signedTotal)}</strong>
      <button className="icon-button danger" onClick={onDelete} title="Borrar movimiento" type="button">
        <Trash2 aria-hidden="true" />
      </button>
    </article>
  )
}

export default App
