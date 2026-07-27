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

    async function deleteCollection(path: string) {
      const response = await fetch(`https://firestore.googleapis.com/v1/${path}`, { headers: authHeader })
      if (!response.ok) return
      const payload = (await response.json()) as { documents?: Array<{ name: string }> }
      await Promise.all((payload.documents ?? []).map((document) => fetch(`https://firestore.googleapis.com/v1/${document.name}`, { method: 'DELETE', headers: authHeader })))
    }

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
      for (const name of queryPayload.map((entry) => entry.document?.name).filter(Boolean)) {
        const relativePath = String(name).split('/documents/')[1]
        await deleteCollection(`${name}/persons`)
        await deleteCollection(`${name}/records`)
        await fetch(`https://firestore.googleapis.com/v1/${name}`, { method: 'DELETE', headers: authHeader })
        if (relativePath) {
          await deleteCollection(`projects/${projectId}/databases/(default)/documents/${relativePath}/persons`)
          await deleteCollection(`projects/${projectId}/databases/(default)/documents/${relativePath}/records`)
        }
      }
    }
    await deleteCollection(`projects/${projectId}/databases/(default)/documents/users/${session.localId}/persons`)
    await deleteCollection(`projects/${projectId}/databases/(default)/documents/users/${session.localId}/records`)
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

test('production Firebase auth, balances, exports and shared groups work', async ({ browser }) => {
  test.setTimeout(180_000)
  const email = `cloud-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  const invitedEmail = `cloud-e2e-invited-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  const password = 'Prueba123'
  const groupName = `Grupo QA ${Date.now()}`
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  try {
    await page.goto(`${cloudUrl}?cloud-smoke=${Date.now()}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Crear cuenta/i }).click()
    await page.getByRole('textbox', { name: 'Nombre' }).fill('Cloud E2E')
    await page.getByRole('textbox', { name: 'Email' }).fill(email)
    await page.getByLabel('Contrasena').fill(password)
    await page.getByRole('button', { name: /Crear y entrar/i }).click()
    await expect(page.getByText(/Firebase|Sincronizado/i)).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /Personas/i }).click()
    await page.getByRole('textbox', { name: 'Nombre' }).fill('Rosa Cloud')
    await page.getByRole('button', { name: /Anadir persona/i }).click()

    await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
    await page.getByRole('button', { name: /^Pago$/i }).click()
    await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Pago ya cerrado cloud')
    await page.getByLabel('Importe').fill('5')
    await page.getByLabel('Tipo').selectOption('i_paid_person')
    await page.getByLabel('Estado').selectOption('pagado')
    await page.getByRole('button', { name: /Guardar movimiento/i }).click()
    await expect(page.getByRole('article').filter({ hasText: 'Debo' }).getByRole('strong')).toHaveText('0,00 €')

    await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
    await page.getByRole('button', { name: /^Deuda$/i }).click()
    await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Deuda cloud abierta')
    await page.getByLabel('Importe').fill('8')
    await page.getByRole('button', { name: /Guardar movimiento/i }).click()
    await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText('8,00 €')

    await page.getByRole('button', { name: /Liquidar/i }).click()
    await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText('0,00 €')

    await page.getByRole('button', { name: /Historial/i }).click()
    const jsonDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: /^JSON$/i }).click()
    expect((await jsonDownload).suggestedFilename()).toMatch(/cuentas-claras-.*\.json/)

    await page.getByRole('button', { name: /Grupos/i }).click()
    await page.getByLabel('Nombre del grupo').fill(groupName)
    await page.getByLabel('Emails invitados').fill(invitedEmail)
    await page.getByRole('button', { name: /Crear grupo/i }).click()
    await expect(page.getByRole('heading', { name: groupName })).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /Salir/i }).click()

    const invitedContext = await browser.newContext()
    const invitedPage = await invitedContext.newPage()
    invitedPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await invitedPage.goto(`${cloudUrl}?cloud-invited=${Date.now()}`, { waitUntil: 'networkidle' })
    await invitedPage.getByRole('button', { name: /Crear cuenta/i }).click()
    await invitedPage.getByRole('textbox', { name: 'Nombre' }).fill('Cloud Invitado')
    await invitedPage.getByRole('textbox', { name: 'Email' }).fill(invitedEmail)
    await invitedPage.getByLabel('Contrasena').fill(password)
    await invitedPage.getByRole('button', { name: /Crear y entrar/i }).click()
    await expect(invitedPage.getByRole('button', { name: groupName })).toBeVisible({ timeout: 20_000 })
    await invitedContext.close()

    expect(consoleErrors).toEqual([])
  } finally {
    await context.close().catch(() => undefined)
    await cleanupCloudUser(email, password)
    await cleanupCloudUser(invitedEmail, password)
  }
})
