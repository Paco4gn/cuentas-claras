import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const distDir = join(root, 'dist')
const hostingSource = join(root, '.openai', 'hosting.json')
const hostingTarget = join(distDir, '.openai', 'hosting.json')
const serverTarget = join(distDir, 'server', 'index.js')

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const rel = relative(distDir, fullPath).split(sep).join('/')
    if (rel.startsWith('server/') || rel.startsWith('.openai/')) continue
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)))
    } else {
      files.push(fullPath)
    }
  }
  return files
}

function extension(filePath) {
  if (filePath.endsWith('.webmanifest')) return '.webmanifest'
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot) : ''
}

await mkdir(dirname(hostingTarget), { recursive: true })
await copyFile(hostingSource, hostingTarget)

const assetEntries = []
for (const filePath of await walk(distDir)) {
  const rel = `/${relative(distDir, filePath).split(sep).join('/')}`
  const body = await readFile(filePath, 'utf8')
  assetEntries.push([rel, body, mimeTypes[extension(filePath)] ?? 'text/plain; charset=utf-8'])
}

const indexEntry = assetEntries.find(([path]) => path === '/index.html')
if (indexEntry) assetEntries.push(['/', indexEntry[1], indexEntry[2]])

const worker = `const assets = new Map(${JSON.stringify(assetEntries)});\n\nexport default {\n  async fetch(request) {\n    const url = new URL(request.url);\n    const pathname = decodeURIComponent(url.pathname);\n    const exact = assets.get(pathname);\n    const fallback = assets.get('/index.html');\n    const asset = exact ?? (request.headers.get('accept')?.includes('text/html') ? fallback : undefined);\n\n    if (!asset) {\n      return new Response('Not found', { status: 404 });\n    }\n\n    const [body, contentType] = [asset[0], asset[1]];\n    return new Response(body, {\n      headers: {\n        'content-type': contentType,\n        'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',\n      },\n    });\n  },\n};\n`

await mkdir(dirname(serverTarget), { recursive: true })
await writeFile(serverTarget, worker)
