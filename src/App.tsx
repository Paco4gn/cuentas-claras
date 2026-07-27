import { useEffect, useMemo, useState } from 'react'
import Dexie, { type Table } from 'dexie'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query as firestoreQuery,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { deleteObject, getDownloadURL, ref as storageRef, uploadString } from 'firebase/storage'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  BellRing,
  Camera,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  FolderKanban,
  KeyRound,
  Link2,
  Lock,
  LogOut,
  MessageCircle,
  Mic,
  Paperclip,
  Plus,
  QrCode,
  ReceiptText,
  Repeat2,
  Route,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  Users,
  WalletCards,
  WandSparkles,
  X,
} from 'lucide-react'
import './App.css'
import { firebaseAuth, firebaseStorage, firestore, googleProvider, isFirebaseConfigured, useFirebaseStorage } from './firebase'

type ActorId = 'me' | string
type RecordKind = 'split' | 'debt' | 'payment'
type RecordStatus = 'por-pagar' | 'parcial' | 'pagado'
type DebtDirection = 'owes_me' | 'i_owe'
type PaymentDirection = 'person_paid_me' | 'i_paid_person'
type Tab = 'resumen' | 'nuevo' | 'personas' | 'historial' | 'grupos'
type StatusFilter = 'todos' | RecordStatus | 'vencidos'
type KindFilter = 'todos' | RecordKind
type RepeatRule = 'none' | 'weekly' | 'monthly'
type AuthMode = 'login' | 'register' | 'recover'
type SyncMode = 'cloud' | 'local'

interface User {
  id: string
  name: string
  email: string
  passwordHash: string
  salt: string
  createdAt: string
  passwordAlgo?: 'sha256' | 'pbkdf2'
  authProvider?: 'password' | 'google'
  googleSub?: string
  recoveryHash?: string
  recoverySalt?: string
  recoveryAlgo?: 'sha256' | 'pbkdf2'
  recoveryHint?: string
  recoveryUpdatedAt?: string
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
  avatar?: string
  avatarStoragePath?: string
  favorite?: boolean
  createdAt: string
}

interface SharedGroup {
  id: string
  name: string
  ownerId: string
  ownerEmail: string
  memberEmails: string[]
  mode?: 'normal' | 'viaje'
  budget?: number
  inviteCode?: string
  createdAt: string
  updatedAt: string
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
  dueDate?: string
  repeat?: RepeatRule
  attachmentName?: string
  attachmentData?: string
  note: string
  createdAt: string
}

interface ImportPayload {
  people?: Person[]
  persons?: Person[]
  records?: LedgerRecord[]
}

interface RecoveryKitPayload {
  app?: string
  type?: string
  version?: number
  email?: string
  name?: string
  recoveryCode?: string
  createdAt?: string
}

interface SmartDraft {
  kind: RecordKind
  title: string
  amount: number
  personName?: string
  personNames?: string[]
  direction?: DebtDirection | PaymentDirection
  paidByName?: string | 'me'
  status: RecordStatus
  dueDate?: string
  tags: string[]
  note: string
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
const dayMs = 86_400_000
const me: ActorId = 'me'
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

const cleanForFirestore = <T,>(value: T) => JSON.parse(JSON.stringify(value)) as T
const userDoc = (userId: string) => doc(firestore!, 'users', userId)
const peopleCollection = (userId: string) => collection(firestore!, 'users', userId, 'persons')
const recordsCollection = (userId: string) => collection(firestore!, 'users', userId, 'records')
const groupDoc = (groupId: string) => doc(firestore!, 'groups', groupId)
const groupPeopleCollection = (groupId: string) => collection(firestore!, 'groups', groupId, 'persons')
const groupRecordsCollection = (groupId: string) => collection(firestore!, 'groups', groupId, 'records')
const ledgerPeopleCollection = (ledgerId: string, sharedLedger: boolean) => sharedLedger ? groupPeopleCollection(ledgerId) : peopleCollection(ledgerId)
const ledgerRecordsCollection = (ledgerId: string, sharedLedger: boolean) => sharedLedger ? groupRecordsCollection(ledgerId) : recordsCollection(ledgerId)
const firestoreBatchLimit = 450

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

function recoveryKitContent(user: User, recoveryCode: string) {
  const payload: RecoveryKitPayload = {
    app: 'cuentas-claras',
    type: 'recovery-kit',
    version: 1,
    email: user.email,
    name: user.name,
    recoveryCode,
    createdAt: new Date().toISOString(),
  }
  return JSON.stringify(payload, null, 2)
}

function normalizeRecoveryCode(value: string) {
  return value.replace(/[^a-z0-9]/gi, '').toUpperCase()
}

function passwordProblem(password: string) {
  if (password.length < 6) return 'Usa una contrasena de al menos 6 caracteres.'
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return 'Mejor mezcla letras y numeros en la contrasena.'
  return ''
}

function decodeJwtPayload(token: string) {
  const payload = token.split('.')[1]
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(normalized)) as { email?: string; name?: string; sub?: string }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function hashSha256(password: string, salt: string) {
  const payload = new TextEncoder().encode(`${salt}:${password}`)
  const digest = await crypto.subtle.digest('SHA-256', payload)
  return bytesToHex(new Uint8Array(digest))
}

async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      iterations: 210_000,
    },
    key,
    256,
  )
  return bytesToHex(new Uint8Array(derived))
}

async function verifySecret(secret: string, salt: string, expectedHash: string, algo?: 'sha256' | 'pbkdf2') {
  const primaryHash = algo === 'sha256' ? await hashSha256(secret, salt) : await hashPassword(secret, salt)
  if (primaryHash === expectedHash) return true
  if (!algo && (await hashSha256(secret, salt)) === expectedHash) return true
  return false
}

function tagsFromText(value: string) {
  return value
    .split(',')
    .map((tagValue) => tagValue.trim())
    .filter(Boolean)
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function addDaysToToday(days: number) {
  const next = new Date(`${today}T00:00:00`)
  next.setDate(next.getDate() + days)
  return next.toISOString().slice(0, 10)
}

function nextWeekdayDate(weekday: number) {
  const current = new Date(`${today}T00:00:00`)
  const currentDay = current.getDay()
  const diff = (weekday + 7 - currentDay) % 7 || 7
  current.setDate(current.getDate() + diff)
  return current.toISOString().slice(0, 10)
}

function dueDateFromSmartText(normalized: string) {
  if (/\b(hoy)\b/.test(normalized)) return today
  if (/\b(manana)\b/.test(normalized)) return addDaysToToday(1)
  if (/\b(pasado manana)\b/.test(normalized)) return addDaysToToday(2)
  const weekdays: Record<string, number> = {
    domingo: 0,
    lunes: 1,
    martes: 2,
    miercoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6,
  }
  const weekday = Object.entries(weekdays).find(([name]) => normalized.includes(name))
  return weekday ? nextWeekdayDate(weekday[1]) : undefined
}

function personNameFromText(text: string, normalized: string, people: Person[]) {
  const known = people.find((person) => normalized.includes(normalizeText(person.name)))
  if (known) return known.name
  const patterns = [
    /\b(?:a|de)\s+([a-z0-9áéíóúñü\s]{2,40}?)(?:\s+(?:por|me|le|que|vence|etiqueta|tag|pagad|debe|pago|pague)|$)/i,
    /^([a-z0-9áéíóúñü\s]{2,30}?)\s+(?:me|le|debe|pago|pague)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)?.[1]?.trim()
    if (match) return match.replace(/\s+/g, ' ')
  }
  return ''
}

function splitNamesFromSmartText(text: string, people: Person[]) {
  const between = text.match(/\bentre\s+(.+?)(?:\s+(?:pagu[eé]|pag[oó]|por|vence|etiqueta|tag)|$)/i)?.[1]
  if (!between) return []
  const names = between
    .split(/\s*(?:,| y )\s*/i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (normalizeText(name) === 'yo' || normalizeText(name) === 'mi' ? 'me' : name))
  return names.map((name) => {
    if (name === 'me') return name
    const normalizedName = normalizeText(name)
    return people.find((person) => normalizeText(person.name) === normalizedName || normalizeText(person.name).includes(normalizedName) || normalizedName.includes(normalizeText(person.name)))?.name ?? name
  })
}

function conceptFromSmartText(text: string) {
  const concept = text.match(/\bpor\s+(.+?)(?:\s+(?:vence|venc[eé]|etiqueta|etiquetas|tag|tags|pagad[oa])|$)/i)?.[1]?.trim()
  return concept ? concept.replace(/\s+/g, ' ') : 'Movimiento rapido'
}

function tagsFromSmartText(text: string) {
  const tags = text.match(/\b(?:etiqueta|etiquetas|tag|tags)\s+(.+)$/i)?.[1]
  return tags ? tagsFromText(tags.replace(/\s+y\s+/gi, ',')) : []
}

function parseSmartText(text: string, people: Person[]): SmartDraft | { error: string } {
  const clean = text.trim()
  const normalized = normalizeText(clean)
  const amountMatch = normalized.match(/(\d+(?:[,.]\d{1,2})?)\s*(?:€|eur|euros?)?/)
  const amount = Number(amountMatch?.[1]?.replace(',', '.') ?? 0)
  if (!clean) return { error: 'Dime algo como "Ana me debe 12 por cena".' }
  if (!amount || amount <= 0) return { error: 'No he encontrado un importe valido.' }

  const status: RecordStatus = /\b(pagado|pagada|cerrado|cerrada|liquidado|liquidada)\b/.test(normalized) ? 'pagado' : normalized.includes('parcial') ? 'parcial' : 'por-pagar'
  const title = conceptFromSmartText(clean)
  const dueDate = dueDateFromSmartText(normalized)
  const tags = tagsFromSmartText(clean)

  if (/\b(divide|dividir|reparte|repartir|dividido|compartid[oa])\b/.test(normalized)) {
    const personNames = splitNamesFromSmartText(clean, people)
    const paidByName = /\bpagu[eé]\s+yo\b|\bpago\s+yo\b|\bpagado\s+por\s+mi\b|\bpagado\s+por\s+yo\b/.test(normalized)
      ? 'me'
      : personNameFromText(clean, normalized, people) || 'me'
    return { kind: 'split', title, amount, personNames, paidByName, status, dueDate, tags, note: clean }
  }

  if (/\b(me\s+(ha\s+)?pag[oó]|me\s+pago|me\s+pagaron)\b/.test(normalized)) {
    return { kind: 'payment', title, amount, personName: personNameFromText(clean, normalized, people), direction: 'person_paid_me', status, dueDate, tags, note: clean }
  }

  if (/\b(le\s+(he\s+)?pagado|le\s+pagu[eé]|pagu[eé]\s+a|he\s+pagado\s+a)\b/.test(normalized)) {
    return { kind: 'payment', title, amount, personName: personNameFromText(clean, normalized, people), direction: 'i_paid_person', status, dueDate, tags, note: clean }
  }

  if (/\b(le\s+debo|debo\s+a|yo\s+debo)\b/.test(normalized)) {
    return { kind: 'debt', title, amount, personName: personNameFromText(clean, normalized, people), direction: 'i_owe', status, dueDate, tags, note: clean }
  }

  return { kind: 'debt', title, amount, personName: personNameFromText(clean, normalized, people), direction: 'owes_me', status, dueDate, tags, note: clean }
}

function smartDraftSummary(draft: SmartDraft) {
  const base = `${kindLabels[draft.kind]} - ${formatMoney(draft.amount)} - ${draft.title}`
  if (draft.kind === 'split') return `${base} - ${draft.personNames?.join(', ') || 'participantes'}`
  const direction = draft.direction === 'i_owe' ? 'Le debo' : draft.direction === 'person_paid_me' ? 'Me ha pagado' : draft.direction === 'i_paid_person' ? 'Le he pagado' : 'Me debe'
  return `${base} - ${draft.personName || 'persona nueva'} - ${direction}`
}

function emailsFromText(value: string) {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.includes('@')),
    ),
  ]
}

function sortRecords(records: LedgerRecord[]) {
  return [...records].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
}

function shouldCountInOpenBalance(record: LedgerRecord) {
  return record.status !== 'pagado'
}

function recordTouchesPerson(record: LedgerRecord, personId: string) {
  return record.personId === personId || record.paidBy === personId || Boolean(record.participantIds?.includes(personId))
}

function nextRepeatDate(date: string, repeat: RepeatRule) {
  const next = new Date(`${date}T00:00:00`)
  if (repeat === 'weekly') next.setDate(next.getDate() + 7)
  if (repeat === 'monthly') next.setMonth(next.getMonth() + 1)
  return next.toISOString().slice(0, 10)
}

function settlementPlanFromBalances(balances: Map<string, number>) {
  const entries = [...balances.entries()]
  const meBalance = -entries.reduce((sum, [, value]) => sum + value, 0)
  const allEntries = [['me', meBalance] as [ActorId, number], ...entries]
  const creditors = allEntries
    .filter(([, value]) => value > 0.009)
    .map(([id, value]) => ({ id, value: Number(value.toFixed(2)) }))
    .sort((a, b) => b.value - a.value)
  const debtors = allEntries
    .filter(([, value]) => value < -0.009)
    .map(([id, value]) => ({ id, value: Number(Math.abs(value).toFixed(2)) }))
    .sort((a, b) => b.value - a.value)
  const plan: Array<{ from: ActorId; to: ActorId; amount: number }> = []
  let creditorIndex = 0
  let debtorIndex = 0
  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const amount = Number(Math.min(creditors[creditorIndex].value, debtors[debtorIndex].value).toFixed(2))
    if (amount > 0) plan.push({ from: debtors[debtorIndex].id, to: creditors[creditorIndex].id, amount })
    creditors[creditorIndex].value = Number((creditors[creditorIndex].value - amount).toFixed(2))
    debtors[debtorIndex].value = Number((debtors[debtorIndex].value - amount).toFixed(2))
    if (creditors[creditorIndex].value <= 0.009) creditorIndex += 1
    if (debtors[debtorIndex].value <= 0.009) debtorIndex += 1
  }
  return plan
}

function attachmentFileToData(file: File) {
  return new Promise<{ name: string; data: string }>((resolve, reject) => {
    if (file.size > 450_000) {
      reject(new Error('too-large'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read-error'))
    reader.onload = () => resolve({ name: file.name, data: String(reader.result) })
    reader.readAsDataURL(file)
  })
}

function daysUntil(date: string) {
  const target = new Date(`${date}T00:00:00`).getTime()
  const current = new Date(`${today}T00:00:00`).getTime()
  return Math.round((target - current) / dayMs)
}

function dueLabel(record: LedgerRecord) {
  if (!record.dueDate || record.status === 'pagado') return ''
  const days = daysUntil(record.dueDate)
  if (days < 0) return `Vencido hace ${Math.abs(days)} d`
  if (days === 0) return 'Vence hoy'
  if (days === 1) return 'Vence manana'
  return `Vence en ${days} d`
}

function dueTone(record: LedgerRecord) {
  if (!record.dueDate || record.status === 'pagado') return 'neutral'
  const days = daysUntil(record.dueDate)
  if (days < 0) return 'overdue'
  if (days <= 3) return 'soon'
  return 'neutral'
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

function icsEscape(value: string | number) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r?\n/g, '\\n')
}

function dateToIcs(date: string) {
  return date.replaceAll('-', '')
}

function imageFileToAvatar(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('not-image'))
      return
    }

    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read-error'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('image-error'))
      image.onload = () => {
        const maxSize = 420
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.width * scale))
        canvas.height = Math.max(1, Math.round(image.height * scale))
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('canvas-error'))
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      image.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

async function saveManyToFirestore(ledgerId: string, importedPeople: Person[], importedRecords: LedgerRecord[], sharedLedger = false) {
  if (!firestore) return
  const operations = [
    ...importedPeople.map((person) => ({ type: 'person' as const, value: person })),
    ...importedRecords.map((record) => ({ type: 'record' as const, value: record })),
  ]

  for (let index = 0; index < operations.length; index += firestoreBatchLimit) {
    const batch = writeBatch(firestore)
    operations.slice(index, index + firestoreBatchLimit).forEach((operation) => {
      if (operation.type === 'person') {
        const targetCollection = sharedLedger ? groupPeopleCollection : peopleCollection
        batch.set(doc(targetCollection(ledgerId), operation.value.id), cleanForFirestore(operation.value), { merge: true })
      } else {
        const targetCollection = sharedLedger ? groupRecordsCollection : recordsCollection
        batch.set(doc(targetCollection(ledgerId), operation.value.id), cleanForFirestore(operation.value), { merge: true })
      }
    })
    await batch.commit()
  }
}

async function deletePersonAndRecordsFromFirestore(ledgerId: string, personIdToDelete: string, recordIds: string[], sharedLedger = false) {
  if (!firestore) return
  const allDeletes = [personIdToDelete, ...recordIds]

  for (let index = 0; index < allDeletes.length; index += firestoreBatchLimit) {
    const batch = writeBatch(firestore)
    allDeletes.slice(index, index + firestoreBatchLimit).forEach((id, offset) => {
      if (index === 0 && offset === 0) {
        batch.delete(doc((sharedLedger ? groupPeopleCollection : peopleCollection)(ledgerId), personIdToDelete))
      } else {
        batch.delete(doc((sharedLedger ? groupRecordsCollection : recordsCollection)(ledgerId), id))
      }
    })
    await batch.commit()
  }
}

function firebaseAuthMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
  if (code === 'auth/configuration-not-found' || code === 'auth/operation-not-allowed') {
    return 'Firebase Auth aun no esta activado. En Firebase Console activa Email/Password y Google en Authentication.'
  }
  if (code === 'auth/popup-closed-by-user') return 'Inicio con Google cancelado.'
  if (code === 'auth/popup-blocked') return 'El navegador bloqueo la ventana de Google. Permite popups para esta pagina.'
  if (code === 'auth/unauthorized-domain') return 'Este dominio no esta autorizado en Firebase Authentication.'
  if (code === 'auth/email-already-in-use') return 'Ya existe una cuenta con ese email.'
  if (code === 'auth/invalid-email') return 'Ese email no parece valido.'
  if (code === 'auth/weak-password') return 'La contrasena es demasiado debil.'
  if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
    return 'Email o contrasena incorrectos.'
  }
  return 'Firebase no pudo completar la operacion. Revisa la configuracion y vuelve a intentarlo.'
}

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>('register')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authHint, setAuthHint] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authInfo, setAuthInfo] = useState('')
  const [recoveryCodeToShow, setRecoveryCodeToShow] = useState('')
  const [changePasswordForm, setChangePasswordForm] = useState({ current: '', next: '', recovery: '' })
  const [accountHint, setAccountHint] = useState('')
  const [googleReady, setGoogleReady] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [records, setRecords] = useState<LedgerRecord[]>([])
  const [groups, setGroups] = useState<SharedGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [groupForm, setGroupForm] = useState({ name: '', memberEmails: '', mode: 'normal' as 'normal' | 'viaje', budget: '' })
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('resumen')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos')
  const [kindFilter, setKindFilter] = useState<KindFilter>('todos')
  const [personFilter, setPersonFilter] = useState('todos')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [personForm, setPersonForm] = useState({ name: '', phone: '', email: '', notes: '', avatar: '' })
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null)
  const [kind, setKind] = useState<RecordKind>('split')
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today)
  const [dueDate, setDueDate] = useState('')
  const [paidBy, setPaidBy] = useState<ActorId>(me)
  const [participantIds, setParticipantIds] = useState<ActorId[]>([me])
  const [shares, setShares] = useState<Record<string, number>>({})
  const [personId, setPersonId] = useState('')
  const [debtDirection, setDebtDirection] = useState<DebtDirection>('owes_me')
  const [paymentDirection, setPaymentDirection] = useState<PaymentDirection>('person_paid_me')
  const [status, setStatus] = useState<RecordStatus>('por-pagar')
  const [repeat, setRepeat] = useState<RepeatRule>('none')
  const [tagText, setTagText] = useState('')
  const [note, setNote] = useState('')
  const [attachment, setAttachment] = useState<{ name: string; data: string } | null>(null)
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [recordSaving, setRecordSaving] = useState(false)
  const [personSaving, setPersonSaving] = useState(false)
  const [smartText, setSmartText] = useState('')
  const [smartError, setSmartError] = useState('')
  const [smartListening, setSmartListening] = useState(false)
  const [balanceSearch, setBalanceSearch] = useState('')
  const [showZeroBalances, setShowZeroBalances] = useState(true)
  const [privacyHidden, setPrivacyHidden] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinUnlock, setPinUnlock] = useState('')
  const [pinConfigured, setPinConfigured] = useState(false)
  const [pinLocked, setPinLocked] = useState(false)
  const [qrPayload, setQrPayload] = useState<{ title: string; text: string } | null>(null)
  const [syncMode, setSyncMode] = useState<SyncMode>(isFirebaseConfigured ? 'cloud' : 'local')
  const [syncMessage, setSyncMessage] = useState(isFirebaseConfigured ? 'Firebase activo' : 'Modo local')
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null
  const activeLedgerId = activeGroup?.id ?? currentUser?.id ?? ''
  const isSharedLedger = Boolean(activeGroup)

  useEffect(() => {
    if (isFirebaseConfigured && firebaseAuth && firestore) {
      setSyncMode('cloud')
      setSyncMessage('Conectando con Firebase...')
      return onAuthStateChanged(firebaseAuth, async (authUser) => {
        if (!authUser) {
          setCurrentUser(null)
          setPeople([])
          setRecords([])
          setGroups([])
          setActiveGroupId(null)
          setSyncMessage('Firebase listo')
          return
        }

        const providerId = authUser.providerData[0]?.providerId
        const fallbackUser: User = {
          id: authUser.uid,
          name: authUser.displayName || authUser.email?.split('@')[0] || 'Usuario',
          email: authUser.email || '',
          passwordHash: '',
          salt: '',
          authProvider: providerId === 'google.com' ? 'google' : 'password',
          googleSub: providerId === 'google.com' ? authUser.uid : undefined,
          createdAt: new Date().toISOString(),
        }
        const snapshot = await getDoc(userDoc(authUser.uid))
        const storedProfile = snapshot.exists() ? (snapshot.data() as Partial<User>) : {}
        const profile = { ...fallbackUser, ...storedProfile, id: authUser.uid, email: authUser.email || storedProfile.email || '' }
        await setDoc(userDoc(authUser.uid), cleanForFirestore(profile), { merge: true })
        setCurrentUser(profile)
        setSyncMessage('Sincronizado con Firebase')
      })
    }

    const sessionId = localStorage.getItem(sessionKey)
    if (!sessionId) return
    db.users.get(sessionId).then((storedUser) => {
      if (storedUser) setCurrentUser(storedUser)
    })
  }, [])

  useEffect(() => {
    if (!currentUser) return
    setAccountHint(currentUser.recoveryHint ?? '')
    setPinConfigured(Boolean(localStorage.getItem(`cuentas-claras-pin-${currentUser.id}`)))
    setPinLocked(false)
    setPinInput('')
    setPinUnlock('')
    if (syncMode !== 'cloud' || !firestore || !currentUser.email) {
      setGroups([])
      setActiveGroupId(null)
      return
    }

    const groupsQuery = firestoreQuery(collection(firestore, 'groups'), where('memberEmails', 'array-contains', currentUser.email))
    return onSnapshot(
      groupsQuery,
      (snapshot) => {
        const nextGroups = snapshot.docs.map((groupSnapshot) => groupSnapshot.data() as SharedGroup).sort((a, b) => a.name.localeCompare(b.name))
        setGroups(nextGroups)
        setActiveGroupId((current) => (current && nextGroups.some((group) => group.id === current) ? current : null))
      },
      () => setSyncMessage('Firebase: error leyendo grupos'),
    )
  }, [currentUser, syncMode])

  useEffect(() => {
    if (!currentUser || !activeLedgerId) return
    if (syncMode === 'cloud' && firestore) {
      const unsubscribePeople = onSnapshot(
        firestoreQuery(ledgerPeopleCollection(activeLedgerId, isSharedLedger)),
        (snapshot) => {
          const nextPeople = snapshot.docs.map((personDoc) => personDoc.data() as Person).sort((a, b) => a.name.localeCompare(b.name))
          setPeople(nextPeople)
          setShares((current) => ({ ...emptyShares(nextPeople), ...current }))
          if (!personId && nextPeople[0]) setPersonId(nextPeople[0].id)
          db.persons.bulkPut(nextPeople).catch(() => undefined)
        },
        () => setSyncMessage('Firebase: error leyendo personas'),
      )
      const unsubscribeRecords = onSnapshot(
        firestoreQuery(ledgerRecordsCollection(activeLedgerId, isSharedLedger)),
        (snapshot) => {
          const nextRecords = sortRecords(snapshot.docs.map((recordDoc) => recordDoc.data() as LedgerRecord))
          setRecords(nextRecords)
          db.records.bulkPut(nextRecords).catch(() => undefined)
        },
        () => setSyncMessage('Firebase: error leyendo movimientos'),
      )
      return () => {
        unsubscribePeople()
        unsubscribeRecords()
      }
    }

    Promise.all([
      db.persons.where('userId').equals(activeLedgerId).sortBy('name'),
      db.records.where('userId').equals(activeLedgerId).toArray(),
    ]).then(([storedPeople, storedRecords]) => {
      setPeople(storedPeople)
      setRecords(sortRecords(storedRecords))
      setShares(emptyShares(storedPeople))
      if (storedPeople[0]) setPersonId(storedPeople[0].id)
    })
  }, [activeLedgerId, currentUser, isSharedLedger, personId, syncMode])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (currentUser || isFirebaseConfigured || !googleClientId) return
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
  // Google Identity Services keeps the callback reference internally; rerendering the script on every state change is noisy.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const dueRecords = useMemo(
    () =>
      records
        .filter((record) => record.dueDate && record.status !== 'pagado')
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
        .slice(0, 5),
    [records],
  )

  const dueStats = useMemo(() => {
    const openDue = records.filter((record) => record.dueDate && record.status !== 'pagado')
    return {
      overdue: openDue.filter((record) => daysUntil(record.dueDate ?? today) < 0).length,
      soon: openDue.filter((record) => {
        const days = daysUntil(record.dueDate ?? today)
        return days >= 0 && days <= 3
      }).length,
    }
  }, [records])

  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return records.filter((record) => {
      if (statusFilter === 'vencidos' && (!record.dueDate || record.status === 'pagado' || daysUntil(record.dueDate) >= 0)) return false
      if (statusFilter !== 'todos' && statusFilter !== 'vencidos' && record.status !== statusFilter) return false
      if (kindFilter !== 'todos' && record.kind !== kindFilter) return false
      if (personFilter !== 'todos' && !recordTouchesPerson(record, personFilter)) return false
      if (dateFrom && record.date < dateFrom) return false
      if (dateTo && record.date > dateTo) return false
      if (!normalized) return true
      const personNames = [...computeSignedByPerson(record).keys()]
        .map((id) => personName(id, people))
        .join(' ')
      return [record.title, record.note, personNames, kindLabels[record.kind], statusLabels[record.status], ...record.tags]
        .join(' ')
        .toLowerCase()
        .includes(normalized)
    })
  }, [dateFrom, dateTo, kindFilter, people, personFilter, query, records, statusFilter])

  const sortedPeople = useMemo(
    () => [...people].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || Math.abs(balances.get(b.id) ?? 0) - Math.abs(balances.get(a.id) ?? 0)),
    [balances, people],
  )

  const visibleBalancePeople = useMemo(() => {
    const normalizedSearch = normalizeText(balanceSearch)
    return sortedPeople.filter((person) => {
      if (!showZeroBalances && Math.abs(balances.get(person.id) ?? 0) <= 0.009) return false
      if (!normalizedSearch) return true
      return [person.name, person.phone, person.email, person.notes].some((value) => normalizeText(value).includes(normalizedSearch))
    })
  }, [balanceSearch, balances, showZeroBalances, sortedPeople])
  const hiddenZeroBalanceCount = sortedPeople.filter((person) => Math.abs(balances.get(person.id) ?? 0) <= 0.009).length

  const focusPeople = useMemo(() => sortedPeople.filter((person) => Math.abs(balances.get(person.id) ?? 0) > 0.009).slice(0, 3), [balances, sortedPeople])

  const quickPlan = useMemo(() => {
    const overdue = records
      .filter((record) => record.dueDate && record.status !== 'pagado' && daysUntil(record.dueDate) < 0)
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))[0]
    if (overdue) {
      return {
        tone: 'warn',
        title: 'Hay vencimientos atrasados',
        copy: `${overdue.title} ${dueLabel(overdue).toLowerCase()}. Conviene revisarlo antes de anadir mas movimientos.`,
        action: 'vencidos',
        button: 'Ver vencidos',
      }
    }

    const toCollect = sortedPeople.find((person) => (balances.get(person.id) ?? 0) > 0)
    const toPay = sortedPeople.find((person) => (balances.get(person.id) ?? 0) < 0)
    if (toCollect && (!toPay || (balances.get(toCollect.id) ?? 0) >= Math.abs(balances.get(toPay.id) ?? 0))) {
      return {
        tone: 'positive',
        title: `Cobrar a ${toCollect.name}`,
        copy: `Es el saldo pendiente mas alto: ${formatMoney(balances.get(toCollect.id) ?? 0)} a tu favor.`,
        action: toCollect.name,
        button: 'Ver movimientos',
      }
    }
    if (toPay) {
      return {
        tone: 'negative',
        title: `Pagar a ${toPay.name}`,
        copy: `Es tu deuda pendiente mas alta: ${formatMoney(Math.abs(balances.get(toPay.id) ?? 0))}.`,
        action: toPay.name,
        button: 'Ver movimientos',
      }
    }

    return {
      tone: 'calm',
      title: records.length ? 'Todo esta cuadrado' : 'Listo para empezar',
      copy: records.length ? 'No hay saldos vivos. El historial queda guardado para consultar o exportar.' : 'Anade personas y movimientos para que la app calcule quien debe a quien.',
      action: '',
      button: records.length ? 'Abrir movimientos' : 'Crear movimiento',
    }
  }, [balances, records, sortedPeople])

  const smartPreview = useMemo(() => {
    if (!smartText.trim()) return ''
    const draft = parseSmartText(smartText, people)
    return 'error' in draft ? draft.error : smartDraftSummary(draft)
  }, [people, smartText])

  const smartExamples = useMemo(() => {
    const uniquePeople = [...people.filter((person) => person.favorite), ...people].filter(
      (person, index, list) => list.findIndex((candidate) => candidate.id === person.id) === index,
    )
    const first = uniquePeople[0]?.name || 'Ana'
    const second = uniquePeople[1]?.name || 'Luis'
    return [
      `${first} me debe 12 por cena vence manana etiqueta comida`,
      `Le debo 8 a ${second} por taxi`,
      `${first} me pago 5 por gasolina`,
      `Divide 48 entre ${first}, ${second} y yo por compra pague yo`,
    ]
  }, [people])

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
  const settlementPlan = useMemo(() => settlementPlanFromBalances(balances), [balances])
  const monthlyStats = useMemo(() => {
    const months = new Map<string, { month: string; plus: number; minus: number; net: number }>()
    records.forEach((record) => {
      if (!shouldCountInOpenBalance(record)) return
      const month = record.date.slice(0, 7)
      const current = months.get(month) ?? { month, plus: 0, minus: 0, net: 0 }
      const impact = recordImpact(record)
      if (impact >= 0) current.plus += impact
      else current.minus += Math.abs(impact)
      current.net += impact
      months.set(month, current)
    })
    return [...months.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6)
  }, [records])
  const activeTripMode = activeGroup?.mode === 'viaje'
  const tripBudget = activeGroup?.budget ?? 0
  const firstPersonId = people[0]?.id ?? ''
  const shareTotal = participantIds.reduce((sum, id) => sum + Number(shares[id] ?? 0), 0)
  const splitDifference = Number((Number(amount || 0) - shareTotal).toFixed(2))
  const selectedPersonBalance = personId ? balances.get(personId) ?? 0 : 0
  const exposureTotal = summary.owedToMe + summary.owedByMe
  const tripRemaining = tripBudget ? tripBudget - exposureTotal : 0
  const owedToMePercent = exposureTotal ? Math.round((summary.owedToMe / exposureTotal) * 100) : 50
  const owedByMePercent = exposureTotal ? 100 - owedToMePercent : 50
  const paidRate = records.length ? Math.round((summary.paidCount / records.length) * 100) : 0

  function openQuickPlan() {
    if (quickPlan.action === 'vencidos') {
      setStatusFilter('vencidos')
      setQuery('')
      setTab('historial')
      return
    }
    if (quickPlan.action) {
      setStatusFilter('todos')
      setQuery(quickPlan.action)
      setTab('historial')
      return
    }
    setTab(records.length ? 'historial' : 'nuevo')
  }

  async function refreshData(ledgerId = activeLedgerId) {
    if (!ledgerId) return
    const [storedPeople, storedRecords] = await Promise.all([
      db.persons.where('userId').equals(ledgerId).sortBy('name'),
      db.records.where('userId').equals(ledgerId).toArray(),
    ])
    setPeople(storedPeople)
    setRecords(sortRecords(storedRecords))
    setShares((current) => ({ ...emptyShares(storedPeople), ...current }))
    if (!personId && storedPeople[0]) setPersonId(storedPeople[0].id)
  }

  async function persistPerson(person: Person) {
    if (syncMode === 'cloud' && firestore) {
      setSyncMessage('Subiendo persona a Firebase...')
      await setDoc(doc(ledgerPeopleCollection(activeLedgerId, isSharedLedger), person.id), cleanForFirestore(person), { merge: true })
      setSyncMessage('Sincronizado con Firebase')
    }
    await db.persons.put(person)
  }

  async function persistRecord(record: LedgerRecord) {
    if (syncMode === 'cloud' && firestore) {
      setSyncMessage('Subiendo movimiento a Firebase...')
      await setDoc(doc(ledgerRecordsCollection(activeLedgerId, isSharedLedger), record.id), cleanForFirestore(record), { merge: true })
      setSyncMessage('Sincronizado con Firebase')
    }
    await db.records.put(record)
  }

  async function removeRecord(record: LedgerRecord) {
    if (syncMode === 'cloud' && firestore) {
      setSyncMessage('Borrando movimiento en Firebase...')
      await deleteDoc(doc(ledgerRecordsCollection(activeLedgerId, isSharedLedger), record.id))
      setSyncMessage('Sincronizado con Firebase')
    }
    await db.records.delete(record.id)
  }

  async function personWithCloudAvatar(person: Person) {
    if (!person.avatar?.startsWith('data:image/')) return person
    if (syncMode !== 'cloud' || !useFirebaseStorage || !firebaseStorage) {
      return { ...person, avatarStoragePath: undefined }
    }
    const avatarPath = `avatars/${person.userId}/${person.id}.jpg`
    try {
      const imageRef = storageRef(firebaseStorage, avatarPath)
      setSyncMessage('Subiendo foto a Firebase Storage...')
      await uploadString(imageRef, person.avatar, 'data_url', { contentType: 'image/jpeg' })
      const avatarUrl = await getDownloadURL(imageRef)
      return { ...person, avatar: avatarUrl, avatarStoragePath: avatarPath }
    } catch {
      setNotice('Storage no esta activo; guardo la foto comprimida sin coste.')
      setSyncMessage('Foto guardada sin Storage')
      return { ...person, avatarStoragePath: undefined }
    }
  }

  async function removeOldCloudAvatarIfNeeded(previousPerson: Person | undefined, nextPerson: Person) {
    if (syncMode !== 'cloud' || !firebaseStorage || !previousPerson?.avatarStoragePath) return
    if (nextPerson.avatar || previousPerson.avatar === nextPerson.avatar) return
    try {
      await deleteObject(storageRef(firebaseStorage, previousPerson.avatarStoragePath))
    } catch {
      setSyncMessage('Foto anterior pendiente de limpiar')
    }
  }

  function finishLogin(user: User) {
    if (syncMode === 'local') localStorage.setItem(sessionKey, user.id)
    setCurrentUser(user)
    setAuthPassword('')
    setAuthHint('')
    setNewPassword('')
    setRecoveryCode('')
    setAuthError('')
    setAuthInfo('')
  }

  async function userWithNewRecovery(user: User) {
    const nextRecoveryCode = makeRecoveryCode()
    const recoverySalt = uid()
    const updatedUser: User = {
      ...user,
      recoveryHash: await hashPassword(normalizeRecoveryCode(nextRecoveryCode), recoverySalt),
      recoverySalt,
      recoveryAlgo: 'pbkdf2',
      recoveryUpdatedAt: new Date().toISOString(),
    }
    return { nextRecoveryCode, updatedUser }
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

  async function signInWithFirebaseGoogle() {
    if (!firebaseAuth) return
    try {
      await signInWithPopup(firebaseAuth, googleProvider)
      setAuthError('')
      setAuthInfo('')
    } catch (error) {
      const message = firebaseAuthMessage(error)
      setAuthError(message)
      if (message.includes('no esta activado')) setSyncMessage('Firebase Auth pendiente de activar')
    }
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')
    setAuthInfo('')
    const email = authEmail.trim().toLowerCase()
    const password = authPassword.trim()
    if (syncMode === 'cloud' && firebaseAuth && firestore) {
      if (!email) {
        setAuthError('Pon tu email.')
        return
      }
      if (authMode === 'recover') {
        try {
          await sendPasswordResetEmail(firebaseAuth, email)
          setAuthInfo('Te he enviado un email para cambiar la contrasena.')
        } catch (error) {
          const message = firebaseAuthMessage(error)
          setAuthError(message)
          if (message.includes('no esta activado')) setSyncMessage('Firebase Auth pendiente de activar')
        }
        return
      }
      if (!password || (authMode === 'register' && !authName.trim())) {
        setAuthError('Completa los campos obligatorios.')
        return
      }
      const problem = passwordProblem(password)
      if (problem) {
        setAuthError(problem)
        return
      }
      try {
        if (authMode === 'register') {
          const credential = await createUserWithEmailAndPassword(firebaseAuth, email, password)
          await updateProfile(credential.user, { displayName: authName.trim() })
          const profile: User = {
            id: credential.user.uid,
            name: authName.trim(),
            email,
            passwordHash: '',
            salt: '',
            authProvider: 'password',
            recoveryHint: authHint.trim(),
            createdAt: new Date().toISOString(),
          }
          await setDoc(userDoc(credential.user.uid), cleanForFirestore(profile), { merge: true })
          setAuthHint('')
          return
        }
        await signInWithEmailAndPassword(firebaseAuth, email, password)
        return
      } catch (error) {
        const message = firebaseAuthMessage(error)
        setAuthError(message)
        if (message.includes('no esta activado')) setSyncMessage('Firebase Auth pendiente de activar')
        return
      }
    }

    if (authMode === 'recover') {
      await submitRecovery(email)
      return
    }

    if (!email || !password || (authMode === 'register' && !authName.trim())) {
      setAuthError('Completa los campos obligatorios.')
      return
    }

    if (authMode === 'register') {
      const problem = passwordProblem(password)
      if (problem) {
        setAuthError(problem)
        return
      }
      const exists = await db.users.where('email').equals(email).first()
      if (exists) {
        setAuthError('Ya existe una cuenta con ese email.')
        return
      }
      const salt = uid()
      const baseUser: User = {
        id: uid(),
        name: authName.trim(),
        email,
        passwordHash: await hashPassword(password, salt),
        salt,
        passwordAlgo: 'pbkdf2',
        authProvider: 'password',
        recoveryHint: authHint.trim(),
        createdAt: new Date().toISOString(),
      }
      const { nextRecoveryCode, updatedUser: user } = await userWithNewRecovery(baseUser)
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
    if (!(await verifySecret(password, user.salt, user.passwordHash, user.passwordAlgo))) {
      setAuthError('Contrasena incorrecta.')
      return
    }
    if (user.passwordAlgo !== 'pbkdf2') {
      const salt = uid()
      const migratedUser = { ...user, passwordHash: await hashPassword(password, salt), salt, passwordAlgo: 'pbkdf2' as const }
      await db.users.put(migratedUser)
      finishLogin(migratedUser)
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
    const problem = passwordProblem(password)
    if (problem) {
      setAuthError(problem)
      return
    }
    const user = await db.users.where('email').equals(email).first()
    if (!user?.recoveryHash || !user.recoverySalt) {
      setAuthError('Esa cuenta no tiene codigo de recuperacion creado en esta pagina.')
      return
    }
    if (!(await verifySecret(code, user.recoverySalt, user.recoveryHash, user.recoveryAlgo))) {
      setAuthError('Codigo de recuperacion incorrecto.')
      return
    }
    const salt = uid()
    const updatedUser: User = {
      ...user,
      authProvider: user.authProvider ?? 'password',
      passwordHash: await hashPassword(password, salt),
      salt,
      passwordAlgo: 'pbkdf2',
    }
    await db.users.put(updatedUser)
    finishLogin(updatedUser)
    setNotice('Contrasena actualizada.')
  }

  async function generateRecoveryForCurrentUser() {
    if (!currentUser) return
    const { nextRecoveryCode, updatedUser } = await userWithNewRecovery(currentUser)
    await db.users.put(updatedUser)
    setCurrentUser(updatedUser)
    setRecoveryCodeToShow(nextRecoveryCode)
    setNotice('Codigo de recuperacion creado.')
  }

  function downloadRecoveryKit() {
    if (!currentUser || !recoveryCodeToShow) return
    downloadFile(`cuentas-claras-recuperacion-${currentUser.email}.json`, recoveryKitContent(currentUser, recoveryCodeToShow), 'application/json')
    setNotice('Kit de recuperacion descargado.')
  }

  async function saveRecoveryHint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser) return
    const updatedUser = { ...currentUser, recoveryHint: accountHint.trim() }
    await db.users.put(updatedUser)
    setCurrentUser(updatedUser)
    setNotice(accountHint.trim() ? 'Pista de recuperacion guardada.' : 'Pista eliminada.')
  }

  async function showRecoveryHint() {
    const email = authEmail.trim().toLowerCase()
    if (!email) {
      setAuthError('Pon tu email para buscar la pista.')
      return
    }
    const user = await db.users.where('email').equals(email).first()
    setAuthError('')
    if (!user) {
      setAuthInfo('No hay una cuenta local con ese email en este dispositivo.')
      return
    }
    setAuthInfo(user.recoveryHint ? `Pista: ${user.recoveryHint}` : 'Esta cuenta no tiene pista guardada.')
  }

  async function importRecoveryKit(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const payload = JSON.parse(await file.text()) as RecoveryKitPayload
      const code = payload.recoveryCode?.trim()
      const email = payload.email?.trim().toLowerCase()
      if (payload.app !== 'cuentas-claras' || payload.type !== 'recovery-kit' || !email || !code) {
        setAuthError('Ese archivo no parece un kit valido de Cuentas claras.')
        return
      }
      setAuthEmail(email)
      setRecoveryCode(code)
      setAuthError('')
      setAuthInfo('Kit cargado. Pon una contrasena nueva y pulsa Cambiar y entrar.')
    } catch {
      setAuthError('No se pudo leer el kit de recuperacion.')
    } finally {
      event.target.value = ''
    }
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
    const problem = passwordProblem(next)
    if (problem) {
      setNotice(problem)
      return
    }

    const canUseCurrentPassword =
      currentUser.passwordHash &&
      (await verifySecret(changePasswordForm.current.trim(), currentUser.salt, currentUser.passwordHash, currentUser.passwordAlgo))
    const canUseRecovery =
      currentUser.recoveryHash &&
      currentUser.recoverySalt &&
      (await verifySecret(normalizeRecoveryCode(changePasswordForm.recovery), currentUser.recoverySalt, currentUser.recoveryHash, currentUser.recoveryAlgo))

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
      passwordAlgo: 'pbkdf2',
    }
    await db.users.put(updatedUser)
    setCurrentUser(updatedUser)
    setChangePasswordForm({ current: '', next: '', recovery: '' })
    setNotice('Contrasena cambiada.')
  }

  async function submitPerson(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser || !activeLedgerId || !personForm.name.trim() || personSaving) return
    const previousPerson = people.find((person) => person.id === editingPersonId)
    const person: Person = {
      id: editingPersonId ?? uid(),
      userId: activeLedgerId,
      name: personForm.name.trim(),
      phone: personForm.phone.trim(),
      email: personForm.email.trim(),
      notes: personForm.notes.trim(),
      avatar: personForm.avatar,
      avatarStoragePath: previousPerson?.avatarStoragePath,
      createdAt: previousPerson?.createdAt ?? new Date().toISOString(),
    }
    setPersonSaving(true)
    try {
      const personToSave = await personWithCloudAvatar(person)
      await removeOldCloudAvatarIfNeeded(previousPerson, personToSave)
      await persistPerson(personToSave)
      setPersonForm({ name: '', phone: '', email: '', notes: '', avatar: '' })
      setEditingPersonId(null)
      setPersonId(personToSave.id)
      setParticipantIds((current) => [...new Set([...current, personToSave.id])])
      if (syncMode === 'local') await refreshData()
      setNotice(editingPersonId ? 'Persona actualizada.' : 'Persona anadida.')
    } catch {
      setNotice('No se pudo guardar la persona. Intentalo de nuevo.')
    } finally {
      setPersonSaving(false)
    }
  }

  function startEditPerson(person: Person) {
    setPersonForm({ name: person.name, phone: person.phone, email: person.email, notes: person.notes, avatar: person.avatar ?? '' })
    setEditingPersonId(person.id)
    setTab('personas')
  }

  function resetPersonForm() {
    setPersonForm({ name: '', phone: '', email: '', notes: '', avatar: '' })
    setEditingPersonId(null)
  }

  async function handlePersonAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const avatar = await imageFileToAvatar(file)
      setPersonForm((current) => ({ ...current, avatar }))
      setNotice('Foto preparada.')
    } catch {
      setNotice('No se pudo cargar esa foto.')
    } finally {
      event.target.value = ''
    }
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
    setDueDate('')
    setPaidBy(me)
    setParticipantIds([me])
    setShares(emptyShares(people))
    setPersonId(firstPersonId)
    setDebtDirection('owes_me')
    setPaymentDirection('person_paid_me')
    setStatus('por-pagar')
    setRepeat('none')
    setTagText('')
    setNote('')
    setAttachment(null)
    setEditingRecordId(null)
    setFormError('')
  }

  async function ensurePersonByName(name: string) {
    const cleanedName = name.trim()
    const existing = people.find((person) => normalizeText(person.name) === normalizeText(cleanedName))
    if (existing) return existing
    const person: Person = {
      id: uid(),
      userId: activeLedgerId,
      name: cleanedName,
      phone: '',
      email: '',
      notes: 'Creada desde entrada inteligente',
      avatar: '',
      createdAt: new Date().toISOString(),
    }
    await persistPerson(person)
    return person
  }

  function applySmartDraftToForm(draft: SmartDraft) {
    setKind(draft.kind)
    setTitle(draft.title)
    setAmount(String(draft.amount))
    setDate(today)
    setDueDate(draft.dueDate ?? '')
    setStatus(draft.status)
    setTagText(draft.tags.join(', '))
    setNote(draft.note)
    if (draft.kind === 'split') {
      const participantNames = draft.personNames?.length ? draft.personNames : ['me', ...people.map((person) => person.name)]
      const ids = participantNames
        .map((name) => (name === 'me' ? me : people.find((person) => normalizeText(person.name) === normalizeText(name))?.id))
        .filter(Boolean) as ActorId[]
      const nextParticipantIds = ids.includes(me) ? ids : [me, ...ids]
      const share = Number((draft.amount / nextParticipantIds.length).toFixed(2))
      setParticipantIds(nextParticipantIds)
      setPaidBy(draft.paidByName === 'me' ? me : people.find((person) => normalizeText(person.name) === normalizeText(draft.paidByName ?? ''))?.id ?? me)
      setShares(Object.fromEntries(nextParticipantIds.map((id, index) => [id, index === nextParticipantIds.length - 1 ? Number((draft.amount - share * (nextParticipantIds.length - 1)).toFixed(2)) : share])))
    } else {
      const selected = people.find((person) => normalizeText(person.name) === normalizeText(draft.personName ?? ''))
      if (selected) setPersonId(selected.id)
      if (draft.kind === 'debt') setDebtDirection(draft.direction === 'i_owe' ? 'i_owe' : 'owes_me')
      if (draft.kind === 'payment') setPaymentDirection(draft.direction === 'i_paid_person' ? 'i_paid_person' : 'person_paid_me')
    }
    setFormError('')
  }

  function parsedSmartDraft() {
    const draft = parseSmartText(smartText, people)
    if ('error' in draft) {
      setSmartError(draft.error)
      return null
    }
    setSmartError('')
    return draft
  }

  function fillFromSmartText() {
    const draft = parsedSmartDraft()
    if (!draft) return
    applySmartDraftToForm(draft)
    setNotice('Formulario rellenado desde la frase.')
  }

  async function saveFromSmartText() {
    if (!currentUser || !activeLedgerId || recordSaving) return
    const draft = parsedSmartDraft()
    if (!draft) return
    if (draft.kind !== 'split' && !draft.personName?.trim()) {
      setSmartError('No he detectado la persona. Prueba: "Ana me debe 12 por cena".')
      return
    }

    setRecordSaving(true)
    try {
      const createdAt = new Date().toISOString()
      const record: LedgerRecord = {
        id: uid(),
        userId: activeLedgerId,
        kind: draft.kind,
        title: draft.title,
        amount: draft.amount,
        currency: 'EUR',
        date: today,
        tags: draft.tags,
        status: draft.status,
        dueDate: draft.dueDate,
        note: draft.note,
        createdAt,
      }

      if (draft.kind === 'split') {
        const names = draft.personNames?.length ? draft.personNames : ['me', ...people.map((person) => person.name)]
        const participants = [] as ActorId[]
        for (const name of names) {
          if (name === 'me') participants.push(me)
          else participants.push((await ensurePersonByName(name)).id)
        }
        const uniqueParticipants = [...new Set(participants)]
        if (!uniqueParticipants.includes(me)) uniqueParticipants.unshift(me)
        const paidBy = draft.paidByName && draft.paidByName !== 'me' ? (await ensurePersonByName(draft.paidByName)).id : me
        const baseCents = Math.round((draft.amount * 100) / uniqueParticipants.length)
        let remainingCents = Math.round(draft.amount * 100)
        record.paidBy = paidBy
        record.participantIds = uniqueParticipants
        record.shares = Object.fromEntries(
          uniqueParticipants.map((id, index) => {
            const cents = index === uniqueParticipants.length - 1 ? remainingCents : baseCents
            remainingCents -= cents
            return [id, cents / 100]
          }),
        )
      } else {
        const person = await ensurePersonByName(draft.personName ?? '')
        record.personId = person.id
        record.direction = draft.direction
      }

      await persistRecord(record)
      await refreshData()
      resetRecordForm()
      setSmartText('')
      setNotice('Movimiento creado desde entrada inteligente.')
      setTab('resumen')
    } catch {
      setSmartError('No se pudo guardar desde la frase. Revisa el texto e intentalo de nuevo.')
    } finally {
      setRecordSaving(false)
    }
  }

  function startSmartListening() {
    type SpeechRecognitionResultEvent = { results: ArrayLike<{ 0: { transcript: string } }> }
    type SpeechRecognitionLike = {
      lang: string
      interimResults: boolean
      onresult: ((event: SpeechRecognitionResultEvent) => void) | null
      onerror: (() => void) | null
      onend: (() => void) | null
      start: () => void
    }
    const recognitionConstructor = (window as Window & {
      SpeechRecognition?: new () => SpeechRecognitionLike
      webkitSpeechRecognition?: new () => SpeechRecognitionLike
    }).SpeechRecognition ?? (window as Window & { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition
    if (!recognitionConstructor) {
      setSmartError('Tu navegador no deja usar microfono aqui. Puedes dictar con el teclado del iPhone o escribir la frase.')
      return
    }
    const recognition = new recognitionConstructor()
    recognition.lang = 'es-ES'
    recognition.interimResults = false
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript
      if (transcript) setSmartText(transcript)
    }
    recognition.onerror = () => {
      setSmartError('No pude escuchar bien. Prueba otra vez o escribe la frase.')
      setSmartListening(false)
    }
    recognition.onend = () => setSmartListening(false)
    setSmartListening(true)
    recognition.start()
  }

  function validateRecordForm() {
    const numericAmount = Number(amount)
    if (!title.trim()) return 'Pon un concepto.'
    if (!numericAmount || numericAmount <= 0) return 'Pon un importe mayor que cero.'
    if (dueDate && dueDate < date) return 'El vencimiento no puede ser anterior a la fecha del movimiento.'
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
    if (!currentUser || !activeLedgerId || recordSaving) return
    const validationError = validateRecordForm()
    if (validationError) {
      setFormError(validationError)
      return
    }

    const existing = editingRecordId ? records.find((record) => record.id === editingRecordId) : undefined
    const numericAmount = Number(amount)
    const record: LedgerRecord = {
      id: existing?.id ?? uid(),
      userId: activeLedgerId,
      kind,
      title: title.trim(),
      amount: numericAmount,
      currency: 'EUR',
      date,
      tags: tagsFromText(tagText),
      status,
      repeat,
      dueDate: dueDate || undefined,
      attachmentName: attachment?.name,
      attachmentData: attachment?.data,
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

    setRecordSaving(true)
    try {
      await persistRecord(record)
      if (syncMode === 'local') await refreshData()
      setNotice(editingRecordId ? 'Movimiento actualizado.' : 'Movimiento guardado.')
      resetRecordForm()
      setTab('resumen')
    } catch {
      setFormError('No se pudo guardar el movimiento. Intentalo de nuevo.')
    } finally {
      setRecordSaving(false)
    }
  }

  function startEditRecord(record: LedgerRecord) {
    setKind(record.kind)
    setTitle(record.title)
    setAmount(String(record.amount))
    setDate(record.date)
    setDueDate(record.dueDate ?? '')
    setPaidBy(record.paidBy ?? me)
    setParticipantIds(record.participantIds ?? [me])
    setShares({ ...emptyShares(people), ...(record.shares ?? {}) })
    setPersonId(record.personId ?? firstPersonId)
    setDebtDirection(record.direction === 'i_owe' ? 'i_owe' : 'owes_me')
    setPaymentDirection(record.direction === 'i_paid_person' ? 'i_paid_person' : 'person_paid_me')
    setStatus(record.status)
    setRepeat(record.repeat ?? 'none')
    setTagText(record.tags.join(', '))
    setNote(record.note)
    setAttachment(record.attachmentData ? { name: record.attachmentName ?? 'adjunto', data: record.attachmentData } : null)
    setEditingRecordId(record.id)
    setFormError('')
    setTab('nuevo')
  }

  function duplicateRecordDraft(record: LedgerRecord) {
    setKind(record.kind)
    setTitle(record.title)
    setAmount(String(record.amount))
    setDate(today)
    setDueDate('')
    setPaidBy(record.paidBy ?? me)
    setParticipantIds(record.participantIds ?? [me])
    setShares({ ...emptyShares(people), ...(record.shares ?? {}) })
    setPersonId(record.personId ?? firstPersonId)
    setDebtDirection(record.direction === 'i_owe' ? 'i_owe' : 'owes_me')
    setPaymentDirection(record.direction === 'i_paid_person' ? 'i_paid_person' : 'person_paid_me')
    setStatus('por-pagar')
    setRepeat(record.repeat ?? 'none')
    setTagText(record.tags.join(', '))
    setNote(record.note)
    setAttachment(record.attachmentData ? { name: record.attachmentName ?? 'adjunto', data: record.attachmentData } : null)
    setEditingRecordId(null)
    setFormError('')
    setNotice('Movimiento duplicado como borrador. Revisa y guarda.')
    setTab('nuevo')
  }

  async function handleAttachment(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const nextAttachment = await attachmentFileToData(file)
      setAttachment(nextAttachment)
      setNotice('Adjunto preparado.')
    } catch {
      setNotice('El adjunto es demasiado grande. Usa una imagen o PDF pequeno.')
    } finally {
      event.target.value = ''
    }
  }

  async function deleteRecord(recordId: string) {
    const record = records.find((candidate) => candidate.id === recordId)
    if (!record) return
    await removeRecord(record)
    if (syncMode === 'local') await refreshData()
    setNotice('Movimiento borrado.')
  }

  async function markRecordStatus(record: LedgerRecord, nextStatus: RecordStatus) {
    await persistRecord({ ...record, status: nextStatus })
    if (syncMode === 'local') await refreshData()
    setNotice(`Movimiento marcado como ${statusLabels[nextStatus].toLowerCase()}.`)
  }

  async function createNextRecurring(record: LedgerRecord) {
    if (!currentUser || !activeLedgerId || !record.repeat || record.repeat === 'none') return
    const nextDate = nextRepeatDate(record.date, record.repeat)
    const nextRecord: LedgerRecord = {
      ...record,
      id: uid(),
      date: nextDate,
      dueDate: record.dueDate ? nextRepeatDate(record.dueDate, record.repeat) : undefined,
      status: 'por-pagar',
      createdAt: new Date().toISOString(),
    }
    await persistRecord(nextRecord)
    if (syncMode === 'local') await refreshData()
    setNotice('Siguiente movimiento recurrente creado.')
  }

  async function shareRecord(record: LedgerRecord) {
    const peopleText = [...computeSignedByPerson(record).keys()].map((id) => personName(id, people)).join(', ') || 'Yo'
    const text = `${record.title} - ${formatMoney(record.amount)} - ${peopleText} - ${statusLabels[record.status]}`
    try {
      if (navigator.share) await navigator.share({ title: 'Cuentas claras', text })
      else await navigator.clipboard?.writeText(text)
      setNotice('Movimiento compartido.')
    } catch {
      setNotice('No se pudo compartir.')
    }
  }

  function settlementText() {
    if (settlementPlan.length === 0) return 'No hay pagos pendientes para cerrar en Cuentas claras.'
    return settlementPlan
      .map((item) => `${personName(item.from, people)} paga ${formatMoney(item.amount)} a ${personName(item.to, people)}`)
      .join('\n')
  }

  async function copySettlementPlan() {
    try {
      await navigator.clipboard?.writeText(settlementText())
      setNotice('Plan copiado.')
    } catch {
      setNotice('No se pudo copiar.')
    }
  }

  async function shareSettlementPlan() {
    const text = settlementText()
    try {
      if (navigator.share) await navigator.share({ title: 'Cierre de Cuentas claras', text })
      else await navigator.clipboard?.writeText(text)
      setNotice('Plan listo para compartir.')
    } catch {
      setNotice('No se pudo compartir el plan.')
    }
  }

  async function settleAllOpenRecords() {
    const openRecords = records.filter((record) => record.status !== 'pagado')
    if (openRecords.length === 0) return
    await Promise.all(openRecords.map((record) => persistRecord({ ...record, status: 'pagado' })))
    if (syncMode === 'local') await refreshData()
    setNotice('Cuenta cerrada: movimientos abiertos marcados como pagados.')
  }

  async function markFilteredAsPaid() {
    const openFiltered = filteredRecords.filter((record) => record.status !== 'pagado')
    if (openFiltered.length === 0) {
      setNotice('No hay movimientos filtrados pendientes.')
      return
    }
    await Promise.all(openFiltered.map((record) => persistRecord({ ...record, status: 'pagado' })))
    if (syncMode === 'local') await refreshData()
    setNotice(`${openFiltered.length} movimientos filtrados marcados como pagados.`)
  }

  async function toggleFavoritePerson(person: Person) {
    const nextPerson = { ...person, favorite: !person.favorite }
    await persistPerson(nextPerson)
    if (syncMode === 'local') await refreshData()
    setNotice(nextPerson.favorite ? `${person.name} esta en favoritos.` : `${person.name} quitado de favoritos.`)
  }

  async function enableNotifications() {
    if (!('Notification' in window)) {
      setNotice('Este navegador no soporta notificaciones web.')
      return
    }
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      setNotice('Notificaciones no activadas.')
      return
    }
    const due = dueRecords[0]
    new Notification('Cuentas claras', {
      body: due ? `${due.title}: ${dueLabel(due)}` : 'Notificaciones activadas para tus vencimientos.',
    })
    setNotice('Notificaciones activadas.')
  }

  async function savePin() {
    if (!currentUser) return
    const pin = pinInput.trim()
    if (!/^\d{4,8}$/.test(pin)) {
      setNotice('Usa un PIN de 4 a 8 numeros.')
      return
    }
    const hash = await hashSha256(pin, currentUser.id)
    localStorage.setItem(`cuentas-claras-pin-${currentUser.id}`, hash)
    setPinConfigured(true)
    setPinInput('')
    setNotice('PIN activado.')
  }

  async function unlockPin() {
    if (!currentUser) return
    const stored = localStorage.getItem(`cuentas-claras-pin-${currentUser.id}`)
    const hash = await hashSha256(pinUnlock.trim(), currentUser.id)
    if (stored && stored === hash) {
      setPinLocked(false)
      setPinUnlock('')
      setNotice('App desbloqueada.')
      return
    }
    setNotice('PIN incorrecto.')
  }

  function disablePin() {
    if (!currentUser) return
    localStorage.removeItem(`cuentas-claras-pin-${currentUser.id}`)
    setPinConfigured(false)
    setPinInput('')
    setPinUnlock('')
    setPinLocked(false)
    setNotice('PIN desactivado.')
  }

  function inviteText(group: SharedGroup) {
    return `Te invito a "${group.name}" en Cuentas claras. Entra en https://paco4gn.github.io/cuentas-claras/ con este email incluido en el grupo: ${group.memberEmails.join(', ')}. Codigo: ${group.inviteCode ?? group.id.slice(0, 8)}`
  }

  async function copyInvite(group: SharedGroup) {
    try {
      await navigator.clipboard?.writeText(inviteText(group))
      setNotice('Invitacion copiada.')
    } catch {
      setNotice('No se pudo copiar la invitacion.')
    }
  }

  function openPersonQr(person: Person) {
    const balance = Number((balances.get(person.id) ?? 0).toFixed(2))
    const text = balance > 0
      ? `${person.name} debe ${formatMoney(balance)} en Cuentas claras`
      : balance < 0
        ? `Debo ${formatMoney(Math.abs(balance))} a ${person.name} en Cuentas claras`
        : `${person.name} esta a cero en Cuentas claras`
    setQrPayload({ title: person.name, text })
  }

  async function settlePerson(person: Person) {
    if (!currentUser || !activeLedgerId) return
    const balance = Number((balances.get(person.id) ?? 0).toFixed(2))
    if (balance === 0) return
    const openPersonRecords = records.filter((record) => record.status !== 'pagado' && recordTouchesPerson(record, person.id))
    await Promise.all(openPersonRecords.map((record) => persistRecord({ ...record, status: 'pagado' })))
    if (syncMode === 'local') await refreshData()
    setNotice(`Saldo de ${person.name} liquidado.`)
  }

  function startQuickPayment(person: Person) {
    const balance = Number((balances.get(person.id) ?? 0).toFixed(2))
    if (balance === 0) return
    setKind('payment')
    setTitle(balance > 0 ? `Pago de ${person.name}` : `Pago a ${person.name}`)
    setAmount(String(Math.abs(balance)))
    setDate(today)
    setDueDate('')
    setPaidBy(me)
    setParticipantIds([me])
    setShares(emptyShares(people))
    setPersonId(person.id)
    setDebtDirection('owes_me')
    setPaymentDirection(balance > 0 ? 'person_paid_me' : 'i_paid_person')
    setStatus('por-pagar')
    setRepeat('none')
    setTagText('pago')
    setNote(`Pago rapido para cuadrar ${person.name}`)
    setAttachment(null)
    setEditingRecordId(null)
    setFormError('')
    setNotice('Pago rapido preparado. Revisa y guarda.')
    setTab('nuevo')
  }

  function reminderHref(person: Person) {
    const balance = Number((balances.get(person.id) ?? 0).toFixed(2))
    if (balance === 0) return ''
    const text =
      balance > 0
        ? `Hola ${person.name}, en Cuentas claras me sale pendiente ${formatMoney(balance)}. Cuando puedas lo cuadramos.`
        : `Hola ${person.name}, en Cuentas claras me sale que te debo ${formatMoney(Math.abs(balance))}. Dime como prefieres que lo cuadre.`
    const normalizedPhone = person.phone.replace(/[^\d+]/g, '')
    const whatsappPhone =
      normalizedPhone.startsWith('+') || normalizedPhone.length !== 9 ? normalizedPhone.replace(/^\+/, '') : `34${normalizedPhone}`
    if (whatsappPhone) return `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(text)}`
    if (person.email) return `mailto:${person.email}?subject=${encodeURIComponent('Cuentas claras')}&body=${encodeURIComponent(text)}`
    return ''
  }

  async function deletePerson(id: string) {
    const hasRecords = records.some(
      (record) => record.personId === id || record.paidBy === id || record.participantIds?.includes(id),
    )
    if (hasRecords && !window.confirm('Esta persona tiene movimientos. Si la borras tambien se borraran esos movimientos.')) {
      return
    }
    if (currentUser && activeLedgerId && syncMode === 'cloud' && firestore) {
      const relatedIds = records
        .filter((record) => record.personId === id || record.paidBy === id || record.participantIds?.includes(id))
        .map((record) => record.id)
      await deletePersonAndRecordsFromFirestore(activeLedgerId, id, relatedIds, isSharedLedger)
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
    if (syncMode === 'local') await refreshData()
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

  function recordsToCsv(sourceRecords: LedgerRecord[]) {
    const header = ['fecha', 'vence', 'tipo', 'concepto', 'persona', 'importe', 'impacto', 'estado', 'repeticion', 'adjunto', 'etiquetas', 'nota']
    const rows = sourceRecords.map((record) => {
      const signed = [...computeSignedByPerson(record).values()].reduce((sum, value) => sum + value, 0)
      const names = [...computeSignedByPerson(record).keys()].map((id) => personName(id, people)).join(' | ')
      return [
        record.date,
        record.dueDate ?? '',
        kindLabels[record.kind],
        record.title,
        names || 'Yo',
        record.amount,
        signed,
        statusLabels[record.status],
        record.repeat && record.repeat !== 'none' ? record.repeat : '',
        record.attachmentName ?? '',
        record.tags.join(' | '),
        record.note,
      ].map(csvEscape)
    })
    return [header, ...rows].map((row) => row.join(',')).join('\n')
  }

  function exportCsv() {
    downloadFile(`cuentas-claras-${today}.csv`, recordsToCsv(records), 'text/csv')
  }

  function exportFilteredCsv() {
    downloadFile(`cuentas-claras-filtrado-${today}.csv`, recordsToCsv(filteredRecords), 'text/csv')
  }

  function exportCalendar() {
    const openDueRecords = records.filter((record) => record.dueDate && record.status !== 'pagado')
    const events = openDueRecords.map((record) => {
      const names = [...computeSignedByPerson(record).keys()].map((id) => personName(id, people)).join(', ') || 'Yo'
      const signed = [...computeSignedByPerson(record).values()].reduce((sum, value) => sum + value, 0)
      const description = [
        `${kindLabels[record.kind]} - ${statusLabels[record.status]}`,
        `Personas: ${names}`,
        `Importe: ${formatMoney(record.amount)}`,
        `Impacto vivo: ${formatMoney(signed)}`,
        record.tags.length ? `Etiquetas: ${record.tags.join(', ')}` : '',
        record.note,
      ].filter(Boolean).join('\n')
      return [
        'BEGIN:VEVENT',
        `UID:${record.id}@cuentas-claras`,
        `DTSTAMP:${dateToIcs(today)}T000000Z`,
        `DTSTART;VALUE=DATE:${dateToIcs(record.dueDate ?? record.date)}`,
        `SUMMARY:${icsEscape(`Cuentas claras: ${record.title}`)}`,
        `DESCRIPTION:${icsEscape(description)}`,
        'END:VEVENT',
      ].join('\r\n')
    })
    const content = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Cuentas Claras//ES',
      'CALSCALE:GREGORIAN',
      ...events,
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    downloadFile(`cuentas-claras-vencimientos-${today}.ics`, content, 'text/calendar')
    setNotice(openDueRecords.length ? `${openDueRecords.length} vencimientos exportados al calendario.` : 'Calendario exportado sin vencimientos pendientes.')
  }

  async function importData(event: React.ChangeEvent<HTMLInputElement>) {
    if (!currentUser || !activeLedgerId || !event.target.files?.[0]) return
    try {
      const payload = JSON.parse(await event.target.files[0].text()) as ImportPayload
      const importedPeople = (payload.persons ?? payload.people ?? []).map((person) => ({
        ...person,
        userId: activeLedgerId,
      }))
      const importedRecords = (payload.records ?? []).map((record) => ({
        ...record,
        userId: activeLedgerId,
      }))
      if (syncMode === 'cloud' && firestore) {
        await saveManyToFirestore(activeLedgerId, importedPeople, importedRecords, isSharedLedger)
      }
      await db.transaction('rw', db.persons, db.records, async () => {
        await db.persons.bulkPut(importedPeople)
        await db.records.bulkPut(importedRecords)
      })
      if (syncMode === 'local') await refreshData()
      setNotice('Datos importados.')
    } catch {
      setNotice('No se pudo importar el archivo.')
    } finally {
      event.target.value = ''
    }
  }

  async function migrateLocalDataToFirebase() {
    if (!currentUser || syncMode !== 'cloud' || !firestore) return
    if (isSharedLedger) {
      setNotice('Cambia a Personal para subir tus datos locales.')
      return
    }
    const matchingLocalUser = await db.users.where('email').equals(currentUser.email).first()
    const candidateUserIds = [...new Set([currentUser.id, matchingLocalUser?.id].filter(Boolean) as string[])]
    const [localPeopleGroups, localRecordGroups] = await Promise.all([
      Promise.all(candidateUserIds.map((userId) => db.persons.where('userId').equals(userId).toArray())),
      Promise.all(candidateUserIds.map((userId) => db.records.where('userId').equals(userId).toArray())),
    ])
    const localPeople = localPeopleGroups.flat().map((person) => ({ ...person, userId: currentUser.id }))
    const localRecords = localRecordGroups.flat().map((record) => ({ ...record, userId: currentUser.id }))
    if (localPeople.length === 0 && localRecords.length === 0) {
      setNotice('No hay datos locales que subir.')
      return
    }
    await saveManyToFirestore(currentUser.id, localPeople, localRecords)
    await db.persons.bulkPut(localPeople)
    await db.records.bulkPut(localRecords)
    setNotice('Datos locales subidos a Firebase.')
  }

  function selectLedger(groupId: string | null) {
    setActiveGroupId(groupId)
    setPeople([])
    setRecords([])
    setPersonId('')
    setEditingPersonId(null)
    setEditingRecordId(null)
    setTab('resumen')
    setSyncMessage(groupId ? 'Grupo compartido activo' : syncMode === 'cloud' ? 'Libreta personal activa' : 'Modo local')
  }

  async function submitGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentUser || syncMode !== 'cloud' || !firestore || !currentUser.email) {
      setNotice('Los grupos compartidos necesitan Firebase.')
      return
    }
    const name = groupForm.name.trim()
    if (!name) {
      setNotice('Pon un nombre para el grupo.')
      return
    }
    const existing = editingGroupId ? groups.find((group) => group.id === editingGroupId) : undefined
    const memberEmails = [...new Set([currentUser.email, ...emailsFromText(groupForm.memberEmails)])]
    const budget = Number(groupForm.budget)
    const group: SharedGroup = {
      id: existing?.id ?? uid(),
      name,
      ownerId: existing?.ownerId ?? currentUser.id,
      ownerEmail: existing?.ownerEmail ?? currentUser.email,
      memberEmails,
      mode: groupForm.mode,
      budget: budget > 0 ? budget : undefined,
      inviteCode: existing?.inviteCode ?? uid().slice(0, 8).toUpperCase(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await setDoc(groupDoc(group.id), cleanForFirestore(group), { merge: true })
    setGroupForm({ name: '', memberEmails: '', mode: 'normal', budget: '' })
    setEditingGroupId(null)
    setActiveGroupId(group.id)
    setNotice(existing ? 'Grupo actualizado.' : 'Grupo creado.')
  }

  function startEditGroup(group: SharedGroup) {
    setGroupForm({ name: group.name, memberEmails: group.memberEmails.filter((email) => email !== currentUser?.email).join(', '), mode: group.mode ?? 'normal', budget: group.budget ? String(group.budget) : '' })
    setEditingGroupId(group.id)
    setTab('grupos')
  }

  async function leaveGroup(group: SharedGroup) {
    if (!currentUser?.email || !firestore) return
    if (group.ownerId === currentUser.id) {
      setNotice('Eres propietario. Borra el grupo si quieres cerrarlo.')
      return
    }
    const memberEmails = group.memberEmails.filter((email) => email !== currentUser.email)
    await setDoc(groupDoc(group.id), { memberEmails, updatedAt: new Date().toISOString() }, { merge: true })
    if (activeGroupId === group.id) selectLedger(null)
    setNotice('Has salido del grupo.')
  }

  async function deleteGroup(group: SharedGroup) {
    if (!currentUser || !firestore || group.ownerId !== currentUser.id) return
    if (!window.confirm('Vas a borrar este grupo compartido para todos.')) return
    await deleteDoc(groupDoc(group.id))
    if (activeGroupId === group.id) selectLedger(null)
    setNotice('Grupo borrado.')
  }

  async function refreshInstalledApp() {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.update()))
    }
    if ('caches' in window) {
      const cacheKeys = await caches.keys()
      await Promise.all(cacheKeys.filter((key) => key.startsWith('cuentas-claras-')).map((key) => caches.delete(key)))
    }
    setNotice('App actualizada. Recargo la pagina...')
    window.setTimeout(() => window.location.reload(), 500)
  }

  function signOut() {
    if (syncMode === 'cloud' && firebaseAuth) {
      firebaseSignOut(firebaseAuth).catch(() => undefined)
    }
    localStorage.removeItem(sessionKey)
    setCurrentUser(null)
    setGroups([])
    setActiveGroupId(null)
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
              {syncMode === 'cloud' ? 'Firebase Sync' : 'Local-first'}
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
          {isFirebaseConfigured && (
            <button
              className="secondary-button full-button"
              onClick={() => {
                setSyncMode(syncMode === 'cloud' ? 'local' : 'cloud')
                setSyncMessage(syncMode === 'cloud' ? 'Modo local' : 'Firebase activo')
                setAuthError('')
                setAuthInfo('')
              }}
              type="button"
            >
              <RotateCcw aria-hidden="true" />
              {syncMode === 'cloud' ? 'Usar modo local' : 'Usar Firebase'}
            </button>
          )}
          <form onSubmit={submitAuth} className="form-grid">
            {authMode === 'register' && (
              <>
                <label>
                  Nombre
                  <input value={authName} onChange={(event) => setAuthName(event.target.value)} autoComplete="name" />
                </label>
                <label>
                  Pista de recuperacion
                  <input
                    value={authHint}
                    onChange={(event) => setAuthHint(event.target.value)}
                    placeholder="Algo que te recuerde la contrasena"
                  />
                </label>
              </>
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
            ) : syncMode === 'cloud' ? (
              <p className="info-text">Te enviaremos un enlace de Firebase para cambiar la contrasena de ese email.</p>
            ) : (
              <>
                <div className="recovery-actions">
                  <button className="secondary-button" onClick={showRecoveryHint} type="button">
                    <KeyRound aria-hidden="true" />
                    Ver pista
                  </button>
                  <label className="secondary-button file-button">
                    <Upload aria-hidden="true" />
                    Cargar kit
                    <input accept="application/json" onChange={importRecoveryKit} type="file" />
                  </label>
                </div>
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
              {authMode === 'register' ? 'Crear y entrar' : authMode === 'recover' ? (syncMode === 'cloud' ? 'Enviar email' : 'Cambiar y entrar') : 'Entrar'}
            </button>
          </form>
          <div className="auth-divider">o</div>
          <div className="google-box">
            {syncMode === 'cloud' ? (
              <button className="secondary-button full-button" onClick={signInWithFirebaseGoogle} type="button">
                <ShieldCheck aria-hidden="true" />
                Continuar con Google
              </button>
            ) : googleClientId ? (
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

  if (currentUser && pinLocked) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="brand-mark">
            <Lock aria-hidden="true" />
          </div>
          <h1>Cuentas claras</h1>
          <p>Introduce tu PIN para desbloquear la app.</p>
          <form className="form-grid" onSubmit={(event) => {
            event.preventDefault()
            void unlockPin()
          }}>
            <label>
              PIN
              <input value={pinUnlock} onChange={(event) => setPinUnlock(event.target.value)} inputMode="numeric" type="password" autoFocus />
            </label>
            <button className="primary-button" type="submit">
              <Lock aria-hidden="true" />
              Desbloquear
            </button>
          </form>
          {notice && <p className="error-text">{notice}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className={`app-shell ${privacyHidden ? 'privacy-mode' : ''}`}>
      {notice && <div className="toast">{notice}</div>}
      <header className="topbar">
        <div>
          <span className="eyebrow">Hola, {currentUser.name}</span>
          <h1>Cuentas claras</h1>
          <p className={`sync-pill ${syncMode}`}>{syncMessage} / {activeGroup ? activeGroup.name : 'Personal'}</p>
        </div>
        <div className="topbar-actions">
          <button aria-label="Privacidad visual" className="icon-button" type="button" title={privacyHidden ? 'Mostrar' : 'Privacidad'} onClick={() => setPrivacyHidden((value) => !value)}>
            {privacyHidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
          {pinConfigured && (
            <button aria-label="Bloquear app" className="icon-button" type="button" title="Bloquear app" onClick={() => setPinLocked(true)}>
              <Lock aria-hidden="true" />
            </button>
          )}
          <button aria-label="Salir" className="icon-button" type="button" title="Salir" onClick={signOut}>
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </header>

      {syncMode === 'cloud' && (
        <section className="ledger-switcher" aria-label="Libreta activa">
          <button className={!activeGroupId ? 'active' : ''} onClick={() => selectLedger(null)} type="button">
            <WalletCards aria-hidden="true" />
            Personal
          </button>
          {groups.map((group) => (
            <button className={activeGroupId === group.id ? 'active' : ''} key={group.id} onClick={() => selectLedger(group.id)} type="button">
              <FolderKanban aria-hidden="true" />
              {group.name}
            </button>
          ))}
          <button className="add-ledger" onClick={() => setTab('grupos')} type="button">
            <Plus aria-hidden="true" />
            Grupo
          </button>
        </section>
      )}

      <section className="summary-grid">
        <Metric icon={<ArrowUpRight aria-hidden="true" />} label="Me deben" value={summary.owedToMe} tone="positive" />
        <Metric icon={<ArrowDownLeft aria-hidden="true" />} label="Debo" value={summary.owedByMe} tone="negative" />
        <Metric icon={<CircleDollarSign aria-hidden="true" />} label="Saldo neto" value={summary.net} tone={summary.net >= 0 ? 'positive' : 'negative'} />
      </section>

      <section className="balance-rail" aria-label="Balance visual">
        <div>
          <span>Me deben</span>
          <strong>{formatMoney(summary.owedToMe)}</strong>
        </div>
        <div className="rail-track" aria-hidden="true">
          <span className="rail-positive" style={{ width: `${owedToMePercent}%` }} />
          <span className="rail-negative" style={{ width: `${owedByMePercent}%` }} />
        </div>
        <div>
          <span>Debo</span>
          <strong>{formatMoney(summary.owedByMe)}</strong>
        </div>
      </section>

      <section className="health-strip" aria-label="Salud de la cuenta">
        <div className={summary.net >= 0 ? 'health-chip positive' : 'health-chip negative'}>
          <span>Balance</span>
          <strong>{summary.net >= 0 ? 'A favor' : 'Pendiente'}</strong>
        </div>
        <div className={dueStats.overdue ? 'health-chip warn' : 'health-chip ready'}>
          <span>Vencidos</span>
          <strong>{dueStats.overdue}</strong>
        </div>
        <div className="health-chip neutral">
          <span>Liquidado</span>
          <strong>{paidRate}%</strong>
        </div>
      </section>

      <nav className="tabs" aria-label="Secciones">
        {[
          ['resumen', BarChart3, 'Resumen'],
          ['nuevo', Plus, editingRecordId ? 'Editar' : 'Nuevo'],
          ['personas', Users, 'Personas'],
          ['historial', ReceiptText, 'Historial'],
          ['grupos', FolderKanban, 'Grupos'],
        ].map(([id, Icon, label]) => (
          <button disabled={recordSaving} key={id as string} className={tab === id ? 'active' : ''} onClick={() => setTab(id as Tab)} type="button">
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
              <div className="button-row">
                <button className="secondary-button" disabled={sortedPeople.length === 0} type="button" onClick={() => setShowZeroBalances((value) => !value)}>
                  {showZeroBalances ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  {showZeroBalances ? 'Ocultar a cero' : `Mostrar a cero${hiddenZeroBalanceCount ? ` (${hiddenZeroBalanceCount})` : ''}`}
                </button>
                <button className="secondary-button" disabled={recordSaving} type="button" onClick={() => setTab('nuevo')}>
                  <Plus aria-hidden="true" />
                  Movimiento
                </button>
              </div>
            </div>
            <label className="search-box balance-search">
              Buscar en saldos
              <Search aria-hidden="true" />
              <input value={balanceSearch} onChange={(event) => setBalanceSearch(event.target.value)} placeholder="Nombre, telefono, email o nota" />
            </label>
            <div className="person-list">
              {sortedPeople.length === 0 && <EmptyState text="Anade personas para empezar a cuadrar cuentas." />}
              {sortedPeople.length > 0 && visibleBalancePeople.length === 0 && <EmptyState text={balanceSearch.trim() ? 'No hay personas que coincidan con esa busqueda.' : 'No hay saldos vivos. Activa mostrar a cero para ver todos los contactos.'} />}
              {visibleBalancePeople.map((person) => (
                <PersonBalanceCard
                  balance={balances.get(person.id) ?? 0}
                  key={person.id}
                  person={person}
                  reminderHref={reminderHref(person)}
                  onEdit={() => startEditPerson(person)}
                  onFavorite={() => toggleFavoritePerson(person)}
                  onQuickPayment={() => startQuickPayment(person)}
                  onQr={() => openPersonQr(person)}
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
              <div className="stat-row">
                <span>Vencidos</span>
                <strong>{dueStats.overdue}</strong>
              </div>
              <div className="stat-row">
                <span>Proximos 3 dias</span>
                <strong>{dueStats.soon}</strong>
              </div>
            </section>

            {activeTripMode && (
              <section className="panel trip-panel">
                <div className="section-heading compact">
                  <h2>Modo viaje</h2>
                  <Route aria-hidden="true" />
                </div>
                <p className="panel-copy">Usa gastos divididos y al final cierra con los pagos minimos.</p>
                <div className="trip-total">
                  <span>Total abierto</span>
                  <strong>{formatMoney(exposureTotal)}</strong>
                </div>
                {tripBudget > 0 && (
                  <div className="trip-total">
                    <span>Presupuesto restante</span>
                    <strong className={tripRemaining >= 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(tripRemaining)}</strong>
                  </div>
                )}
              </section>
            )}

            <section className="panel">
              <div className="section-heading compact">
                <h2>Cierre optimo</h2>
                <Route aria-hidden="true" />
              </div>
              <div className="settlement-list">
                {settlementPlan.length === 0 && <EmptyState text="No hay pagos pendientes para cerrar." />}
                {settlementPlan.map((item) => (
                  <div className="settlement-row" key={`${item.from}-${item.to}-${item.amount}`}>
                    <span>{personName(item.from, people)} paga a {personName(item.to, people)}</span>
                    <strong>{formatMoney(item.amount)}</strong>
                  </div>
                ))}
              </div>
              <div className="button-row">
                <button className="secondary-button" type="button" onClick={copySettlementPlan}>
                  <Copy aria-hidden="true" />
                  Copiar plan
                </button>
                <button className="secondary-button" type="button" onClick={shareSettlementPlan}>
                  <Link2 aria-hidden="true" />
                  Compartir
                </button>
                <button className="secondary-button" disabled={settlementPlan.length === 0} type="button" onClick={settleAllOpenRecords}>
                  <CheckCircle2 aria-hidden="true" />
                  Cerrar todo
                </button>
              </div>
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <h2>Meses</h2>
                <BarChart3 aria-hidden="true" />
              </div>
              <div className="month-list">
                {monthlyStats.length === 0 && <EmptyState text="No hay actividad mensual pendiente." />}
                {monthlyStats.map((month) => (
                  <div className="month-row" key={month.month}>
                    <span>{month.month}</span>
                    <strong className={month.net >= 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(month.net)}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <h2>Avisos</h2>
                <BellRing aria-hidden="true" />
              </div>
              <p className="panel-copy">Activa avisos del navegador para vencimientos cercanos.</p>
              <button className="secondary-button full-button" type="button" onClick={enableNotifications}>
                <BellRing aria-hidden="true" />
                Activar notificaciones
              </button>
            </section>

            <section className={`panel quick-plan ${quickPlan.tone}`}>
              <div className="section-heading compact">
                <h2>Plan rapido</h2>
                <CalendarClock aria-hidden="true" />
              </div>
              <strong>{quickPlan.title}</strong>
              <p>{quickPlan.copy}</p>
              <button className="secondary-button full-button" type="button" onClick={openQuickPlan}>
                <Search aria-hidden="true" />
                {quickPlan.button}
              </button>
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <h2>Personas clave</h2>
                <Users aria-hidden="true" />
              </div>
              <div className="focus-list">
                {focusPeople.length === 0 && <EmptyState text="No hay saldos pendientes por persona." />}
                {focusPeople.map((person) => {
                  const balance = balances.get(person.id) ?? 0
                  return (
                    <button
                      className="focus-person"
                      key={person.id}
                      onClick={() => {
                        setStatusFilter('todos')
                        setQuery(person.name)
                        setTab('historial')
                      }}
                      type="button"
                    >
                      <Avatar name={person.name} src={person.avatar} />
                      <span>
                        <strong>{person.name}</strong>
                        <small>{balance > 0 ? 'Te debe' : 'Le debes'}</small>
                      </span>
                      <b className={balance > 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(balance)}</b>
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <h2>Vencimientos</h2>
                <BellRing aria-hidden="true" />
              </div>
              <div className="compact-records">
                {dueRecords.length === 0 && <EmptyState text="No hay vencimientos pendientes." />}
                {dueRecords.map((record) => (
                  <button
                    className={`compact-record due-${dueTone(record)}`}
                    key={record.id}
                    onClick={() => startEditRecord(record)}
                    type="button"
                  >
                    <span>{record.title}</span>
                    <strong>{dueLabel(record)}</strong>
                  </button>
                ))}
                {dueStats.overdue > 0 && (
                  <button
                    className="secondary-button full-button"
                    onClick={() => {
                      setStatusFilter('vencidos')
                      setTab('historial')
                    }}
                    type="button"
                  >
                    <CalendarClock aria-hidden="true" />
                    Ver vencidos
                  </button>
                )}
                <button className="secondary-button full-button" onClick={exportCalendar} type="button">
                  <CalendarClock aria-hidden="true" />
                  Exportar calendario
                </button>
              </div>
            </section>

            <section className="panel account-panel">
              <div className="section-heading compact">
                <h2>Cuenta</h2>
                <KeyRound aria-hidden="true" />
              </div>
              <p className="panel-copy">
                {syncMode === 'cloud'
                  ? 'Firebase guarda tu sesion y sincroniza tus datos entre dispositivos.'
                  : 'Cambia tu contrasena, guarda una pista y crea un kit para recuperarla si la olvidas.'}
              </p>
              <div className="recovery-status-grid">
                <div className={syncMode === 'cloud' || currentUser.recoveryHash ? 'recovery-status ready' : 'recovery-status warn'}>
                  <span>{syncMode === 'cloud' ? 'Nube' : 'Codigo'}</span>
                  <strong>{syncMode === 'cloud' ? 'Firebase' : currentUser.recoveryHash ? 'Activo' : 'Pendiente'}</strong>
                </div>
                <div className={currentUser.recoveryHint ? 'recovery-status ready' : 'recovery-status warn'}>
                  <span>Pista</span>
                  <strong>{currentUser.recoveryHint ? 'Guardada' : 'Sin pista'}</strong>
                </div>
              </div>
              {syncMode === 'cloud' ? (
                <div className="button-row">
                  <button
                    className="secondary-button"
                    disabled={!currentUser.email}
                    onClick={async () => {
                      if (!firebaseAuth || !currentUser.email) return
                      try {
                        await sendPasswordResetEmail(firebaseAuth, currentUser.email)
                        setNotice('Email de cambio de contrasena enviado.')
                      } catch (error) {
                        const message = firebaseAuthMessage(error)
                        setNotice(message)
                        if (message.includes('no esta activado')) setSyncMessage('Firebase Auth pendiente de activar')
                      }
                    }}
                    type="button"
                  >
                    <KeyRound aria-hidden="true" />
                    Email de reset
                  </button>
                  <button className="secondary-button" onClick={migrateLocalDataToFirebase} type="button">
                    <Upload aria-hidden="true" />
                    Subir datos locales
                  </button>
                </div>
              ) : (
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
              )}
              <div className="button-row">
                <button className="secondary-button" type="button" onClick={exportData}>
                  <Download aria-hidden="true" />
                  Copia JSON
                </button>
                <button className="secondary-button" type="button" onClick={() => setPrivacyHidden((value) => !value)}>
                  {privacyHidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  Privacidad
                </button>
                {pinConfigured && (
                  <button className="secondary-button" type="button" onClick={() => setPinLocked(true)}>
                    <Lock aria-hidden="true" />
                    Bloquear
                  </button>
                )}
                <button className="secondary-button" type="button" onClick={refreshInstalledApp}>
                  <RotateCcw aria-hidden="true" />
                  Actualizar app
                </button>
              </div>
              <div className="pin-box">
                <label>
                  PIN de privacidad
                  <input value={pinInput} onChange={(event) => setPinInput(event.target.value)} inputMode="numeric" type="password" placeholder={pinConfigured ? 'Cambiar PIN' : 'Crear PIN'} />
                </label>
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={savePin}>
                    <Lock aria-hidden="true" />
                    Guardar PIN
                  </button>
                  {pinConfigured && (
                    <button className="secondary-button" type="button" onClick={disablePin}>
                      <X aria-hidden="true" />
                      Quitar PIN
                    </button>
                  )}
                </div>
              </div>
              <form className="form-grid" onSubmit={saveRecoveryHint}>
                <label>
                  Pista de recuperacion
                  <input
                    value={accountHint}
                    onChange={(event) => setAccountHint(event.target.value)}
                    placeholder="No pongas la contrasena literal"
                  />
                </label>
                <button className="secondary-button" type="submit">
                  <Save aria-hidden="true" />
                  Guardar pista
                </button>
              </form>
              {syncMode === 'local' && (
                <>
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
                      <button className="secondary-button" type="button" onClick={downloadRecoveryKit}>
                        <Download aria-hidden="true" />
                        Descargar kit
                      </button>
                    </div>
                  )}
                </>
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
            <div className="avatar-editor">
              <Avatar name={personForm.name || 'Persona'} src={personForm.avatar} />
              <div className="avatar-actions">
                <label className="secondary-button file-button">
                  <Camera aria-hidden="true" />
                  Foto
                  <input accept="image/*" onChange={handlePersonAvatar} type="file" />
                </label>
                {personForm.avatar && (
                  <button className="secondary-button" onClick={() => setPersonForm({ ...personForm, avatar: '' })} type="button">
                    <X aria-hidden="true" />
                    Quitar
                  </button>
                )}
              </div>
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
              <button className="primary-button" disabled={personSaving} type="submit">
                {editingPersonId ? <Save aria-hidden="true" /> : <Plus aria-hidden="true" />}
                {personSaving ? 'Guardando...' : editingPersonId ? 'Guardar cambios' : 'Anadir persona'}
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
                <Avatar name={person.name} src={person.avatar} />
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

      {tab === 'grupos' && (
        <section className="content-grid two-columns">
          <form className="panel form-grid" onSubmit={submitGroup}>
            <div className="section-heading compact">
              <h2>{editingGroupId ? 'Editar grupo' : 'Grupo compartido'}</h2>
              <FolderKanban aria-hidden="true" />
            </div>
            {syncMode !== 'cloud' ? (
              <p className="info-text">Los grupos compartidos necesitan iniciar sesion con Firebase.</p>
            ) : (
              <>
                <label>
                  Nombre del grupo
                  <input value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="Piso, viaje, familia..." />
                </label>
                <label>
                  Modo
                  <select value={groupForm.mode} onChange={(event) => setGroupForm({ ...groupForm, mode: event.target.value as 'normal' | 'viaje' })}>
                    <option value="normal">Normal</option>
                    <option value="viaje">Viaje</option>
                  </select>
                </label>
                <label>
                  Presupuesto
                  <input value={groupForm.budget} onChange={(event) => setGroupForm({ ...groupForm, budget: event.target.value })} type="number" min="0" step="0.01" inputMode="decimal" placeholder="Opcional" />
                </label>
                <label>
                  Emails invitados
                  <textarea
                    value={groupForm.memberEmails}
                    onChange={(event) => setGroupForm({ ...groupForm, memberEmails: event.target.value })}
                    placeholder="ana@email.com, juan@email.com"
                  />
                </label>
                <p className="info-text">Tu email se incluye siempre. Los invitados veran el grupo al entrar con ese mismo email.</p>
                <div className="button-row">
                  <button className="primary-button" type="submit">
                    {editingGroupId ? <Save aria-hidden="true" /> : <Plus aria-hidden="true" />}
                    {editingGroupId ? 'Guardar grupo' : 'Crear grupo'}
                  </button>
                  {editingGroupId && (
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setEditingGroupId(null)
                        setGroupForm({ name: '', memberEmails: '', mode: 'normal', budget: '' })
                      }}
                      type="button"
                    >
                      <X aria-hidden="true" />
                      Cancelar
                    </button>
                  )}
                </div>
              </>
            )}
          </form>

          <div className="person-list">
            <article className={`group-card ${!activeGroupId ? 'active' : ''}`}>
              <div>
                <h3>Personal</h3>
                <p>Solo tus cuentas y tus datos.</p>
              </div>
              <button className="secondary-button" onClick={() => selectLedger(null)} type="button">
                <WalletCards aria-hidden="true" />
                Abrir
              </button>
            </article>
            {groups.length === 0 && syncMode === 'cloud' && <EmptyState text="Crea un grupo para compartir gastos con otras personas." />}
            {groups.map((group) => (
              <article className={`group-card ${activeGroupId === group.id ? 'active' : ''}`} key={group.id}>
                <div>
                  <h3>{group.name}</h3>
                  <p>{group.mode === 'viaje' ? 'Modo viaje / ' : ''}{group.budget ? `Presupuesto ${formatMoney(group.budget)} / ` : ''}{group.memberEmails.join(' / ')}</p>
                </div>
                <div className="row-actions">
                  <button className="secondary-button" onClick={() => selectLedger(group.id)} type="button">
                    <FolderKanban aria-hidden="true" />
                    Abrir
                  </button>
                  <button className="secondary-button" onClick={() => copyInvite(group)} type="button">
                    <Link2 aria-hidden="true" />
                    Invitar
                  </button>
                  {group.ownerId === currentUser.id ? (
                    <>
                      <button aria-label="Editar grupo" className="icon-button" onClick={() => startEditGroup(group)} title="Editar grupo" type="button">
                        <Edit3 aria-hidden="true" />
                      </button>
                      <button aria-label="Borrar grupo" className="icon-button danger" onClick={() => deleteGroup(group)} title="Borrar grupo" type="button">
                        <Trash2 aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <button className="secondary-button" onClick={() => leaveGroup(group)} type="button">
                      <X aria-hidden="true" />
                      Salir
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'nuevo' && (
        <section className="content-grid">
          <section className="panel smart-entry">
            <div className="section-heading compact">
              <h2>Entrada inteligente</h2>
              <WandSparkles aria-hidden="true" />
            </div>
            <label>
              Dilo o escribelo
              <textarea
                value={smartText}
                onChange={(event) => {
                  setSmartText(event.target.value)
                  setSmartError('')
                }}
                placeholder="Ana me debe 12 por cena vence manana etiqueta comida"
              />
            </label>
            <div className="template-row">
              {smartExamples.map((example) => (
                <button className="template-chip" key={example} onClick={() => setSmartText(example)} type="button">
                  {example}
                </button>
              ))}
            </div>
            {smartText.trim() && <p className={smartPreview.startsWith('No ') || smartPreview.startsWith('Dime ') ? 'error-text' : 'smart-preview'}>{smartPreview}</p>}
            {smartError && <p className="error-text">{smartError}</p>}
            <div className="button-row">
              <button className="secondary-button" onClick={startSmartListening} type="button">
                <Mic aria-hidden="true" />
                {smartListening ? 'Escuchando...' : 'Hablar'}
              </button>
              <button className="secondary-button" onClick={fillFromSmartText} type="button">
                <WandSparkles aria-hidden="true" />
                Rellenar
              </button>
              <button className="primary-button" disabled={recordSaving} onClick={saveFromSmartText} type="button">
                <CheckCircle2 aria-hidden="true" />
                Guardar directo
              </button>
            </div>
          </section>

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
            <div className="form-row four">
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
              <label>
                Vence
                <input value={dueDate} onChange={(event) => setDueDate(event.target.value)} type="date" />
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
                Repetir
                <select value={repeat} onChange={(event) => setRepeat(event.target.value as RepeatRule)}>
                  <option value="none">No repetir</option>
                  <option value="weekly">Cada semana</option>
                  <option value="monthly">Cada mes</option>
                </select>
              </label>
            </div>
            <div className="form-row two">
              <label>
                Etiquetas
                <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="casa, viaje, comida" />
              </label>
              <label className="secondary-button file-button inline-file">
                <Paperclip aria-hidden="true" />
                {attachment ? attachment.name : 'Adjuntar justificante'}
                <input accept="image/*,application/pdf" onChange={handleAttachment} type="file" />
              </label>
            </div>
            {attachment && (
              <div className="attachment-preview">
                <span>{attachment.name}</span>
                <button className="secondary-button" type="button" onClick={() => setAttachment(null)}>
                  <X aria-hidden="true" />
                  Quitar
                </button>
              </div>
            )}
            <label>
              Nota
              <textarea value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            {formError && <p className="error-text">{formError}</p>}
            <button className="primary-button" disabled={recordSaving} type="submit">
              {editingRecordId ? <Save aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              {recordSaving ? 'Guardando...' : editingRecordId ? 'Guardar cambios' : 'Guardar movimiento'}
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
                <option value="vencidos">Vencidos</option>
                <option value="por-pagar">Por pagar</option>
                <option value="parcial">Parcial</option>
                <option value="pagado">Pagado</option>
              </select>
            </label>
            <label className="filter-box">
              Tipo
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as KindFilter)}>
                <option value="todos">Todos</option>
                <option value="split">Divididos</option>
                <option value="debt">Deudas</option>
                <option value="payment">Pagos</option>
              </select>
            </label>
            <label className="filter-box">
              Persona
              <select value={personFilter} onChange={(event) => setPersonFilter(event.target.value)}>
                <option value="todos">Todas</option>
                {people.map((person) => (
                  <option value={person.id} key={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-box">
              Desde
              <input value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} type="date" />
            </label>
            <label className="filter-box">
              Hasta
              <input value={dateTo} onChange={(event) => setDateTo(event.target.value)} type="date" />
            </label>
            <button className="secondary-button" type="button" onClick={() => {
              setQuery('')
              setStatusFilter('todos')
              setKindFilter('todos')
              setPersonFilter('todos')
              setDateFrom('')
              setDateTo('')
            }}>
              <X aria-hidden="true" />
              Limpiar
            </button>
            <button className="secondary-button" type="button" onClick={exportData}>
              <Download aria-hidden="true" />
              JSON
            </button>
            <button className="secondary-button" type="button" onClick={exportCsv}>
              <FileSpreadsheet aria-hidden="true" />
              CSV
            </button>
            <button className="secondary-button" type="button" onClick={exportFilteredCsv}>
              <FileSpreadsheet aria-hidden="true" />
              CSV filtrado
            </button>
            <button className="secondary-button" type="button" onClick={exportCalendar}>
              <CalendarClock aria-hidden="true" />
              Calendario
            </button>
            <button className="secondary-button" disabled={filteredRecords.every((record) => record.status === 'pagado')} type="button" onClick={markFilteredAsPaid}>
              <CheckCircle2 aria-hidden="true" />
              Pagar filtrados
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
                onDuplicate={() => duplicateRecordDraft(record)}
                onEdit={() => startEditRecord(record)}
                onMarkPaid={() => markRecordStatus(record, record.status === 'pagado' ? 'por-pagar' : 'pagado')}
                onNextRepeat={() => createNextRecurring(record)}
                onShare={() => shareRecord(record)}
              />
            ))}
          </div>
        </section>
      )}
      {qrPayload && (
        <div className="qr-modal" role="dialog" aria-modal="true" aria-label="QR de cobro">
          <section className="panel qr-card">
            <div className="section-heading compact">
              <h2>QR de cobro</h2>
              <QrCode aria-hidden="true" />
            </div>
            <img alt="" src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrPayload.text)}`} />
            <strong>{qrPayload.title}</strong>
            <p>{qrPayload.text}</p>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={() => navigator.clipboard?.writeText(qrPayload.text).then(() => setNotice('Texto QR copiado.')).catch(() => setNotice('No se pudo copiar.'))}>
                <Copy aria-hidden="true" />
                Copiar
              </button>
              <button className="primary-button" type="button" onClick={() => setQrPayload(null)}>
                <X aria-hidden="true" />
                Cerrar
              </button>
            </div>
          </section>
        </div>
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
  onFavorite,
  onQuickPayment,
  onQr,
  onEdit,
  onSettle,
  person,
  reminderHref,
}: {
  balance: number
  onFavorite: () => void
  onQuickPayment: () => void
  onQr: () => void
  onEdit: () => void
  onSettle: () => void
  person: Person
  reminderHref: string
}) {
  return (
    <article className="person-card balance-card">
      <Avatar name={person.name} src={person.avatar} />
      <div>
        <h3>{person.name}</h3>
        <p>{person.phone || person.email || person.notes || 'Sin contacto'}</p>
      </div>
      <strong className={balance >= 0 ? 'amount-positive' : 'amount-negative'}>{formatMoney(balance)}</strong>
      <span className="balance-label">{balance > 0 ? 'me debe' : balance < 0 ? 'le debo' : 'a cero'}</span>
      <div className="row-actions">
        <button aria-label={person.favorite ? 'Quitar favorito' : 'Marcar favorito'} className={`icon-button ${person.favorite ? 'is-favorite' : ''}`} type="button" title={person.favorite ? 'Quitar favorito' : 'Favorito'} onClick={onFavorite}>
          <Star aria-hidden="true" />
        </button>
        <button aria-label="QR de cobro" className="icon-button" type="button" title="QR de cobro" onClick={onQr}>
          <QrCode aria-hidden="true" />
        </button>
        <button aria-label="Editar persona" className="icon-button" type="button" title="Editar persona" onClick={onEdit}>
          <Edit3 aria-hidden="true" />
        </button>
        <button aria-label="Registrar pago rapido" className="icon-button" disabled={balance === 0} type="button" title="Registrar pago" onClick={onQuickPayment}>
          <CircleDollarSign aria-hidden="true" />
        </button>
        {reminderHref ? (
          <a aria-label="Recordar pago" className="icon-button" href={reminderHref} rel="noreferrer" target="_blank" title="Recordar pago">
            <MessageCircle aria-hidden="true" />
          </a>
        ) : (
          <button aria-label="Recordar pago" className="icon-button" disabled type="button" title="Anade telefono o email">
            <MessageCircle aria-hidden="true" />
          </button>
        )}
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

function Avatar({ name, src }: { name: string; src?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
  return (
    <span className="avatar" aria-hidden="true">
      {src ? <img alt="" src={src} /> : initials || 'P'}
    </span>
  )
}

function RecordRow({
  people,
  record,
  signed,
  onDelete,
  onDuplicate,
  onEdit,
  onMarkPaid,
  onNextRepeat,
  onShare,
}: {
  people: Person[]
  record: LedgerRecord
  signed: Map<string, number>
  onDelete: () => void
  onDuplicate: () => void
  onEdit: () => void
  onMarkPaid: () => void
  onNextRepeat: () => void
  onShare: () => void
}) {
  const signedTotal = [...signed.values()].reduce((sum, value) => sum + value, 0)
  const personNames = [...signed.keys()].map((id) => personName(id, people)).join(', ')
  return (
    <article className="record-row">
      <div>
        <div className="record-title">
          <h3>{record.title}</h3>
          <span className={`status ${record.status}`}>{statusLabels[record.status]}</span>
          {dueLabel(record) && <span className={`due-badge ${dueTone(record)}`}>{dueLabel(record)}</span>}
          {record.repeat && record.repeat !== 'none' && <span className="due-badge neutral">{record.repeat === 'weekly' ? 'Semanal' : 'Mensual'}</span>}
        </div>
        <p>{[record.date, personNames || 'Yo', kindLabels[record.kind]].join(' / ')}</p>
        {record.note && (
          <p className="record-note">
            <FileText aria-hidden="true" />
            {record.note}
          </p>
        )}
        {record.attachmentData && (
          <a className="attachment-link" href={record.attachmentData} download={record.attachmentName ?? 'justificante'} target="_blank" rel="noreferrer">
            <Paperclip aria-hidden="true" />
            {record.attachmentName ?? 'Justificante'}
          </a>
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
        <button aria-label="Duplicar movimiento" className="icon-button" onClick={onDuplicate} title="Duplicar movimiento" type="button">
          <Copy aria-hidden="true" />
        </button>
        <button aria-label="Compartir movimiento" className="icon-button" onClick={onShare} title="Compartir" type="button">
          <Link2 aria-hidden="true" />
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
        {record.repeat && record.repeat !== 'none' && (
          <button aria-label="Crear siguiente recurrente" className="icon-button" onClick={onNextRepeat} title="Crear siguiente" type="button">
            <Repeat2 aria-hidden="true" />
          </button>
        )}
        <button aria-label="Borrar movimiento" className="icon-button danger" onClick={onDelete} title="Borrar movimiento" type="button">
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}

export default App
