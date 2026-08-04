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
  await expect(page.getByRole('heading', { name: 'CazaMorosos' })).toBeVisible()
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

test('quick payment from a person balance creates an editable payment draft', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Quick Pay')
  await addPerson(page, 'Rosa Quick')
  await addDebt(page, 'Entrada concierto', '22')
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText(/22,00\s*€/)

  await page.getByRole('button', { name: /Registrar pago rapido/i }).click()
  await expect(page.getByText(/Pago rapido preparado/i)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nuevo movimiento' })).toBeVisible()
  await expect(page.getByPlaceholder('Cena, alquiler, bizum...')).toHaveValue('Pago de Rosa Quick')
  await expect(page.getByLabel('Importe')).toHaveValue('22')
  await expect(page.getByLabel('Etiquetas')).toHaveValue('pago')

  await page.getByRole('button', { name: /Guardar movimiento/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText(/0,00\s*€/)
  await page.getByRole('button', { name: /Historial/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Entrada concierto' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Pago de Rosa Quick' })).toBeVisible()
  assertNoErrors()
})

test('balance list can hide and restore zero-balance people', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Zero Filter')
  await addPerson(page, 'Cero Oculto')
  await addPerson(page, 'Deuda Visible', '600111222')
  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByLabel('Dilo o escribelo').fill('Deuda Visible me debe 6 por cafe visible')
  await page.getByRole('button', { name: /Guardar directo/i }).click()

  await expect(page.getByRole('article').filter({ hasText: 'Deuda Visible' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Cero Oculto' })).toBeVisible()

  await page.getByLabel('Buscar en saldos').fill('Cero')
  await expect(page.getByRole('article').filter({ hasText: 'Cero Oculto' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Deuda Visible' })).toHaveCount(0)

  await page.getByLabel('Buscar en saldos').fill('Deuda')
  await expect(page.getByRole('article').filter({ hasText: 'Deuda Visible' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Cero Oculto' })).toHaveCount(0)
  await page.getByLabel('Buscar en saldos').fill('')
  await expect(page.getByRole('heading', { name: /Pendientes criticos/i })).toBeVisible()
  await expect(page.locator('.risk-panel .risk-person').filter({ hasText: 'Deuda Visible' }).filter({ hasText: '6,00' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Que hago ahora/i })).toBeVisible()
  await expect(page.locator('.action-card').filter({ hasText: 'Cobrar a Deuda Visible' })).toBeVisible()

  await page.getByLabel('Tono de recordatorio').selectOption('directo')
  const debtCard = page.getByRole('article').filter({ hasText: 'Deuda Visible' })
  await debtCard.getByLabel('Abrir ficha de persona').click()
  const personSheet = page.getByRole('dialog', { name: /Ficha de Deuda Visible/i })
  await expect(personSheet).toBeVisible()
  await expect(personSheet.getByText('cafe visible')).toBeVisible()
  const sheetPosterDownload = page.waitForEvent('download')
  await personSheet.getByRole('button', { name: /WhatsApp \+ cartel/i }).click()
  expect((await sheetPosterDownload).suggestedFilename()).toMatch(/cartel-deuda-visible\.png/)
  await expect(personSheet).toHaveCount(0)

  await page.getByRole('button', { name: /Ocultar a cero/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Deuda Visible' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Cero Oculto' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Mostrar a cero \(1\)/i })).toBeVisible()

  await page.getByLabel('Buscar en saldos').fill('Cero')
  await expect(page.getByText(/No hay personas que coincidan/i)).toBeVisible()
  await page.getByLabel('Buscar en saldos').fill('')
  await page.getByRole('button', { name: /Mostrar a cero/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Cero Oculto' })).toBeVisible()
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
  await page.getByRole('article').filter({ hasText: 'Ana Split' }).getByLabel('Abrir ficha de persona').click()
  const anaSheet = page.getByRole('dialog', { name: /Ficha de Ana Split/i })
  await expect(anaSheet).toBeVisible()
  await expect(anaSheet.locator('.person-sheet-record').filter({ hasText: 'Compra compartida' }).locator('em')).toHaveText(/10,00\s*€/)
  await expect(anaSheet.getByRole('button', { name: /Liquidar/i })).toBeVisible()
  await anaSheet.getByLabel('Cerrar ficha').click()

  await page.getByRole('button', { name: /Historial/i }).click()
  const jsonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /^JSON$/i }).click()
  expect((await jsonDownload).suggestedFilename()).toMatch(/cazamorosos-.*\.json/)

  const csvDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /^CSV$/i }).click()
  expect((await csvDownload).suggestedFilename()).toMatch(/cazamorosos-.*\.csv/)

  const reportDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /Informe/i }).click()
  expect((await reportDownload).suggestedFilename()).toMatch(/cazamorosos-informe-.*\.html/)

  assertNoErrors()
})

test('smart entry creates direct and split movements from natural Spanish', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Smart')

  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByLabel('Dilo o escribelo').fill('Carlos Smart me debe 14 por bocata vence manana etiqueta comida')
  await expect(page.getByText(/Deuda directa/i)).toBeVisible()
  await page.getByRole('button', { name: /Guardar directo/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText('14,00 €')
  await expect(page.getByRole('article').filter({ hasText: 'Carlos Smart' }).filter({ hasText: 'me debe' })).toBeVisible()

  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByLabel('Dilo o escribelo').fill('Divide 30 entre Ana Smart, Luis Smart y yo por compra pague yo')
  await expect(page.getByText(/Gasto dividido/i)).toBeVisible()
  await page.getByRole('button', { name: /Guardar directo/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText('34,00 €')
  await expect(page.getByRole('article').filter({ hasText: 'Ana Smart' }).filter({ hasText: 'me debe' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Luis Smart' }).filter({ hasText: 'me debe' })).toBeVisible()

  await page.getByRole('button', { name: /Historial/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'bocata' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'compra' })).toBeVisible()
  assertNoErrors()
})

test('history can duplicate a movement as an editable draft', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Duplicate')
  await addPerson(page, 'Marta Duplicate')
  await addDebt(page, 'Cena duplicable', '17')

  await page.getByRole('button', { name: /Historial/i }).click()
  await page.getByRole('button', { name: /Duplicar movimiento/i }).click()
  await expect(page.getByText(/Movimiento duplicado como borrador/i)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nuevo movimiento' })).toBeVisible()
  await expect(page.getByPlaceholder('Cena, alquiler, bizum...')).toHaveValue('Cena duplicable')
  await expect(page.getByLabel('Importe')).toHaveValue('17')

  await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Cena duplicada guardada')
  await page.getByRole('button', { name: /Guardar movimiento/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText(/34,00\s*€/)
  await page.getByRole('button', { name: /Historial/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Cena duplicable' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Cena duplicada guardada' })).toBeVisible()
  assertNoErrors()
})

test('advanced tools handle favorites, filters, attachments and recurring records', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Tools')
  await addPerson(page, 'Marta Tools')
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByRole('button', { name: /^Deuda$/i }).click()
  await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Suscripcion recurrente')
  await page.getByLabel('Importe').fill('9')
  await page.getByLabel('Vence').fill(tomorrow)
  await page.getByLabel('Repetir').selectOption('monthly')
  await page.locator('input[type="file"][accept="image/*,application/pdf"]').setInputFiles({
    name: 'ticket.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 prueba'),
  })
  await expect(page.locator('.attachment-preview').getByText('ticket.pdf')).toBeVisible()
  await page.getByRole('button', { name: /Guardar movimiento/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText('9,00 €')

  await page.getByRole('button', { name: /Marcar favorito/i }).click()
  await expect(page.getByRole('button', { name: /Quitar favorito/i })).toBeVisible()

  await page.getByRole('button', { name: /Historial/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Suscripcion recurrente' }).getByText('Mensual')).toBeVisible()
  await expect(page.getByRole('link', { name: /ticket.pdf/i })).toBeVisible()
  await page.getByLabel('Tipo').selectOption('debt')
  await page.getByLabel('Persona').selectOption({ label: 'Marta Tools' })
  await expect(page.getByRole('article').filter({ hasText: 'Suscripcion recurrente' })).toBeVisible()

  const filteredCsvDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /CSV filtrado/i }).click()
  expect((await filteredCsvDownload).suggestedFilename()).toMatch(/cazamorosos-filtrado-.*\.csv/)

  const calendarDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /Calendario/i }).click()
  expect((await calendarDownload).suggestedFilename()).toMatch(/cazamorosos-vencimientos-.*\.ics/)

  await page.getByRole('button', { name: /Crear siguiente recurrente/i }).click()
  await expect(page.getByText(/Siguiente movimiento recurrente creado/i)).toBeVisible()
  await page.getByRole('button', { name: /Limpiar/i }).click()
  await expect(page.getByRole('article').filter({ hasText: 'Suscripcion recurrente' })).toHaveCount(2)
  await page.getByRole('button', { name: /Pagar filtrados/i }).click()
  await expect(page.getByText(/movimientos filtrados marcados como pagados/i)).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'Me deben' }).getByRole('strong')).toHaveText(/0,00\s*€/)
  assertNoErrors()
})

test('privacy mode, pin lock and QR collection tools work', async ({ page }) => {
  const assertNoErrors = await expectNoConsoleErrors(page)
  await createLocalAccount(page, 'Paco Privacy')
  await page.getByRole('button', { name: /Personas/i }).click()
  await page.getByRole('textbox', { name: 'Nombre' }).fill('Kiko')
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'kiko.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="#f6c453"/><circle cx="80" cy="70" r="44" fill="#0f766e"/><circle cx="64" cy="62" r="7" fill="#fff"/><circle cx="96" cy="62" r="7" fill="#fff"/><path d="M54 94c18 16 38 16 56 0" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round"/></svg>'),
  })
  await expect(page.locator('.avatar-editor img')).toBeVisible()
  await page.getByRole('button', { name: /Anadir persona/i }).click()
  await expect(page.getByText('Kiko')).toBeVisible()
  await addDebt(page, 'Cafe QR', '11')

  await page.getByRole('button', { name: /Privacidad visual/i }).click()
  await expect(page.locator('main.privacy-mode')).toBeVisible()
  await page.getByRole('button', { name: /Privacidad visual/i }).click()
  await expect(page.locator('main.privacy-mode')).toHaveCount(0)

  await page.getByRole('button', { name: /QR de cobro/i }).first().click()
  const qrDialog = page.getByRole('dialog', { name: /QR de cobro/i })
  await expect(qrDialog).toBeVisible()
  await expect(page.getByText(/tienes 11,00\s*€ pendiente/i)).toBeVisible()
  const publicQrHref = await qrDialog.getByRole('link', { name: /Ver tarjeta/i }).getAttribute('href')
  expect(publicQrHref).toContain('cobro=')
  const publicQrUrl = new URL(publicQrHref!)
  const compactPayload = JSON.parse(publicQrUrl.searchParams.get('cobro') ?? '{}') as { photo?: string }
  expect(compactPayload.photo).toMatch(/^data:image\//)
  const posterDownload = page.waitForEvent('download')
  await qrDialog.getByRole('button', { name: /^PNG$/i }).click()
  expect((await posterDownload).suggestedFilename()).toMatch(/cartel-kiko\.png/)
  const publicQrPage = await page.context().newPage()
  await publicQrPage.goto(publicQrHref!)
  await expect(publicQrPage.getByRole('heading', { name: /WANTED/i })).toBeVisible()
  await expect(publicQrPage.getByRole('heading', { name: /Kiko/i })).toBeVisible()
  await expect(publicQrPage.getByText(/KIKO adeuda 11,00/i)).toBeVisible()
  await expect(publicQrPage.locator('.wanted-reward strong')).toHaveText(/11,00\s*€/)
  await expect(publicQrPage.locator('.wanted-photo img')).toBeVisible()
  await publicQrPage.close()
  publicQrUrl.searchParams.delete('qrid')
  const mobileQrPage = await page.context().newPage()
  await mobileQrPage.goto(publicQrUrl.toString())
  await expect(mobileQrPage.locator('.wanted-photo img')).toBeVisible()
  await mobileQrPage.close()
  await qrDialog.getByRole('button', { name: /^Cerrar$/i }).click()
  const posterShareDownload = page.waitForEvent('download')
  await page.getByLabel('Enviar WhatsApp con cartel').first().click()
  expect((await posterShareDownload).suggestedFilename()).toMatch(/cartel-kiko\.png/)

  await page.getByLabel('PIN de privacidad').fill('1234')
  await page.getByRole('button', { name: /Guardar PIN/i }).click()
  await expect(page.getByText(/PIN activado/i)).toBeVisible()
  await page.getByRole('button', { name: /^Bloquear$/i }).click()
  await expect(page.getByRole('button', { name: /Desbloquear/i })).toBeVisible()
  await page.getByLabel('PIN').fill('1234')
  await page.getByRole('button', { name: /Desbloquear/i }).click()
  await expect(page.getByRole('heading', { name: 'CazaMorosos' })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'CazaMorosos' })).toBeVisible()
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
