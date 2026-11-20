import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@fontsource-variable/inter'
import './styles/tokens.css'
import './styles.css'
import './styles/shell.css'
import './styles/stats.css'
import './styles/library.css'
import './styles/campaigns.css'
import './styles/detail.css'
import './styles/extras.css'
import './styles/long.css'
import './styles/weekend.css'
import './styles/channels.css'
import './styles/today.css'
import './styles/calendar.css'
import './styles/accounts.css'
import './styles/control.css'
import './styles/fabrica.css'
import './styles/glass.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
