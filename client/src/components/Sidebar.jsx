import { LayoutDashboard, Users, MessageSquare, ClipboardList, Building2, BarChart3, Settings } from 'lucide-react'

const NAV_ITEMS = [
  { id: 'office', label: 'Escritório', icon: LayoutDashboard },
  { id: 'team', label: 'Equipe', icon: Users },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'tasks', label: 'Tarefas', icon: ClipboardList },
  { id: 'clients', label: 'Clientes', icon: Building2 },
  { id: 'reports', label: 'Relatórios', icon: BarChart3 },
]

export default function Sidebar({ activeView, onNavigate }) {
  return (
    <aside className="w-[72px] bg-void-light border-r border-void-border flex flex-col items-center py-4 shrink-0">
      {/* Logo */}
      <div className="w-10 h-10 rounded-lg bg-warm-gold/20 flex items-center justify-center mb-8">
        <span className="text-warm-gold font-bold text-lg">A</span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 flex-1">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            title={label}
            className={`w-11 h-11 rounded-lg flex items-center justify-center transition-all
              ${activeView === id
                ? 'bg-warm-gold/15 text-warm-gold'
                : 'text-text-muted hover:text-text-secondary hover:bg-void-lighter'
              }`}
          >
            <Icon size={20} />
          </button>
        ))}
      </nav>

      {/* Settings */}
      <button
        title="Configurações"
        className="w-11 h-11 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-void-lighter transition-all"
      >
        <Settings size={20} />
      </button>
    </aside>
  )
}
