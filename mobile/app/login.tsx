import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useStore } from '@/lib/store';
import { relay } from '@/lib/relay';

export default function LoginScreen() {
  const router = useRouter();
  const { setToken } = useStore();
  const [token, setTokenInput] = useState('test-token-123');
  const [loading, setLoading] = useState(false);

  async function handleConnect() {
    if (!token.trim()) {
      Alert.alert('Error', 'Please enter a token');
      return;
    }

    setLoading(true);

    try {
      // Connect to relay
      await relay.connect(token.trim());

      // Save token
      if (Platform.OS === 'web') {
        localStorage.setItem('snowfort_token', token.trim());
      } else {
        await SecureStore.setItemAsync('snowfort_token', token.trim());
      }
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
      <Text style={styles.title}>Connect to Snowfort</Text>

      <Text style={styles.label}>Token</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setTokenInput}
        placeholder="Your authentication token"
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.hint}>
        Use test-token-123 for development, or run "snowfort auth" to get a real token
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
  title: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 32,
    textAlign: 'center',
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
