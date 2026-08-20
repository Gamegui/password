import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Тихое обновление Google-токена: страница, загруженная в скрытом iframe
// (prompt=none), не рендерит приложение, а пересылает URL возврата родителю.
if (window.self === window.top) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode><App /></StrictMode>
  )

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'))
  }
} else {
  try { window.parent?.postMessage({ type: 'safekey.oauth.iframe', href: location.href }, location.origin) } catch { /* ignore */ }
}
