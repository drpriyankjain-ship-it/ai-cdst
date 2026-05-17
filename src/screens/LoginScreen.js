import React, {useState, useCallback, useContext, useRef, useEffect} from 'react';
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
import {AuthContext} from '../context/AuthContext';
import useKeyboardCentering from '../hooks/useKeyboardCentering';

const LoginScreen = ({navigation}) => {
  const {login} = useContext(AuthContext);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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

  const handleLogin = useCallback(async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }

    setLoading(true);
    try {
      const result = await login(email.trim(), password);
      
      if (!result.success) {
        Alert.alert('Login Failed', result.error || 'Invalid credentials');
      }
      // If successful, AuthContext will update and App.js will navigate automatically
    } catch (error) {
      Alert.alert('Error', 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [email, password, login]);

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
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.iconContainer}>
              <Ionicons name="medical" size={40} color="#0D9488" />
            </View>
            <Text style={styles.title}>NurseAI</Text>
            <Text style={styles.subtitle}>Clinical Assistant</Text>
          </View>

          {/* Login Form */}
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
              />
            </View>

            <View style={styles.inputContainer}>
              <Ionicons name="lock-closed-outline" size={20} color="#999999" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#999999"
                value={password}
                onChangeText={setPassword}
                onFocus={handleFocus}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity
                onPress={() => setShowPassword(!showPassword)}
                style={styles.eyeIcon}>
                <Ionicons
                  name={showPassword ? 'eye-outline' : 'eye-off-outline'}
                  size={20}
                  color="#999999"
                />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.forgotLink}
              onPress={() => navigation.navigate('ForgotPassword')}>
              <Text style={styles.forgotText}>Forgot Password?</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleLogin}
              disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Login</Text>
              )}
            </TouchableOpacity>

            <View style={styles.registerContainer}>
              <Text style={styles.registerText}>Don't have an account? </Text>
              <TouchableOpacity onPress={() => navigation.navigate('Register')}>
                <Text style={styles.registerLink}>Sign Up</Text>
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
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  contentInner: {
    width: '100%',
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
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
    fontSize: 28,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    color: '#64748B',
  },
  form: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
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
  forgotLink: {
    alignSelf: 'flex-end',
    marginBottom: 16,
  },
  forgotText: {
    color: '#0D9488',
    fontSize: 14,
    fontWeight: '600',
  },
  eyeIcon: {
    padding: 4,
  },
  button: {
    backgroundColor: '#0D9488',
    paddingVertical: 16,
    borderRadius: 12,
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
  registerContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 24,
  },
  registerText: {
    fontSize: 14,
    color: '#64748B',
  },
  registerLink: {
    fontSize: 14,
    color: '#0D9488',
    fontWeight: '600',
  },
});

export default React.memo(LoginScreen);
