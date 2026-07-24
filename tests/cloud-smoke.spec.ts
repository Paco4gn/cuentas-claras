import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.production', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const [key, ...value] = line.split('=')
      return [key, value.join('=')]
    }),
)

const apiKey = env.VITE_FIREBASE_API_KEY
const projectId = env.VITE_FIREBASE_PROJECT_ID
const cloudUrl = process.env.E2E_CLOUD_URL ?? 'https://paco4gn.github.io/cuentas-claras/'

async function identityRequest<T>(method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${method}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(payload.error?.message ?? `Identity Toolkit ${method} failed`)
  return payload
}

async function cleanupCloudUser(email: string, password: string) {
  try {
    const session = await identityRequest<{ idToken: string; localId: string }>('accounts:signInWithPassword', {
      email,
      password,
      returnSecureToken: true,
    })
    const authHeader = { authorization: `Bearer ${session.idToken}` }
    const queryResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'groups' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'memberEmails' },
                op: 'ARRAY_CONTAINS',
                value: { stringValue: email },
              },
            },
          },
        }),
      },
    )
    if (queryResponse.ok) {
      const queryPayload = (await queryResponse.json()) as Array<{ document?: { name?: string } }>
      await Promise.all(
        queryPayload
          .map((entry) => entry.document?.name)
          .filter(Boolean)
          .map((name) => fetch(`https://firestore.googleapis.com/v1/${name}`, { method: 'DELETE', headers: authHeader })),
      )
    }
    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${session.localId}`, {
      method: 'DELETE',
      headers: authHeader,
    })
    await identityRequest('accounts:delete', { idToken: session.idToken })
  } catch {
    // Best-effort cleanup only; the test failure should be driven by the UI assertions.
  }
}

test.skip(!process.env.E2E_CLOUD, 'Set E2E_CLOUD=1 to run against Firebase production auth')

test('production Firebase auth and shared groups work', async ({ page }) => {
  const email = `cloud-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  const password = 'Prueba123'
  const groupName = `Grupo QA ${Date.now()}`
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  try {
    await page.goto(`${cloudUrl}?cloud-smoke=${Date.now()}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Crear cuenta/i }).click()
    await page.getByRole('textbox', { name: 'Nombre' }).fill('Cloud Smoke')
    await page.getByRole('textbox', { name: 'Email' }).fill(email)
    await page.getByLabel('Contrasena').fill(password)
    await page.getByRole('button', { name: /Crear y entrar/i }).click()
    await expect(page.getByText(/Firebase|Sincronizado/i)).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /Grupos/i }).click()
    await page.getByLabel('Nombre del grupo').fill(groupName)
    await page.getByLabel('Emails invitados').fill(`invitado-${Date.now()}@example.com`)
    await page.getByRole('button', { name: /Crear grupo/i }).click()
    await expect(page.getByRole('heading', { name: groupName })).toBeVisible({ timeout: 15_000 })
    expect(consoleErrors).toEqual([])
  } finally {
    await cleanupCloudUser(email, password)
  }
})
