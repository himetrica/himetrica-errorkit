// @himetrica/errorkit/react: error boundary and hook.
//
// The boundary reports with mechanism "boundary" and the React component stack in
// `extra`, then renders `fallback` (a node, or a function receiving `{ error, reset }`).
// `resetKeys` resets it when any key changes (e.g. the route), the usual way to let a
// user leave a broken screen without a reload.

import { Component, useMemo, type ErrorInfo, type ReactNode } from "react";
import type { CaptureContext, ErrorKitClient } from "../browser/client";
import type { Level } from "../core/types";

// The client is reached through the window global init() sets, never through a
// module import: dist/react is its own bundle, and importing the root entry would
// give it a second, never-initialized singleton.
function client(): ErrorKitClient | undefined {
  return typeof window !== "undefined"
    ? (window as Window & { __himetricaErrorKit?: ErrorKitClient }).__himetricaErrorKit
    : undefined;
}

export interface FallbackProps {
  error: unknown;
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode | ((props: FallbackProps) => ReactNode);
  onError?: (error: unknown, info: ErrorInfo) => void;
  resetKeys?: unknown[];
  tags?: Record<string, string>;
}

interface State {
  error: unknown;
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    client()?.captureException(error, {
      mechanism: "boundary",
      handled: false,
      level: "error",
      tags: this.props.tags,
      extra: { componentStack: info.componentStack?.slice(0, 4000) },
    });
    try {
      this.props.onError?.(error, info);
    } catch {
      // A throwing onError must not take the fallback down with it.
    }
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (!this.state.hasError) return;
    const a = prev.resetKeys ?? [];
    const b = this.props.resetKeys ?? [];
    if (a.length !== b.length || a.some((k, i) => !Object.is(k, b[i]))) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null, hasError: false });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback({ error: this.state.error, reset: this.reset });
    return fallback ?? null;
  }
}

/** Stable handles to the ErrorKit API for components (no-ops until init()). */
export function useErrorKit() {
  return useMemo(
    () => ({
      captureException: (error: unknown, ctx?: CaptureContext) => client()?.captureException(error, ctx),
      captureMessage: (message: string, level?: Level) => client()?.captureMessage(message, level),
      setTag: (key: string, value: string) => client()?.setTag(key, value),
      setUser: (user: { id?: string } | null) => client()?.setUser(user),
      flush: () => client()?.flush() ?? Promise.resolve(),
    }),
    [],
  );
}
