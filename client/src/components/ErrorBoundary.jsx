import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null, info: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { this.setState({ err, info }); console.error('[ErrorBoundary]', err, info) }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, color: '#ef4444', fontFamily: 'monospace', fontSize: 12, overflow: 'auto', height: '100%' }}>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Erro ao renderizar: {this.props.label || 'Component'}</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#f87171' }}>{String(this.state.err?.stack || this.state.err)}</pre>
          {this.state.info?.componentStack && (
            <pre style={{ whiteSpace: 'pre-wrap', color: '#f59e0b', marginTop: 12 }}>{this.state.info.componentStack}</pre>
          )}
          <button onClick={()=>this.setState({err:null,info:null})} style={{ marginTop: 16, padding: '6px 12px', background: '#C4956A', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Recarregar</button>
        </div>
      )
    }
    return this.props.children
  }
}
