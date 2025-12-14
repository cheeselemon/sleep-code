import { create } from 'zustand';
import type { Session, RelayMessage } from './types';

interface AppState {
  // Auth
  token: string | null;
  isAuthenticated: boolean;
  setToken: (token: string | null) => void;

  // Connection
  isConnected: boolean;
  setConnected: (connected: boolean) => void;

  // Sessions
  sessions: Session[];
  setSessions: (sessions: Session[]) => void;
  updateSessionStatus: (sessionId: string, status: Session['status']) => void;

  // Current session
  currentSessionId: string | null;
  setCurrentSession: (sessionId: string | null) => void;

  // Session output
  sessionOutputs: Map<string, string[]>;
  appendOutput: (sessionId: string, output: string) => void;
  clearOutput: (sessionId: string) => void;
}

export const useStore = create<AppState>((set, get) => ({
  // Auth
  token: null,
  isAuthenticated: false,
  setToken: (token) => set({ token, isAuthenticated: !!token }),

  // Connection
  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),

  // Sessions
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  updateSessionStatus: (sessionId, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s
      ),
    })),

  // Current session
  currentSessionId: null,
  setCurrentSession: (sessionId) => set({ currentSessionId: sessionId }),

  // Session output
  sessionOutputs: new Map(),
  appendOutput: (sessionId, output) =>
    set((state) => {
      const outputs = new Map(state.sessionOutputs);
      const existing = outputs.get(sessionId) || [];
      outputs.set(sessionId, [...existing, output]);
      return { sessionOutputs: outputs };
    }),
  clearOutput: (sessionId) =>
    set((state) => {
      const outputs = new Map(state.sessionOutputs);
      outputs.delete(sessionId);
      return { sessionOutputs: outputs };
    }),
}));
