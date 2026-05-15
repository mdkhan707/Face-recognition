import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface MainMenuProps {
  isProcessing: boolean;
  onAuthenticatePress: () => void;
  onEnrollPress: () => void;
}

export default function MainMenu({ isProcessing, onAuthenticatePress, onEnrollPress }: MainMenuProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoText}>👤</Text>
        </View>
        <Text style={styles.title}>ScanGo</Text>
        <Text style={styles.subtitle}>Biometric Access Control System</Text>
      </View>


      <View style={styles.cardsContainer}>
        <TouchableOpacity
          style={[styles.card, isProcessing && styles.cardDisabled]}
          disabled={isProcessing}
          onPress={onAuthenticatePress}
        >
          <View style={[styles.iconContainer, { backgroundColor: '#FFF3CD' }]}>
            <Text style={styles.icon}>🔓</Text>
          </View>
          <View style={styles.cardTextContainer}>
            <Text style={styles.cardTitle}>Authenticate</Text>
            <Text style={styles.cardDesc}>Scan to verify identity</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.card, isProcessing && styles.cardDisabled]}
          disabled={isProcessing}
          onPress={onEnrollPress}
        >
          <View style={[styles.iconContainer, { backgroundColor: '#E8F5E9' }]}>
            <Text style={styles.icon}>➕</Text>
          </View>
          <View style={styles.cardTextContainer}>
            <Text style={styles.cardTitle}>Enroll Employee</Text>
            <Text style={styles.cardDesc}>Register new face ID</Text>
          </View>
        </TouchableOpacity>
      </View>

      {isProcessing && (
        <View style={styles.overlayContainer}>
          <View style={styles.overlayBox}>
            <ActivityIndicator color="#1B6E4B" size="large" />
            <Text style={styles.overlayText}>Verifying Identity...</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    paddingHorizontal: 25,
  },
  header: {
    alignItems: 'center',
    marginBottom: 60,
  },
  logoCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#E8F5E9',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#1B6E4B',
    shadowColor: '#1B6E4B',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 5,
  },
  logoText: {
    fontSize: 45,
  },
  title: {
    fontSize: 34,
    fontWeight: '900',
    color: '#1B6E4B',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginTop: 8,
    fontWeight: '500',
  },
  cardsContainer: {
    gap: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FAF4DE',
    borderRadius: 24,
    padding: 24,
    shadowColor: '#1B6E4B',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 4,
  },
  cardDisabled: {
    opacity: 0.6,
  },
  iconContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 20,
  },
  icon: {
    fontSize: 24,
  },
  cardTextContainer: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1B6E4B',
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 14,
    color: '#666',
    fontWeight: '500',
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(27, 110, 75, 0.30)',
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
