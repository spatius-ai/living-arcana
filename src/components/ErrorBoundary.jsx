import { Component } from "react";

// React unmounts the whole tree when a render throws and nothing catches it,
// which here means a blank page over a still-playing background. `fallback`
// decides what replaces the failed subtree; `null` simply drops it.
export default class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error(`[Living Arcana] ${this.props.label || "View"} crashed:`, error, info?.componentStack);
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ?? null;
  }
}
