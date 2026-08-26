import { Component, ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

// Captura qualquer exceção de render do app e mostra uma tela de erro recuperável
// (com o erro + botão de recarregar) em vez de tela preta. Sem isso, um throw em
// qualquer componente apaga toda a árvore React → janela preta.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Loga no console do renderer (aparece no devtools / --enable-logging).
    console.error('[maestrus] render crash:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <div className="crash-screen">
          <div className="crash-card">
            <div className="crash-title">Algo quebrou na interface</div>
            <div className="crash-msg">{e.message || String(e)}</div>
            <pre className="crash-stack">{(e.stack || '').split('\n').slice(0, 8).join('\n')}</pre>
            <div className="crash-actions">
              <button className="btn-primary" onClick={() => location.reload()}>Recarregar</button>
              <button className="btn-secondary" onClick={() => this.setState({ error: null })}>Tentar continuar</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
