import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error inside Kapali component tree:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.fallbackUI) {
        return this.fallbackUI;
      }
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          width: '100%',
          padding: '2rem',
          backgroundColor: 'rgba(18, 24, 38, 0.95)',
          color: 'var(--text-main)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '8px',
          fontFamily: 'sans-serif',
          textAlign: 'center',
          boxSizing: 'border-box'
        }}>
          <h2 style={{ color: 'hsl(0, 85%, 60%)', marginBottom: '1rem' }}>Something went wrong</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem', maxWidth: '500px', fontSize: '0.9rem' }}>
            A rendering error occurred in this panel. You can try resetting the state or reloading the file.
          </p>
          <pre style={{
            backgroundColor: 'rgba(0, 0, 0, 0.3)',
            padding: '1rem',
            borderRadius: '4px',
            maxWidth: '100%',
            overflowX: 'auto',
            fontSize: '0.8rem',
            color: 'hsl(0, 75%, 80%)',
            textAlign: 'left',
            marginBottom: '1.5rem',
            border: '1px solid rgba(255, 255, 255, 0.05)'
          }}>
            {this.state.error?.toString()}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: 'var(--accent-blue, #3b82f6)',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem'
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }

  private get fallbackUI(): ReactNode {
    return this.props.fallback || null;
  }
}

export default ErrorBoundary;
