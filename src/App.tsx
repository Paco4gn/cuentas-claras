import { useEffect, useMemo, useState } from 'react'
import Dexie, { type Table } from 'dexie'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  Download,
  Edit3,
  FileSpreadsheet,
  FileText,
  KeyRound,
  LogOut,
  Plus,
  ReceiptText,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  Users,
  WalletCards,
  X,
} from 'lucide-react'
import './App.css'

type ActorId = 'me' | string
type RecordKind = 'split' | 'debt' | 'payment'
type RecordStatus = 'por-pagar' | 'parcial' | 'pagado'
type DebtDirection = 'owes_me' | 'i_owe'
type PaymentDirection = 'person_paid_me' | 'i_paid_person'
type Tab = 'resumen' | 'nuevo' | 'personas' | 'historial'
type StatusFilter = 'todos' | RecordStatus
type AuthMode = 'login' | 'register' | 'recover'

interface User {
  id: string
  name: string
  email: string
  passwordHash: string
  salt: string
  createdAt: string
  authProvider?: 'password' | 'google'
  googleSub?: string
  recoveryHash?: string
  recoverySalt?: string
}

interface GoogleCredentialResponse {
  credential?: string
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            callback: (response: GoogleCredentialResponse) => void
            client_id: string
          }) => void
          renderButton: (element: HTMLElement, options: Record<string, string | number | boolean>) => void
        }
      }
    }
  }
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
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

const statusLabels: Record<RecordStatus, string> = {
  'por-pagar': 'Por pagar',
  parcial: 'Parcial',
  pagado: 'Pagado',
}

const kindLabels: Record<RecordKind, string> = {
  split: 'Gasto dividido',
  debt: 'Deuda directa',
  payment: 'Pago',
}

const formatMoney = (value: number) =>
  new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value)

const uid = () => crypto.randomUUID()

function makeRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((value) => alphabet[value % alphabet.length])
  return `CC-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`
}

function normalizeRecoveryCode(value: string) {
  return value.replace(/[^a-z0-9]/gi, '').toUpperCase()
}

function decodeJwtPayload(token: string) {
  const payload = token.split('.')[1]
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(normalized)) as { email?: string; name?: string; sub?: string }
}

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

function sortRecords(records: LedgerRecord[]) {
  return [...records].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
}

function shouldCountInOpenBalance(record: LedgerRecord) {
  return record.kind === 'payment' || record.status !== 'pagado'
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

function csvEscape(value: string | number) {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>('register')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authInfo, setAuthInfo] = useState('')
  const [recoveryCodeToShow, setRecoveryCodeToShow] = useState('')
  const [changePasswordForm, setChangePasswordForm] = useState({ current: '', next: '', recovery: '' })
  const [googleReady, setGoogleReady] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [records, setRecords] = useState<LedgerRecord[]>([])
  const [tab, setTab] = useState<Tab>('resumen')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos')
  const [personForm, setPersonForm] = useState({ name: '', phone: '', email: '', notes: '' })
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null)
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
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

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
      db.records.where('userId').equals(currentUser.id).toArray(),
    ]).then(([storedPeople, storedRecords]) => {
      setPeople(storedPeople)
      setRecords(sortRecords(storedRecords))
      setShares(emptyShares(storedPeople))
      if (storedPeople[0]) setPersonId(storedPeople[0].id)
    })
  }, [currentUser])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (currentUser || !googleClientId) return
    const element = document.getElementById('google-signin')
    if (!element) return

    const renderButton = () => {
      if (!window.google) return
      element.innerHTML = ''
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleGoogleLogin,
      })
      window.google.accounts.id.renderButton(element, {
        shape: 'rectangular',
        size: 'large',
        text: 'continue_with',
        theme: 'outline',
        width: 320,
      })
      setGoogleReady(true)
    }

    if (window.google) {
      renderButton()
      return
    }

    const scriptId = 'google-identity-services'
    const existingScript = document.getElementById(scriptId) as HTMLScriptElement | null
    const script = existingScript ?? document.createElement('script')
    script.id = scriptId
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = renderButton
    if (!existingScript) document.head.appendChild(script)
  }, [currentUser, authMode])

  const balances = useMemo(() => {
    const map = new Map<string, number>()
    records.forEach((record) => {
      if (!shouldCountInOpenBalance(record)) return
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
    const openCount = records.filter((record) => record.status !== 'pagado').length
    const paidCount = records.filter((record) => record.status === 'pagado').length
    return { owedToMe, owedByMe, net: owedToMe - owedByMe, openCount, paidCount }
  }, [balances, records])

  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return records.filter((record) => {
      if (statusFilter !== 'todos' && record.status !== statusFilter) return false
      if (!normalized) return true
      const personNames = [...computeSignedByPerson(record).keys()]
        .map((id) => personName(id, people))
        .join(' ')
      return [record.title, record.note, personNames, kindLabels[record.kind], statusLabels[record.status], ...record.tags]
        .join(' ')
        .toLowerCase()
        .includes(normalized)
    })
  }, [people, query, records, statusFilter])

  const sortedPeople = useMemo(
    () => [...people].sort((a, b) => Math.abs(balances.get(b.id) ?? 0) - Math.abs(balances.get(a.id) ?? 0)),
    [balances, people],
  )

  const tagStats = useMemo(() => {
    const totals = new Map<string, number>()
    records.forEach((record) => {
      if (!shouldCountInOpenBalance(record)) return
      const impact = Math.abs([...computeSignedByPerson(record).values()].reduce((sum, value) => sum + value, 0))
      record.tags.forEach((tagValue) => totals.set(tagValue, (totals.get(tagValue) ?? 0) + impact))
    })
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [records])

  const recentRecords = records.slice(0, 4)
  const firstPersonId = people[0]?.id ?? ''
  const shareTotal = participantIds.reduce((sum, id) => sum + Number(shares[id] ?? 0), 0)
  const splitDifference = Number((Number(amount || 0) - shareTotal).toFixed(2))
  const selectedPersonBalance = personId ? balances.get(personId) ?? 0 : 0

  async function refreshData(userId = currentUser?.id) {
    if (!userId) return
    const [storedPeople, storedRecords] = await Promise.all([
      db.persons.where('userId').equals(userId).sortBy('name'),
      db.records.where('userId').equals(userId).toArray(),
    ])
    setPeople(storedPeople)
    setRecords(sortRecords(storedRecords))
    setShares((current) => ({ ...emptyShares(storedPeople), ...current }))
    if (!personId && storedPeople[0]) setPersonId(storedPeople[0].id)
  }

  function finishLogin(user: User) {
    localStorage.setItem(sessionKey, user.id)
    setCurrentUser(user)
    setAuthPassword('')
    setNewPassword('')
    setRecoveryCode('')
    setAuthError('')
    setAuthInfo('')
  }

  async function handleGoogleLogin(response: GoogleCredentialResponse) {
    if (!response.credential) return
    try {
      const profile = decodeJwtPayload(response.credential)
      if (!profile.email || !profile.sub) {
        setAuthError('Google no devolvio un email valido.')
        return
      }

      const email = profile.email.trim().toLowerCase()
      const existingUser = await db.users.where('email').equals(email).first()
      if (existingUser) {
        const updatedUser: User = {
          ...existingUser,
          authProvider: existingUser.authProvider ?? 'google',
          googleSub: existingUser.googleSub ?? profile.sub,
        }
        await db.users.put(updatedUser)
        finishLogin(updatedUser)
        return
      }

      const user: User = {
        id: uid(),
        name: profile.name ?? email.split('@')[0],
        email,
        passwordHash: '',
        salt: '',
        authProvider: 'google',
        googleSub: profile.sub,
        createdAt: new Date().toISOString(),
      }
      await db.users.add(user)
      finishLogin(user)
    } catch {
      setAuthError('No se pudo iniciar sesion con Google.')
    }
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')
    setAuthInfo('')
    const email = authEmail.trim().toLowerCase()
    const password = authPassword.trim()
    if (authMode === 'recover') {
      await submitRecovery(email)
      return
    }

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
      const nextRecoveryCode = makeRecoveryCode()
      const recoverySalt = uid()
      const user: User = {
        id: uid(),
        name: authName.trim(),
        email,
        passwordHash: await hashPassword(password, salt),
        salt,
        authProvider: 'password',
        recoveryHash: await hashPassword(normalizeRecoveryCode(nextRecoveryCode), recoverySalt),
        recoverySalt,
        createdAt: new Date().toISOString(),
      }
      await db.users.add(user)
      setRecoveryCodeToShow(nextRecoveryCode)
      finishLogin(user)
      return
    }

    const user = await db.users.where('email').equals(email).first()
    if (!user) {
      setAuthError('No hay ninguna cuenta local con ese email en esta pagina.')
      return
    }
    if (!user.passwordHash) {
      setAuthError('Esta cuenta se creo con Google. Entra con Google o crea una contrasena desde ajustes.')
      return
    }
    if (user.passwordHash !== (await hashPassword(password, user.salt))) {
      setAuthError('Contrasena incorrecta.')
      return
    }
    finishLogin(user)
  }

  async function submitRecovery(email: string) {
    const code = normalizeRecoveryCode(recoveryCode)
    const password = newPassword.trim()
    if (!email || !code || !password) {
      setAuthError('Pon email, codigo de recuperacion y nueva contrasena.')
      return
    }
    const user = await db.users.where('email').equals(email).first()
    if (!user?.recoveryHash || !user.recoverySalt) {
      setAuthError('Esa cuenta no tiene codigo de recuperacion creado en esta pagina.')
      return
    }
    if (user.recoveryHash !== (await hashPassword(code, user.recoverySalt))) {
      setAuthError('Codigo de recuperacion incorrecto.')
      return
    }
    const salt = uid()
    const updatedUser: User = {
      ...user,
      authProvider: user.authProvider ?? 'password',
      passwordHash: await hashPassword(password, salt),
      salt,
    }
    await db.users.put(updatedUser)
    finishLogin(updatedUser)
    setNotice('Contrasena actualizada.')
  }

  async function generateRecoveryForCurrentUser() {
    if (!currentUser) return
    const nextRecoveryCode = makeRecoveryCode()
    const recoverySalt = uid()
    const updatedUser: User = {
      ...currentUser,
      recoveryHash: await hashPassword(normalizeRecoveryCode(nextRecoveryCode), recoverySalt),
      recoverySalt,
    }
    await db.users.put(updatedUser)
    setCurrentUser(updatedUser)
    setRecoveryCodeToShow(nextRecoveryCode)
    setNotice('Codigo de recuperacion creado.')
  }

  async function copyRecoveryCode() {
    if (!recoveryCodeToShow) return
    await navigator.clipboard.writeText(recoveryCodeToShow)
    setNotice('Codigo copiado.')
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser) return
    const next = changePasswordForm.next.trim()
    if (!next) {
      setNotice('Pon una contrasena nueva.')
      return
    }

    const canUseCurrentPassword =
      currentUser.passwordHash &&
      currentUser.passwordHash === (await hashPassword(changePasswordForm.current.trim(), currentUser.salt))
    const canUseRecovery =
      currentUser.recoveryHash &&
      currentUser.recoverySalt &&
      currentUser.recoveryHash === (await hashPassword(normalizeRecoveryCode(changePasswordForm.recovery), currentUser.recoverySalt))

    if (!canUseCurrentPassword && !canUseRecovery) {
      setNotice('Contrasena actual o codigo de recuperacion incorrecto.')
      return
    }

    const salt = uid()
    const updatedUser: User = {
      ...currentUser,
      authProvider: currentUser.authProvider ?? 'password',
      passwordHash: await hashPassword(next, salt),
      salt,
    }
    await db.users.put(updatedUser)
    setCurrentUser(updatedUser)
    setChangePasswordForm({ current: '', next: '', recovery: '' })
    setNotice('Contrasena cambiada.')
  }

  async function submitPerson(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser || !personForm.name.trim()) return
    const person: Person = {
      id: editingPersonId ?? uid(),
      userId: currentUser.id,
      name: personForm.name.trim(),
      phone: personForm.phone.trim(),
      email: personForm.email.trim(),
      notes: personForm.notes.trim(),
      createdAt: people.find((person) => person.id === editingPersonId)?.createdAt ?? new Date().toISOString(),
    }
    await db.persons.put(person)
    setPersonForm({ name: '', phone: '', email: '', notes: '' })
    setEditingPersonId(null)
    setPersonId(person.id)
    setParticipantIds((current) => [...new Set([...current, person.id])])
    await refreshData()
    setNotice(editingPersonId ? 'Persona actualizada.' : 'Persona anadida.')
  }

  function startEditPerson(person: Person) {
    setPersonForm({ name: person.name, phone: person.phone, email: person.email, notes: person.notes })
    setEditingPersonId(person.id)
    setTab('personas')
  }

  function resetPersonForm() {
    setPersonForm({ name: '', phone: '', email: '', notes: '' })
    setEditingPersonId(null)
  }

  function splitEqually() {
    const value = Number(amount)
    if (!value || participantIds.length === 0) return
    const baseCents = Math.round((value * 100) / participantIds.length)
    let remainingCents = Math.round(value * 100)
    const nextShares = { ...shares }
    participantIds.forEach((id, index) => {
      const cents = index === participantIds.length - 1 ? remainingCents : baseCents
      nextShares[id] = cents / 100
      remainingCents -= cents
    })
    setShares(nextShares)
  }

  function selectEveryone() {
    setParticipantIds([me, ...people.map((person) => person.id)])
  }

  function resetRecordForm() {
    setKind('split')
    setTitle('')
    setAmount('')
    setDate(today)
    setPaidBy(me)
    setParticipantIds([me])
    setShares(emptyShares(people))
    setPersonId(firstPersonId)
    setDebtDirection('owes_me')
    setPaymentDirection('person_paid_me')
    setStatus('por-pagar')
    setTagText('')
    setNote('')
    setEditingRecordId(null)
    setFormError('')
  }

  function validateRecordForm() {
    const numericAmount = Number(amount)
    if (!title.trim()) return 'Pon un concepto.'
    if (!numericAmount || numericAmount <= 0) return 'Pon un importe mayor que cero.'
    if (kind !== 'split' && !(personId || firstPersonId)) return 'Anade o elige una persona.'
    if (kind === 'split') {
      if (participantIds.length === 0) return 'Elige al menos un participante.'
      if (Math.abs(splitDifference) > 0.01) return 'El reparto debe cuadrar con el importe.'
      if (participantIds.every((id) => Number(shares[id] ?? 0) <= 0)) return 'Pon alguna parte del reparto.'
    }
    return ''
  }

  async function submitRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser) return
    const validationError = validateRecordForm()
    if (validationError) {
      setFormError(validationError)
      return
    }

    const existing = editingRecordId ? records.find((record) => record.id === editingRecordId) : undefined
    const numericAmount = Number(amount)
    const record: LedgerRecord = {
      id: existing?.id ?? uid(),
      userId: currentUser.id,
      kind,
      title: title.trim(),
      amount: numericAmount,
      currency: 'EUR',
      date,
      tags: tagsFromText(tagText),
      status,
      note: note.trim(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
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

    await db.records.put(record)
    await refreshData()
    setNotice(editingRecordId ? 'Movimiento actualizado.' : 'Movimiento guardado.')
    resetRecordForm()
    setTab('resumen')
  }

  function startEditRecord(record: LedgerRecord) {
    setKind(record.kind)
    setTitle(record.title)
    setAmount(String(record.amount))
    setDate(record.date)
    setPaidBy(record.paidBy ?? me)
    setParticipantIds(record.participantIds ?? [me])
    setShares({ ...emptyShares(people), ...(record.shares ?? {}) })
    setPersonId(record.personId ?? firstPersonId)
    setDebtDirection(record.direction === 'i_owe' ? 'i_owe' : 'owes_me')
    setPaymentDirection(record.direction === 'i_paid_person' ? 'i_paid_person' : 'person_paid_me')
    setStatus(record.status)
    setTagText(record.tags.join(', '))
    setNote(record.note)
    setEditingRecordId(record.id)
    setFormError('')
    setTab('nuevo')
  }

  async function deleteRecord(recordId: string) {
    await db.records.delete(recordId)
    await refreshData()
    setNotice('Movimiento borrado.')
  }

  async function markRecordStatus(record: LedgerRecord, nextStatus: RecordStatus) {
    await db.records.put({ ...record, status: nextStatus })
    await refreshData()
    setNotice(`Movimiento marcado como ${statusLabels[nextStatus].toLowerCase()}.`)
  }

  async function settlePerson(person: Person) {
    if (!currentUser) return
    const balance = Number((balances.get(person.id) ?? 0).toFixed(2))
    if (balance === 0) return
    const record: LedgerRecord = {
      id: uid(),
      userId: currentUser.id,
      kind: 'payment',
      title: balance > 0 ? `Pago recibido de ${person.name}` : `Pago enviado a ${person.name}`,
      amount: Math.abs(balance),
      currency: 'EUR',
      date: today,
      personId: person.id,
      direction: balance > 0 ? 'person_paid_me' : 'i_paid_person',
      tags: ['liquidacion'],
      status: 'pagado',
      note: 'Liquidacion rapida generada desde resumen.',
      createdAt: new Date().toISOString(),
    }
    await db.records.add(record)
    await refreshData()
    setNotice(`Saldo de ${person.name} liquidado.`)
  }

  async function deletePerson(id: string) {
    const hasRecords = records.some(
      (record) => record.personId === id || record.paidBy === id || record.participantIds?.includes(id),
    )
    if (hasRecords && !window.confirm('Esta persona tiene movimientos. Si la borras tambien se borraran esos movimientos.')) {
      return
    }
    await db.transaction('rw', db.persons, db.records, async () => {
      await db.persons.delete(id)
      if (hasRecords) {
        const related = records.filter(
          (record) => record.personId === id || record.paidBy === id || record.participantIds?.includes(id),
        )
        await db.records.bulkDelete(related.map((record) => record.id))
      }
    })
    await refreshData()
    if (editingPersonId === id) resetPersonForm()
    setNotice('Persona borrada.')
  }

  function toggleParticipant(id: ActorId) {
    setParticipantIds((current) => {
      if (current.includes(id)) return current.filter((candidate) => candidate !== id)
      return [...current, id]
    })
  }

  function downloadFile(filename: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  function exportData() {
    if (!currentUser) return
    const payload = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), people, records }, null, 2)
    downloadFile(`cuentas-claras-${today}.json`, payload, 'application/json')
  }

  function exportCsv() {
    const header = ['fecha', 'tipo', 'concepto', 'persona', 'importe', 'impacto', 'estado', 'etiquetas', 'nota']
    const rows = records.map((record) => {
      const signed = [...computeSignedByPerson(record).values()].reduce((sum, value) => sum + value, 0)
      const names = [...computeSignedByPerson(record).keys()].map((id) => personName(id, people)).join(' | ')
      return [
        record.date,
        kindLabels[record.kind],
        record.title,
        names || 'Yo',
        record.amount,
        signed,
        statusLabels[record.status],
        record.tags.join(' | '),
        record.note,
      ].map(csvEscape)
    })
    downloadFile(`cuentas-claras-${today}.csv`, [header, ...rows].map((row) => row.join(',')).join('\n'), 'text/csv')
  }

  async function importData(event: React.ChangeEvent<HTMLInputElement>) {
    if (!currentUser || !event.target.files?.[0]) return
    try {
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
      setNotice('Datos importados.')
    } catch {
      setNotice('No se pudo importar el archivo.')
    } finally {
      event.target.value = ''
    }
  }

  function signOut() {
    localStorage.removeItem(sessionKey)
    setCurrentUser(null)
    setAuthPassword('')
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
          <div className="trust-strip">
            <span>
              <ShieldCheck aria-hidden="true" />
              Local-first
            </span>
            <span>IndexedDB</span>
            <span>PWA</span>
          </div>
          <div className="segmented">
            <button className={authMode === 'register' ? 'active' : ''} onClick={() => setAuthMode('register')} type="button">
              Crear cuenta
            </button>
            <button className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')} type="button">
              Entrar
            </button>
            <button className={authMode === 'recover' ? 'active' : ''} onClick={() => setAuthMode('recover')} type="button">
              Recuperar
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
            {authMode !== 'recover' ? (
              <label>
                Contrasena
                <input
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  type="password"
                  autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                />
              </label>
            ) : (
              <>
                <label>
                  Codigo de recuperacion
                  <input value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} placeholder="CC-XXXX-XXXX-XXXX" />
                </label>
                <label>
                  Nueva contrasena
                  <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" />
                </label>
              </>
            )}
            {authError && <p className="error-text">{authError}</p>}
            {authInfo && <p className="info-text">{authInfo}</p>}
            <button className="primary-button" type="submit">
              {authMode === 'recover' ? <KeyRound aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              {authMode === 'register' ? 'Crear y entrar' : authMode === 'recover' ? 'Cambiar y entrar' : 'Entrar'}
            </button>
          </form>
          <div className="auth-divider">o</div>
          <div className="google-box">
            {googleClientId ? (
              <>
                <div id="google-signin"></div>
                {!googleReady && <p className="info-text">Cargando inicio con Google...</p>}
              </>
            ) : (
              <p className="info-text">
                Google esta preparado, pero falta configurar <code>VITE_GOOGLE_CLIENT_ID</code> para este dominio.
              </p>
            )}
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      {notice && <div className="toast">{notice}</div>}
      <header className="topbar">
        <div>
          <span className="eyebrow">Hola, {currentUser.name}</span>
          <h1>Cuentas claras</h1>
        </div>
        <button aria-label="Salir" className="icon-button" type="button" title="Salir" onClick={signOut}>
          <LogOut aria-hidden="true" />
        </button>
      </header>

      <section className="summary-grid">
        <Metric icon={<ArrowUpRight aria-hidden="true" />} label="Me deben" value={summary.owedToMe} tone="positive" />
        <Metric icon={<ArrowDownLeft aria-hidden="true" />} label="Debo" value={summary.owedByMe} tone="negative" />
        <Metric icon={<CircleDollarSign aria-hidden="true" />} label="Saldo neto" value={summary.net} tone={summary.net >= 0 ? 'positive' : 'negative'} />
      </section>

      <nav className="tabs" aria-label="Secciones">
        {[
          ['resumen', BarChart3, 'Resumen'],
          ['nuevo', Plus, editingRecordId ? 'Editar' : 'Nuevo'],
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
        <section className="dashboard-grid">
          <div className="content-grid main-column">
            <div className="section-heading">
              <h2>Saldos vivos</h2>
              <button className="secondary-button" type="button" onClick={() => setTab('nuevo')}>
                <Plus aria-hidden="true" />
                Movimiento
              </button>
            </div>
            <div className="person-list">
              {sortedPeople.length === 0 && <EmptyState text="Anade personas para empezar a cuadrar cuentas." />}
              {sortedPeople.map((person) => (
                <PersonBalanceCard
                  balance={balances.get(person.id) ?? 0}
                  key={person.id}
                  person={person}
                  onEdit={() => startEditPerson(person)}
                  onSettle={() => settlePerson(person)}
                />
              ))}
            </div>
          </div>

          <aside className="side-column">
            <section className="panel mini-stats">
              <div className="section-heading compact">
                <h2>Actividad</h2>
                <SlidersHorizontal aria-hidden="true" />
              </div>
              <div className="stat-row">
                <span>Abiertos</span>
                <strong>{summary.openCount}</strong>
              </div>
              <div className="stat-row">
                <span>Pagados</span>
                <strong>{summary.paidCount}</strong>
              </div>
              <div className="stat-row">
                <span>Personas</span>
                <strong>{people.length}</strong>
              </div>
            </section>

            <section className="panel account-panel">
              <div className="section-heading compact">
                <h2>Cuenta</h2>
                <KeyRound aria-hidden="true" />
              </div>
              <p className="panel-copy">
                Cambia tu contrasena o crea un codigo para recuperarla si la olvidas.
              </p>
              <form className="form-grid" onSubmit={changePassword}>
                <label>
                  Contrasena actual
                  <input
                    value={changePasswordForm.current}
                    onChange={(event) => setChangePasswordForm({ ...changePasswordForm, current: event.target.value })}
                    type="password"
                    autoComplete="current-password"
                  />
                </label>
                <label>
                  Codigo de recuperacion
                  <input
                    value={changePasswordForm.recovery}
                    onChange={(event) => setChangePasswordForm({ ...changePasswordForm, recovery: event.target.value })}
                    placeholder="Alternativa a la contrasena actual"
                  />
                </label>
                <label>
                  Nueva contrasena
                  <input
                    value={changePasswordForm.next}
                    onChange={(event) => setChangePasswordForm({ ...changePasswordForm, next: event.target.value })}
                    type="password"
                    autoComplete="new-password"
                  />
                </label>
                <button className="secondary-button" type="submit">
                  <Save aria-hidden="true" />
                  Cambiar contrasena
                </button>
              </form>
              <button className="secondary-button full-button" type="button" onClick={generateRecoveryForCurrentUser}>
                <KeyRound aria-hidden="true" />
                {currentUser.recoveryHash ? 'Crear codigo nuevo' : 'Crear codigo de recuperacion'}
              </button>
              {recoveryCodeToShow && (
                <div className="recovery-card">
                  <span>Guarda este codigo</span>
                  <strong>{recoveryCodeToShow}</strong>
                  <button className="secondary-button" type="button" onClick={copyRecoveryCode}>
                    <Copy aria-hidden="true" />
                    Copiar
                  </button>
                </div>
              )}
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <h2>Etiquetas</h2>
                <Tag aria-hidden="true" />
              </div>
              <div className="insight-list">
                {tagStats.length === 0 && <EmptyState text="Usa etiquetas para ver donde se mueve el dinero." />}
                {tagStats.map(([tagValue, value]) => (
                  <button
                    className="insight-row"
                    key={tagValue}
                    onClick={() => {
                      setQuery(tagValue)
                      setTab('historial')
                    }}
                    type="button"
                  >
                    <span>{tagValue}</span>
                    <strong>{formatMoney(value)}</strong>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <h2>Ultimos</h2>
                <ReceiptText aria-hidden="true" />
              </div>
              <div className="compact-records">
                {recentRecords.length === 0 && <EmptyState text="Aun no hay movimientos." />}
                {recentRecords.map((record) => (
                  <button className="compact-record" key={record.id} onClick={() => startEditRecord(record)} type="button">
                    <span>{record.title}</span>
                    <strong>{formatMoney(recordImpact(record))}</strong>
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </section>
      )}

      {tab === 'personas' && (
        <section className="content-grid two-columns">
          <form className="panel form-grid" onSubmit={submitPerson}>
            <div className="section-heading compact">
              <h2>{editingPersonId ? 'Editar persona' : 'Persona'}</h2>
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
            <div className="button-row">
              <button className="primary-button" type="submit">
                {editingPersonId ? <Save aria-hidden="true" /> : <Plus aria-hidden="true" />}
                {editingPersonId ? 'Guardar cambios' : 'Anadir persona'}
              </button>
              {editingPersonId && (
                <button className="secondary-button" onClick={resetPersonForm} type="button">
                  <X aria-hidden="true" />
                  Cancelar
                </button>
              )}
            </div>
          </form>
          <div className="person-list">
            {people.length === 0 && <EmptyState text="No hay personas guardadas." />}
            {people.map((person) => (
              <article className="person-card" key={person.id}>
                <div>
                  <h3>{person.name}</h3>
                  <p>{[person.phone, person.email].filter(Boolean).join(' / ') || person.notes || 'Sin datos extra'}</p>
                </div>
                <strong className={(balances.get(person.id) ?? 0) >= 0 ? 'amount-positive' : 'amount-negative'}>
                  {formatMoney(balances.get(person.id) ?? 0)}
                </strong>
                <div className="row-actions">
                  <button aria-label="Editar persona" className="icon-button" type="button" title="Editar persona" onClick={() => startEditPerson(person)}>
                    <Edit3 aria-hidden="true" />
                  </button>
                  <button aria-label="Borrar persona" className="icon-button danger" type="button" title="Borrar persona" onClick={() => deletePerson(person.id)}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'nuevo' && (
        <section className="content-grid">
          <form className="panel form-grid" onSubmit={submitRecord}>
            <div className="section-heading compact">
              <h2>{editingRecordId ? 'Editar movimiento' : 'Nuevo movimiento'}</h2>
              {editingRecordId && (
                <button className="secondary-button" onClick={resetRecordForm} type="button">
                  <X aria-hidden="true" />
                  Cancelar
                </button>
              )}
            </div>
            <div className="segmented">
              {[
                ['split', 'Dividido'],
                ['debt', 'Deuda'],
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
                <div className="form-row two">
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
                  <div className={`share-balance ${Math.abs(splitDifference) <= 0.01 ? 'ok' : 'warn'}`}>
                    <span>Total reparto</span>
                    <strong>{formatMoney(shareTotal)}</strong>
                    <small>{Math.abs(splitDifference) <= 0.01 ? 'Cuadra' : `Faltan ${formatMoney(splitDifference)}`}</small>
                  </div>
                </div>
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={splitEqually}>
                    <Users aria-hidden="true" />
                    Dividir igual
                  </button>
                  <button className="secondary-button" type="button" onClick={selectEveryone}>
                    <CheckCircle2 aria-hidden="true" />
                    Todos
                  </button>
                </div>
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
                <div className="share-balance ok">
                  <span>Saldo actual</span>
                  <strong>{formatMoney(selectedPersonBalance)}</strong>
                  <small>{selectedPersonBalance >= 0 ? 'me debe' : 'le debo'}</small>
                </div>
              </div>
            )}

            <div className="form-row two">
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
            {formError && <p className="error-text">{formError}</p>}
            <button className="primary-button" type="submit">
              {editingRecordId ? <Save aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              {editingRecordId ? 'Guardar cambios' : 'Guardar movimiento'}
            </button>
          </form>
        </section>
      )}

      {tab === 'historial' && (
        <section className="content-grid">
          <div className="toolbar">
            <label className="search-box">
              <Search aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar persona, etiqueta o concepto" />
            </label>
            <label className="filter-box">
              Estado
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="todos">Todos</option>
                <option value="por-pagar">Por pagar</option>
                <option value="parcial">Parcial</option>
                <option value="pagado">Pagado</option>
              </select>
            </label>
            <button className="secondary-button" type="button" onClick={exportData}>
              <Download aria-hidden="true" />
              JSON
            </button>
            <button className="secondary-button" type="button" onClick={exportCsv}>
              <FileSpreadsheet aria-hidden="true" />
              CSV
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
                onEdit={() => startEditRecord(record)}
                onMarkPaid={() => markRecordStatus(record, record.status === 'pagado' ? 'por-pagar' : 'pagado')}
              />
            ))}
          </div>
        </section>
      )}
    </main>
  )
}

function personName(id: ActorId, people: Person[]) {
  if (id === me) return 'Yo'
  return people.find((person) => person.id === id)?.name ?? 'Persona borrada'
}

function recordImpact(record: LedgerRecord) {
  return [...computeSignedByPerson(record).values()].reduce((sum, value) => sum + value, 0)
}

function Metric({
  icon,
  label,
  tone,
  value,
}: {
  icon: React.ReactNode
  label: string
  tone: 'positive' | 'negative'
  value: number
}) {
  return (
    <article className={`metric ${tone}`}>
      {icon}
      <div>
        <span>{label}</span>
        <strong>{formatMoney(value)}</strong>
      </div>
    </article>
  )
}

function PersonBalanceCard({
  balance,
  onEdit,
  onSettle,
  person,
}: {
  balance: number
  onEdit: () => void
  onSettle: () => void
  person: Person
}) {
  return (
    <article className="person-card balance-card">
      <div>
        <h3>{person.name}</h3>
        <p>{person.phone || person.email || person.notes || 'Sin contacto'}</p>
      </div>
      <strong className={balance >= 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(balance)}</strong>
      <span>{balance > 0 ? 'me debe' : balance < 0 ? 'le debo' : 'a cero'}</span>
      <div className="row-actions">
        <button aria-label="Editar persona" className="icon-button" type="button" title="Editar persona" onClick={onEdit}>
          <Edit3 aria-hidden="true" />
        </button>
        <button className="secondary-button settle-button" disabled={balance === 0} type="button" onClick={onSettle}>
          <CheckCircle2 aria-hidden="true" />
          Liquidar
        </button>
      </div>
    </article>
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
  onEdit,
  onMarkPaid,
}: {
  people: Person[]
  record: LedgerRecord
  signed: Map<string, number>
  onDelete: () => void
  onEdit: () => void
  onMarkPaid: () => void
}) {
  const signedTotal = [...signed.values()].reduce((sum, value) => sum + value, 0)
  const personNames = [...signed.keys()].map((id) => personName(id, people)).join(', ')
  return (
    <article className="record-row">
      <div>
        <div className="record-title">
          <h3>{record.title}</h3>
          <span className={`status ${record.status}`}>{statusLabels[record.status]}</span>
        </div>
        <p>{[record.date, personNames || 'Yo', kindLabels[record.kind]].join(' / ')}</p>
        {record.note && (
          <p className="record-note">
            <FileText aria-hidden="true" />
            {record.note}
          </p>
        )}
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
      <div className="row-actions">
        <button aria-label="Editar movimiento" className="icon-button" onClick={onEdit} title="Editar movimiento" type="button">
          <Edit3 aria-hidden="true" />
        </button>
        <button
          aria-label={record.status === 'pagado' ? 'Reabrir movimiento' : 'Marcar pagado'}
          className="icon-button"
          onClick={onMarkPaid}
          title={record.status === 'pagado' ? 'Reabrir' : 'Marcar pagado'}
          type="button"
        >
          {record.status === 'pagado' ? <RotateCcw aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
        </button>
        <button aria-label="Borrar movimiento" className="icon-button danger" onClick={onDelete} title="Borrar movimiento" type="button">
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}

export default App
