import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ProtonScheduler] Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', padding: '2rem',
          background: '#0F172A', color: '#F1F5F9',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}>
          <div style={{ textAlign: 'center', maxWidth: 420 }}>
            <div style={{
              width: 56, height: 56, margin: '0 auto 1.5rem',
              borderRadius: 16, background: '#6366F1',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '1.5rem',
            }}>
              !
            </div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              Something went wrong
            </h1>
            <p style={{ color: 'rgba(148,163,184,0.70)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              ProtonScheduler encountered an unexpected error. Your data is safe.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '0.75rem 1.5rem', borderRadius: 10, border: 'none',
                background: 'linear-gradient(135deg, #6366F1, #312E81)',
                color: 'white', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer',
              }}
            >
              Reload ProtonScheduler
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
