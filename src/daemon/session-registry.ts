import type { Session } from '../types';

export interface RegisteredSession extends Session {
  port: number;
  command: string[];
}

class SessionRegistry {
  private sessions: Map<string, RegisteredSession> = new Map();

  register(session: RegisteredSession): void {
    this.sessions.set(session.id, session);
    console.log(`[Registry] Session registered: ${session.id.slice(0, 8)} on port ${session.port}`);
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      console.log(`[Registry] Session unregistered: ${sessionId.slice(0, 8)}`);
    }
  }

  get(sessionId: string): RegisteredSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): RegisteredSession[] {
    return Array.from(this.sessions.values());
  }

  updateStatus(sessionId: string, status: Session['status']): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      console.log(`[Registry] Session ${sessionId.slice(0, 8)} status: ${status}`);
    }
  }

  size(): number {
    return this.sessions.size;
  }
}

export const sessionRegistry = new SessionRegistry();
