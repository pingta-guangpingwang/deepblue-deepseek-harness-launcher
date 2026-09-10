import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ConversationWindowPage from './ConversationWindowPage'
import './styles.css'
import './launcher-appearance.css'
import './conversation.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('conversation') === '1' ? <ConversationWindowPage /> : <App />}
  </React.StrictMode>
)
