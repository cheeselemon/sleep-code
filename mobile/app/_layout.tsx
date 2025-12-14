import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useStore } from '@/lib/store';
import { relay } from '@/lib/relay';

export default function RootLayout() {
  const { setToken, token } = useStore();

  useEffect(() => {
    // Load saved token on app start
    async function loadToken() {
      try {
        const savedToken = await SecureStore.getItemAsync('snowfort_token');
        if (savedToken) {
          setToken(savedToken);
          // Auto-connect if we have a token
          relay.connect(savedToken).catch(console.error);
        }
      } catch (err) {
        console.error('Failed to load token:', err);
      }
    }
    loadToken();
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
