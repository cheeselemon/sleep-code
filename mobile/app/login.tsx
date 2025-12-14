import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useStore } from '@/lib/store';
import { relay } from '@/lib/relay';

export default function LoginScreen() {
  const router = useRouter();
  const { setToken } = useStore();
  const [serverUrl, setServerUrl] = useState('ws://localhost:8080');
  const [token, setTokenInput] = useState('test-token-123');
  const [loading, setLoading] = useState(false);

  async function handleConnect() {
    if (!token.trim()) {
      Alert.alert('Error', 'Please enter a token');
      return;
    }

    setLoading(true);

    try {
      // Set the relay URL
      relay.setUrl(`${serverUrl}/ws/mobile`);

      // Connect
      await relay.connect(token.trim());

      // Save token
      await SecureStore.setItemAsync('snowfort_token', token.trim());
      await SecureStore.setItemAsync('snowfort_server', serverUrl);
      setToken(token.trim());

      router.back();
    } catch (err) {
      Alert.alert('Connection Failed', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="ws://localhost:8080"
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>Token</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setTokenInput}
        placeholder="Your authentication token"
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      <Text style={styles.hint}>
        Get your token from the Snowfort daemon on your computer
      </Text>

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleConnect}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Connect</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
    padding: 24,
  },
  label: {
    color: '#9ca3af',
    fontSize: 14,
    marginBottom: 8,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#2a2a4a',
    borderRadius: 8,
    padding: 14,
    color: '#fff',
    fontSize: 16,
  },
  hint: {
    color: '#6b7280',
    fontSize: 13,
    marginTop: 8,
  },
  button: {
    backgroundColor: '#6366f1',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 32,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
