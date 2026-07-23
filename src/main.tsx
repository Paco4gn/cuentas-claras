import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const githubPagesUrl = 'https://paco4gn.github.io/cuentas-claras/'
if (window.location.hostname.endsWith('chatgpt.site')) {
  window.location.replace(githubPagesUrl)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined)
  })
}
