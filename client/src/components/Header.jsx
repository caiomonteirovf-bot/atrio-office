import { Bell, Wifi, WifiOff } from 'lucide-react'

export default function Header({ wsConnected }) {
  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-void-border shrink-0">
      <div>
        <h1 className="text-text-primary font-semibold text-base tracking-tight">
          Átrio <span className="text-warm-gold">Office</span>
        </h1>
        <p className="text-text-muted text-xs">Escritório contábil virtual</p>
      </div>

      <div className="flex items-center gap-3">
        {/* Connection status */}
        <div className="flex items-center gap-1.5 text-xs">
          {wsConnected ? (
            <>
              <Wifi size={14} className="text-agent-sneijder" />
              <span className="text-agent-sneijder">Conectado</span>
            </>
          ) : (
            <>
              <WifiOff size={14} className="text-text-muted" />
              <span className="text-text-muted">Offline</span>
            </>
          )}
        </div>

        {/* Notifications */}
        <button className="relative p-2 rounded-lg text-text-muted hover:text-text-secondary hover:bg-void-lighter transition-all">
          <Bell size={18} />
        </button>

        {/* Avatar CEO */}
        <div className="w-8 h-8 rounded-lg bg-warm-gold/20 flex items-center justify-center">
          <span className="text-warm-gold text-xs font-bold">CM</span>
        </div>
      </div>
    </header>
  )
}
