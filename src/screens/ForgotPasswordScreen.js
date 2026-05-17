import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  ScrollView,
  Keyboard,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import authService from '../services/authService';
import useKeyboardCentering from '../hooks/useKeyboardCentering';

const ForgotPasswordScreen = ({navigation}) => {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState('request');
  const [loading, setLoading] = useState(false);
  const scrollViewRef = useRef(null);
  const {onScroll, handleFocus} = useKeyboardCentering(scrollViewRef);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates?.height || 0);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleRequestOtp = useCallback(async () => {
    if (!email.trim()) {
      Alert.alert('Error', 'Please enter your email.');
      return;
    }
    setLoading(true);
    const result = await authService.requestPasswordReset(email.trim());
    setLoading(false);
    if (result.success) {
      Alert.alert('OTP Sent', 'Check your email for the password reset OTP.');
      setStep('reset');
    } else {
      Alert.alert('Error', result.error || 'Failed to send OTP.');
    }
  }, [email]);

  const handleResetPassword = useCallback(async () => {
    if (!email.trim() || !otp.trim() || !newPassword.trim() || !confirmPassword.trim()) {
      Alert.alert('Error', 'Please fill in all fields.');
      return;
    }
    if (newPassword.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match.');
      return;
    }
    setLoading(true);
    const result = await authService.resetPassword({
      email: email.trim(),
      otp: otp.trim(),
      newPassword: newPassword.trim(),
    });
    setLoading(false);
    if (result.success) {
      Alert.alert('Success', 'Password reset successfully. Please log in.');
      navigation.navigate('Login');
    } else {
      Alert.alert('Error', result.error || 'Failed to reset password.');
    }
  }, [email, otp, newPassword, confirmPassword, navigation]);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}>
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={16}>
          <View style={styles.contentInner}>
            <View style={styles.header}>
              <View style={styles.iconContainer}>
                <Ionicons name="lock-open-outline" size={40} color="#0D9488" />
              </View>
              <Text style={styles.title}>Reset Password</Text>
              <Text style={styles.subtitle}>
                {step === 'request'
                  ? 'Enter your email to receive an OTP.'
                  : 'Enter the OTP and choose a new password.'}
              </Text>
            </View>

            <View style={styles.form}>
              <View style={styles.inputContainer}>
                <Ionicons name="mail-outline" size={20} color="#999999" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Email"
                  placeholderTextColor="#999999"
                  value={email}
                  onChangeText={setEmail}
                  onFocus={handleFocus}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={step === 'request'}
                />
              </View>

              {step === 'reset' && (
                <>
                  <View style={styles.inputContainer}>
                    <Ionicons name="key-outline" size={20} color="#999999" style={styles.inputIcon} />
                    <TextInput
                      style={styles.input}
                      placeholder="OTP"
                      placeholderTextColor="#999999"
                      value={otp}
                      onChangeText={setOtp}
                      onFocus={handleFocus}
                      keyboardType="number-pad"
                    />
                  </View>

                  <View style={styles.inputContainer}>
                    <Ionicons name="lock-closed-outline" size={20} color="#999999" style={styles.inputIcon} />
                    <TextInput
                      style={styles.input}
                      placeholder="New Password"
                      placeholderTextColor="#999999"
                      value={newPassword}
                      onChangeText={setNewPassword}
                      onFocus={handleFocus}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                    />
                    <TouchableOpacity
                      onPress={() => setShowPassword((prev) => !prev)}
                      style={styles.eyeIcon}>
                      <Ionicons
                        name={showPassword ? 'eye-outline' : 'eye-off-outline'}
                        size={20}
                        color="#999999"
                      />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.inputContainer}>
                    <Ionicons name="lock-closed-outline" size={20} color="#999999" style={styles.inputIcon} />
                    <TextInput
                      style={styles.input}
                      placeholder="Confirm Password"
                      placeholderTextColor="#999999"
                      value={confirmPassword}
                      onChangeText={setConfirmPassword}
                      onFocus={handleFocus}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                    />
                  </View>
                </>
              )}

              <TouchableOpacity
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={step === 'request' ? handleRequestOtp : handleResetPassword}
                disabled={loading}>
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.buttonText}>
                    {step === 'request' ? 'Send OTP' : 'Reset Password'}
                  </Text>
                )}
              </TouchableOpacity>

              {step === 'reset' && (
                <TouchableOpacity
                  style={styles.resendLink}
                  onPress={handleRequestOtp}
                  disabled={loading}>
                  <Text style={styles.resendText}>Resend OTP</Text>
                </TouchableOpacity>
              )}

              <View style={styles.backContainer}>
                <TouchableOpacity onPress={() => navigation.navigate('Login')}>
                  <Text style={styles.backLink}>Back to Login</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={{height: keyboardHeight}} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  keyboardView: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  contentInner: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  header: {
    alignItems: 'center',
    marginBottom: 28,
  },
  iconContainer: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#E6FFFA',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
  },
  form: {
    width: '100%',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
    height: 52,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: '#1E293B',
  },
  eyeIcon: {
    padding: 4,
  },
  button: {
    backgroundColor: '#0D9488',
    borderRadius: 12,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
  resendLink: {
    marginTop: 12,
    alignItems: 'center',
  },
  resendText: {
    color: '#0D9488',
    fontSize: 14,
    fontWeight: '600',
  },
  backContainer: {
    marginTop: 20,
    alignItems: 'center',
  },
  backLink: {
    color: '#0D9488',
    fontSize: 14,
    fontWeight: '600',
  },
});

export default React.memo(ForgotPasswordScreen);
