// Push notification service using Expo's push API

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
}

class PushService {
  private userPushTokens: Map<string, Set<string>> = new Map();

  registerToken(userId: string, pushToken: string): void {
    let tokens = this.userPushTokens.get(userId);
    if (!tokens) {
      tokens = new Set();
      this.userPushTokens.set(userId, tokens);
    }
    tokens.add(pushToken);
    console.log(`[Push] Registered token for user ${userId.slice(0, 8)}: ${pushToken.slice(0, 20)}...`);
  }

  removeToken(userId: string, pushToken: string): void {
    const tokens = this.userPushTokens.get(userId);
    if (tokens) {
      tokens.delete(pushToken);
    }
  }

  async sendNotification(userId: string, title: string, body: string, data?: Record<string, unknown>): Promise<void> {
    const tokens = this.userPushTokens.get(userId);
    if (!tokens || tokens.size === 0) {
      console.log(`[Push] No push tokens for user ${userId.slice(0, 8)}`);
      return;
    }

    const messages: PushMessage[] = Array.from(tokens).map((token) => ({
      to: token,
      title,
      body,
      data,
      sound: 'default',
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        console.error('[Push] Failed to send:', await response.text());
      } else {
        const result = await response.json();
        console.log(`[Push] Sent ${messages.length} notification(s) to user ${userId.slice(0, 8)}`);

        // Handle ticket errors (invalid tokens, etc.)
        if (result.data) {
          for (let i = 0; i < result.data.length; i++) {
            const ticket = result.data[i];
            if (ticket.status === 'error') {
              console.error(`[Push] Error for token: ${ticket.message}`);
              // Remove invalid tokens
              if (ticket.details?.error === 'DeviceNotRegistered') {
                const token = messages[i].to;
                this.removeToken(userId, token);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[Push] Error sending notification:', err);
    }
  }

  async sendSessionIdleNotification(userId: string, sessionId: string, sessionName: string): Promise<void> {
    await this.sendNotification(
      userId,
      'Session Idle',
      `${sessionName} is waiting for input`,
      { sessionId }
    );
  }

  async sendSessionEndedNotification(userId: string, sessionId: string, sessionName: string): Promise<void> {
    await this.sendNotification(
      userId,
      'Session Ended',
      `${sessionName} has finished`,
      { sessionId }
    );
  }

  getStats(): { users: number; tokens: number } {
    let totalTokens = 0;
    for (const tokens of this.userPushTokens.values()) {
      totalTokens += tokens.size;
    }
    return {
      users: this.userPushTokens.size,
      tokens: totalTokens,
    };
  }
}

export const pushService = new PushService();
