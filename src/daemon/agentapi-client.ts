import type { AgentMessage, AgentStatus } from '../types';

export interface AgentAPIEvent {
  type: 'message' | 'status';
  data: AgentMessage | AgentStatus;
}

export class AgentAPIClient {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  private onMessage: ((event: AgentAPIEvent) => void) | null = null;

  constructor(port: number) {
    this.baseUrl = `http://localhost:${port}`;
  }

  async getStatus(): Promise<AgentStatus> {
    const response = await fetch(`${this.baseUrl}/status`);
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.statusText}`);
    }
    return response.json();
  }

  async getMessages(): Promise<AgentMessage[]> {
    const response = await fetch(`${this.baseUrl}/messages`);
    if (!response.ok) {
      throw new Error(`Messages request failed: ${response.statusText}`);
    }
    return response.json();
  }

  async sendMessage(text: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!response.ok) {
      throw new Error(`Send message failed: ${response.statusText}`);
    }
  }

  subscribeToEvents(callback: (event: AgentAPIEvent) => void): void {
    this.onMessage = callback;

    // Use fetch with streaming for SSE since Bun's EventSource may have issues
    this.connectSSE();
  }

  private async connectSSE(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/events`);
      if (!response.ok || !response.body) {
        console.error('[AgentAPI] SSE connection failed');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (this.onMessage) {
                this.onMessage(data);
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } catch (error) {
      console.error('[AgentAPI] SSE error:', error);
    }
  }

  disconnect(): void {
    this.onMessage = null;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const status = await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }
}
