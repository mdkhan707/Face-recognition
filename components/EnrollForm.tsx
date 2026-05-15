import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Keyboard, ScrollView } from 'react-native';

interface EnrollFormProps {
  employeeName: string;
  setEmployeeName: (name: string) => void;
  isProcessing: boolean;
  authStatus: string;
  onStartScan: () => void;
  onCancel: () => void;
}

export default function EnrollForm({
  employeeName,
  setEmployeeName,
  isProcessing,
  authStatus,
  onStartScan,
  onCancel
}: EnrollFormProps) {
  return (
    <ScrollView 
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>New Enrollment</Text>
      
      <View style={styles.card}>
        <View style={styles.inputWrapper}>
          <Text style={styles.inputLabel}>FULL NAME</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Daniyal Khan"
            placeholderTextColor="#999"
            value={employeeName}
            onChangeText={setEmployeeName}
            autoFocus={false}
            editable={!isProcessing}
          />
        </View>


        {authStatus ? (
          <Text style={[styles.inlineStatus, { color: authStatus.includes("✅") ? "#34C759" : "#FF3B30" }]}>
            {authStatus}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[styles.primaryButton, { opacity: (employeeName && !isProcessing) ? 1 : 0.5 }]}
          disabled={!employeeName || isProcessing}
          onPress={() => {
            Keyboard.dismiss();
            onStartScan();
          }}
        >
          <Text style={styles.primaryButtonText}>{isProcessing ? "PROCESSING..." : "START SCAN"}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.cancelButton}
          onPress={onCancel}
          disabled={isProcessing}
        >
          <Text style={styles.cancelButtonText}>CANCEL</Text>
        </TouchableOpacity>
      </View>

      {isProcessing && (
        <View style={styles.overlayContainer}>
          <View style={styles.overlayBox}>
            <ActivityIndicator color="#1B6E4B" size="large" />
            <Text style={styles.overlayText}>Processing Face ID...</Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 25,
    paddingVertical: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    color: '#1B6E4B',
    marginBottom: 40,
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#FAF4DE',
    borderRadius: 24,
    padding: 30,
    shadowColor: '#1B6E4B',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 4,
  },
  inputWrapper: {
    marginBottom: 30,
  },
  inputLabel: {
    color: '#1B6E4B',
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 10,
    marginLeft: 5,
    letterSpacing: 1,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    color: '#1B6E4B',
    fontWeight: '600',
    fontSize: 18,
    borderWidth: 1,
    borderColor: '#EAEAEA',
  },
  primaryButton: {
    width: '100%',
    paddingVertical: 20,
    borderRadius: 16,
    backgroundColor: '#1B6E4B',
    alignItems: 'center',
    shadowColor: '#1B6E4B',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 4,
    marginBottom: 20,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
  cancelButton: {
    paddingVertical: 15,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#666',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
  inlineStatus: {
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 20,
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(27, 110, 75, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  overlayBox: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 30,
    paddingHorizontal: 40,
    borderRadius: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E8F5E9',
    shadowColor: '#1B6E4B',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 30,
    elevation: 8,
  },
  overlayText: {
    marginTop: 16,
    fontSize: 18,
    fontWeight: '800',
    color: '#1B6E4B',
    letterSpacing: 0.5,
  },
});
