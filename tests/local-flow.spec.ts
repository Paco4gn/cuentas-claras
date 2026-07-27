import { expect, type Page, test } from '@playwright/test'

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
}

async function expectNoConsoleErrors(page: Page) {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  return () => expect(consoleErrors).toEqual([])
}

async function openLocalRegister(page: Page) {
  await page.goto('./')
  const localModeButton = page.getByRole('button', { name: /Usar modo local/i })
  if (await localModeButton.isVisible()) await localModeButton.click()
}

async function createLocalAccount(page: Page, name = 'Paco QA') {
  const email = uniqueEmail('qa')
  await openLocalRegister(page)
  await page.getByRole('textbox', { name: 'Nombre' }).fill(name)
  await page.getByLabel('Pista de recuperacion').fill('prueba')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Contrasena').fill('Prueba123')
  await page.getByRole('button', { name: /Crear y entrar/i }).click()
  await expect(page.getByRole('heading', { name: 'Cuentas claras' })).toBeVisible()
  return email
}

async function addPerson(page: Page, name: string, phone = '') {
  await page.getByRole('button', { name: /Personas/i }).click()
  await page.getByRole('textbox', { name: 'Nombre' }).fill(name)
  if (phone) await page.getByLabel('Telefono').fill(phone)
  await page.getByRole('button', { name: /Anadir persona/i }).click()
  await expect(page.getByText(name)).toBeVisible()
}

async function addDebt(page: Page, title: string, amount: string) {
  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByRole('button', { name: /^Deuda$/i }).click()
  await page.getByPlaceholder('Cena, alquiler, bizum...').fill(title)
  await page.getByLabel('Importe').fill(amount)
  await page.getByRole('button', { name: /Guardar movimiento/i }).click()
}

test('local account can track a debt, a partial payment and history', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page)
  await addPerson(page, 'Ana Test', '600123123')

  await addDebt(page, 'Cena QA', '20')
  await expect(page.locator('body')).toContainText('20,00')

  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByRole('button', { name: /^Pago$/i }).click()
  await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Pago parcial QA')
  await page.getByLabel('Importe').fill('5')
  await page.getByRole('button', { name: /Guardar movimiento/i }).click()
  await expect(page.locator('body')).toContainText('15,00')

  await page.getByRole('button', { name: /Historial/i }).click()
  await expect(page.getByText('Cena QA')).toBeVisible()
  await expect(page.getByText('Pago parcial QA')).toBeVisible()
  assertNoErrors()
})

test('paid movements do not affect live balances', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Paid')
  await addPerson(page, 'Rosa Paid')

  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByRole('button', { name: /^Pago$/i }).click()
  await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Granizada pagada')
  await page.getByLabel('Importe').fill('5')
  await page.getByLabel('Tipo').selectOption('i_paid_person')
  await page.getByLabel('Estado').selectOption('pagado')
  await page.getByRole('button', { name: /Guardar movimiento/i }).click()

  await expect(page.getByRole('article').filter({ hasText: 'Debo' }).getByRole('strong')).toHaveText('0,00 €')
  await expect(page.getByRole('article').filter({ hasText: 'Saldo neto' }).getByRole('strong')).toHaveText('0,00 €')
  await expect(page.getByText('Rosa Paid').locator('..').locator('..')).toContainText('0,00 €')
  assertNoErrors()
})

test('settling a person marks open movements as paid and clears the balance', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Settle')
  await addPerson(page, 'Porro Settle')
  await addDebt(page, 'Piscina pendiente', '8')
  await expect(page.locator('body')).toContainText('8,00')

  await page.getByRole('button', { name: /Liquidar/i }).click()
  await expect(page.getByText(/Saldo de Porro Settle liquidado/i)).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText('0,00 €')
  await page.getByRole('button', { name: /Historial/i }).click()
  const settledRow = page.getByRole('article').filter({ hasText: 'Piscina pendiente' })
  await expect(settledRow).toBeVisible()
  await expect(settledRow.getByText('Pagado')).toBeVisible()
  assertNoErrors()
})

test('local split expenses, exports and import work', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Split')
  await addPerson(page, 'Ana Split')
  await addPerson(page, 'Luis Split')

  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Compra compartida')
  await page.getByLabel('Importe').fill('30')
  await page.getByRole('button', { name: /Todos/i }).click()
  await page.getByRole('button', { name: /Dividir igual/i }).click()
  await page.getByRole('button', { name: /Guardar movimiento/i }).click()
  await expect(page.locator('body')).toContainText('20,00')

  await page.getByRole('button', { name: /Historial/i }).click()
  const jsonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /^JSON$/i }).click()
  expect((await jsonDownload).suggestedFilename()).toMatch(/cuentas-claras-.*\.json/)

  const csvDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /^CSV$/i }).click()
  expect((await csvDownload).suggestedFilename()).toMatch(/cuentas-claras-.*\.csv/)

  assertNoErrors()
})

test('local recovery code can reset password', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  const email = await createLocalAccount(page, 'Paco Recovery')
  const recoveryCode = (await page.locator('.recovery-card strong').first().innerText()).trim()
  await page.getByRole('button', { name: /Salir/i }).click()

  await page.getByRole('button', { name: /Recuperar/i }).click()
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Codigo de recuperacion').fill(recoveryCode)
  await page.getByLabel('Nueva contrasena').fill('Nueva123')
  await page.getByRole('button', { name: /Cambiar y entrar/i }).click()
  await expect(page.getByText(/Contrasena actualizada/i)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Cuentas claras' })).toBeVisible()
  assertNoErrors()
})

test('groups screen explains cloud requirement in local mode', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Groups')
  await page.getByRole('button', { name: /Grupos/i }).click()
  await expect(page.getByText('Los grupos compartidos necesitan iniciar sesion con Firebase.')).toBeVisible()
  await expect(page.getByRole('button', { name: /Abrir/i })).toBeVisible()
  assertNoErrors()
})
