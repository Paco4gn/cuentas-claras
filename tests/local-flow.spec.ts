import { expect, test } from '@playwright/test'

test('local account can track a debt, a partial payment and export data', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  await page.goto('./')
  const localModeButton = page.getByRole('button', { name: /Usar modo local/i })
  if (await localModeButton.isVisible()) await localModeButton.click()

  await page.getByRole('textbox', { name: 'Nombre' }).fill('Paco QA')
  await page.getByLabel('Pista de recuperacion').fill('prueba')
  await page.getByRole('textbox', { name: 'Email' }).fill(`qa-${Date.now()}@example.com`)
  await page.getByLabel('Contrasena').fill('Prueba123')
  await page.getByRole('button', { name: /Crear y entrar/i }).click()

  await page.getByRole('button', { name: /Personas/i }).click()
  await page.getByRole('textbox', { name: 'Nombre' }).fill('Ana Test')
  await page.getByLabel('Telefono').fill('600123123')
  await page.getByRole('button', { name: /Anadir persona/i }).click()

  await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
  await page.getByRole('button', { name: /^Deuda$/i }).click()
  await page.getByPlaceholder('Cena, alquiler, bizum...').fill('Cena QA')
  await page.getByLabel('Importe').fill('20')
  await page.getByRole('button', { name: /Guardar movimiento/i }).click()
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
  expect(consoleErrors).toEqual([])
})
