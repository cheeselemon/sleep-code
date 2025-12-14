import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useStore } from '@/lib/store';
import { relay } from '@/lib/relay';
import { useEffect, useRef, useState } from 'react';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { sessions, sessionOutputs, setCurrentSession } = useStore();
  const [input, setInput] = useState('');
  const scrollViewRef = useRef<ScrollView>(null);

  const session = sessions.find((s) => s.id === id);
  const outputs = sessionOutputs.get(id || '') || [];

  useEffect(() => {
    if (id) {
      setCurrentSession(id);
      relay.subscribeToSession(id);

      return () => {
        relay.unsubscribeFromSession(id);
        setCurrentSession(null);
      };
    }
  }, [id]);

  useEffect(() => {
    // Auto-scroll to bottom when new output arrives
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [outputs]);

  function handleSend() {
    if (!input.trim() || !id) return;

    relay.sendInput(id, input.trim());
    setInput('');
  }

  if (!session) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Session not found</Text>
      </View>
    );
  }

  const statusColors = {
    running: '#4ade80',
    idle: '#facc15',
    ended: '#6b7280',
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: session.name.length > 20 ? session.name.slice(0, 20) + '...' : session.name,
          headerRight: () => (
            <View style={[styles.statusDot, { backgroundColor: statusColors[session.status] }]} />
          ),
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={100}
      >
        <View style={styles.pathBar}>
          <Text style={styles.pathText} numberOfLines={1}>
            {session.cwd}
          </Text>
        </View>

        <ScrollView
          ref={scrollViewRef}
          style={styles.outputContainer}
          contentContainerStyle={styles.outputContent}
        >
          {outputs.length === 0 ? (
            <Text style={styles.emptyText}>Waiting for output...</Text>
          ) : (
            outputs.map((output, index) => (
              <Text key={index} style={styles.outputText}>
                {output}
              </Text>
            ))
          )}
        </ScrollView>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Type a message..."
            placeholderTextColor="#6b7280"
            multiline
            maxLength={10000}
            editable={session.status !== 'ended'}
          />
          <TouchableOpacity
            style={[styles.sendButton, !input.trim() && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!input.trim() || session.status === 'ended'}
          >
            <Text style={styles.sendButtonText}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  pathBar: {
    padding: 12,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4a',
  },
  pathText: {
    color: '#6b7280',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  outputContainer: {
    flex: 1,
  },
  outputContent: {
    padding: 16,
  },
  emptyText: {
    color: '#6b7280',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 32,
  },
  outputText: {
    color: '#e5e7eb',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    marginBottom: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#1a1a2e',
    borderTopWidth: 1,
    borderTopColor: '#2a2a4a',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    backgroundColor: '#0f0f1a',
    borderWidth: 1,
    borderColor: '#2a2a4a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 15,
    maxHeight: 100,
    marginRight: 8,
  },
  sendButton: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 32,
  },
});
