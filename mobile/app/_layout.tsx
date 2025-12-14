import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useStore } from '@/lib/store';
import { relay } from '@/lib/relay';
import {
  registerForPushNotifications,
  setupNotificationListeners,
  setupNotificationChannel,
} from '@/lib/notifications';

export default function RootLayout() {
  const { setToken } = useStore();

  useEffect(() => {
    // Set up notification channel (Android)
    setupNotificationChannel();

    // Set up notification listeners
    const cleanup = setupNotificationListeners();

    // Load saved token and connect
    async function initialize() {
      try {
        const savedToken = await SecureStore.getItemAsync('snowfort_token');
        const savedServer = await SecureStore.getItemAsync('snowfort_server');

        if (savedToken) {
          setToken(savedToken);

          // Set server URL if saved
          if (savedServer) {
            relay.setUrl(`${savedServer}/ws/mobile`);
          }

          // Connect to relay
          await relay.connect(savedToken);

          // Register for push notifications after connecting
          const pushToken = await registerForPushNotifications();
          if (pushToken) {
            relay.registerPushToken(pushToken);
          }
        }
      } catch (err) {
        console.error('Failed to initialize:', err);
      }
    }

    initialize();

    return cleanup;
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#1a1a2e' },
          headerTintColor: '#fff',
          contentStyle: { backgroundColor: '#0f0f1a' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Snowfort' }} />
        <Stack.Screen name="login" options={{ title: 'Connect', presentation: 'modal' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
      </Stack>
    </>
  );
}
