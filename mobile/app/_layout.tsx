import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useStore } from '@/lib/store';
import { relay } from '@/lib/relay';

// Only import notifications on native platforms
let notificationModule: typeof import('@/lib/notifications') | null = null;
if (Platform.OS !== 'web') {
  notificationModule = require('@/lib/notifications');
}

export default function RootLayout() {
  const { setToken, setConnected } = useStore();

  useEffect(() => {
    let cleanup = () => {};

    // Set up notifications only on native
    if (notificationModule) {
      notificationModule.setupNotificationChannel();
      cleanup = notificationModule.setupNotificationListeners();
    }

    // Load saved token and connect
    async function initialize() {
      try {
        let savedToken: string | null = null;

        if (Platform.OS === 'web') {
          savedToken = localStorage.getItem('snowfort_token');
        } else {
          savedToken = await SecureStore.getItemAsync('snowfort_token');
        }

        if (savedToken) {
          setToken(savedToken);
          await relay.connect(savedToken);

          // Register for push notifications after connecting (native only)
          if (notificationModule) {
            const pushToken = await notificationModule.registerForPushNotifications();
            if (pushToken) {
              relay.registerPushToken(pushToken);
            }
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
