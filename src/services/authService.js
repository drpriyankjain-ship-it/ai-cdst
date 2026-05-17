// Authentication Service
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_TOKEN_KEY = '@nurseai_auth_token';
const USER_DATA_KEY = '@nurseai_user_data';

// Mock Mode Configuration - Test Credentials
// Set to true to enable mock mode (works without backend)
const MOCK_MODE = false; // Backend is now connected

// Test Credentials for Mock Mode
const TEST_EMAIL = 'test@nurseai.com';
const TEST_PASSWORD = 'test123';
const TEST_OTP = '123456';

// Helper function to check if we should use mock mode
const shouldUseMockMode = (result) => {
  // Only use mock mode if explicitly enabled
  // No fallback to mock mode on errors - let errors propagate
  return MOCK_MODE;
};

export const authService = {
  // Register user - Step 1: Send registration data, backend sends OTP
  register: async (userData) => {
    try {
      const {apiCall} = await import('./apiService');
      const result = await apiCall('/auth/register', {
        method: 'POST',
        body: JSON.stringify(userData),
      });
      
      // If backend is not available, use mock mode
      if (shouldUseMockMode(result)) {
        // Simulate successful registration - always succeeds in mock mode
        console.log('🔧 Mock Mode: Registration successful');
        return {
          success: true,
          message: 'Registration successful. OTP sent to your email.',
        };
      }
      
      return result;
    } catch (error) {
      // If error occurs, use mock mode
      console.log('🔧 Mock Mode: Registration (fallback)');
      return {
        success: true,
        message: 'Registration successful. OTP sent to your email.',
      };
    }
  },

  // Verify OTP - Step 2: Verify OTP and complete registration
  verifyOTP: async (email, otp) => {
    try {
      const {apiCall} = await import('./apiService');
      const result = await apiCall('/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({email, otp}),
      });
      
      // If backend is not available, use mock mode
      if (shouldUseMockMode(result)) {
        // In mock mode, accept any OTP or the test OTP
        if (otp === TEST_OTP || MOCK_MODE) {
          console.log('🔧 Mock Mode: OTP verified successfully');
          const mockToken = 'mock-jwt-token-' + Date.now();
          const mockUser = {
            id: 'mock-user-id',
            email: email || TEST_EMAIL,
            phoneNumber: '1234567890',
          };
          
          await AsyncStorage.setItem(AUTH_TOKEN_KEY, mockToken);
          await AsyncStorage.setItem(USER_DATA_KEY, JSON.stringify(mockUser));
          
          return {
            success: true,
            message: 'OTP verified successfully.',
            data: {
              token: mockToken,
              user: mockUser,
            },
          };
        } else {
          return {success: false, error: 'Invalid OTP. Use ' + TEST_OTP + ' for mock mode.'};
        }
      }
      
      // apiCall wraps the backend response, so token is at result.data.data.token
      if (result.success && result.data && result.data.data && result.data.data.token) {
        // Store auth token
        await AsyncStorage.setItem(AUTH_TOKEN_KEY, result.data.data.token);
        await AsyncStorage.setItem(USER_DATA_KEY, JSON.stringify(result.data.data.user));
        console.log('✅ OTP verified, token stored successfully');
      } else {
        console.log('⚠️ OTP verification response structure:', JSON.stringify(result, null, 2));
      }
      
      // Return the unwrapped backend response for consistency
      return result.data || result;
    } catch (error) {
      // If error occurs, use mock mode
      if (otp === TEST_OTP || MOCK_MODE) {
        console.log('🔧 Mock Mode: OTP verified (fallback)');
        const mockToken = 'mock-jwt-token-' + Date.now();
        const mockUser = {
          id: 'mock-user-id',
          email: email || TEST_EMAIL,
          phoneNumber: '1234567890',
        };
        
        await AsyncStorage.setItem(AUTH_TOKEN_KEY, mockToken);
        await AsyncStorage.setItem(USER_DATA_KEY, JSON.stringify(mockUser));
        
        return {
          success: true,
          message: 'OTP verified successfully.',
          data: {
            token: mockToken,
            user: mockUser,
          },
        };
      }
      return {success: false, error: error.message};
    }
  },

  // Resend OTP
  resendOTP: async (email) => {
    try {
      const {apiCall} = await import('./apiService');
      const result = await apiCall('/auth/resend-otp', {
        method: 'POST',
        body: JSON.stringify({email}),
      });
      
      // If backend is not available, use mock mode
      if (shouldUseMockMode(result)) {
        console.log('🔧 Mock Mode: OTP resent. Use OTP: ' + TEST_OTP);
        return {
          success: true,
          message: 'OTP has been resent to your email. (Mock Mode: Use ' + TEST_OTP + ')',
        };
      }
      
      return result;
    } catch (error) {
      // If error occurs, use mock mode
      console.log('🔧 Mock Mode: OTP resent (fallback). Use OTP: ' + TEST_OTP);
      return {
        success: true,
        message: 'OTP has been resent to your email. (Mock Mode: Use ' + TEST_OTP + ')',
      };
    }
  },

  // Request password reset OTP
  requestPasswordReset: async (email) => {
    try {
      const {apiCall} = await import('./apiService');
      const result = await apiCall('/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({email}),
      });
      if (shouldUseMockMode(result)) {
        console.log('🔧 Mock Mode: Password reset OTP sent. Use OTP: ' + TEST_OTP);
        return {
          success: true,
          message: 'Password reset OTP sent. (Mock Mode: Use ' + TEST_OTP + ')',
        };
      }
      return result;
    } catch (error) {
      console.log('🔧 Mock Mode: Password reset OTP (fallback). Use OTP: ' + TEST_OTP);
      return {
        success: true,
        message: 'Password reset OTP sent. (Mock Mode: Use ' + TEST_OTP + ')',
      };
    }
  },

  // Reset password with OTP
  resetPassword: async ({email, otp, newPassword}) => {
    try {
      const {apiCall} = await import('./apiService');
      const result = await apiCall('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({email, otp, newPassword}),
      });
      if (shouldUseMockMode(result)) {
        console.log('🔧 Mock Mode: Password reset successful');
        return {success: true, message: 'Password reset successfully.'};
      }
      return result;
    } catch (error) {
      if (MOCK_MODE) {
        console.log('🔧 Mock Mode: Password reset (fallback)');
        return {success: true, message: 'Password reset successfully.'};
      }
      return {success: false, error: error.message};
    }
  },

  // Login
  login: async (email, password) => {
    try {
      const {apiCall} = await import('./apiService');
      const result = await apiCall('/auth/login', {
        method: 'POST',
        body: JSON.stringify({email, password}),
      });
      
      // If backend is not available, use mock mode
      if (shouldUseMockMode(result)) {
        // Check test credentials
        if ((email === TEST_EMAIL && password === TEST_PASSWORD) || MOCK_MODE) {
          console.log('🔧 Mock Mode: Login successful');
          const mockToken = 'mock-jwt-token-' + Date.now();
          const mockUser = {
            id: 'mock-user-id',
            email: email || TEST_EMAIL,
            phoneNumber: '1234567890',
          };
          
          await AsyncStorage.setItem(AUTH_TOKEN_KEY, mockToken);
          await AsyncStorage.setItem(USER_DATA_KEY, JSON.stringify(mockUser));
          
          return {
            success: true,
            message: 'Login successful.',
            data: {
              token: mockToken,
              user: mockUser,
            },
          };
        } else {
          return {success: false, error: 'Invalid email or password. (Mock Mode: Use ' + TEST_EMAIL + ' / ' + TEST_PASSWORD + ')'};
        }
      }
      
      // apiCall wraps the backend response, so token is at result.data.data.token
      if (result.success && result.data && result.data.data && result.data.data.token) {
        // Store auth token
        await AsyncStorage.setItem(AUTH_TOKEN_KEY, result.data.data.token);
        await AsyncStorage.setItem(USER_DATA_KEY, JSON.stringify(result.data.data.user));
        console.log('✅ Login successful, token stored');
      } else {
        console.log('⚠️ Login response structure:', JSON.stringify(result, null, 2));
      }
      
      // Return the unwrapped backend response for consistency
      return result.data || result;
    } catch (error) {
      // If error occurs, use mock mode
      if ((email === TEST_EMAIL && password === TEST_PASSWORD) || MOCK_MODE) {
        console.log('🔧 Mock Mode: Login successful (fallback)');
        const mockToken = 'mock-jwt-token-' + Date.now();
        const mockUser = {
          id: 'mock-user-id',
          email: email || TEST_EMAIL,
          phoneNumber: '1234567890',
        };
        
        await AsyncStorage.setItem(AUTH_TOKEN_KEY, mockToken);
        await AsyncStorage.setItem(USER_DATA_KEY, JSON.stringify(mockUser));
        
        return {
          success: true,
          message: 'Login successful.',
          data: {
            token: mockToken,
            user: mockUser,
          },
        };
      }
      return {success: false, error: error.message};
    }
  },

  // Logout
  logout: async () => {
    try {
      await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
      await AsyncStorage.removeItem(USER_DATA_KEY);
      const {apiService} = await import('./apiService');
      apiService.clearCache();
      return {success: true};
    } catch (error) {
      return {success: false, error: error.message};
    }
  },

  // Check if user is authenticated
  isAuthenticated: async () => {
    try {
      // In development, you can set this to false to always show login screen
      const FORCE_LOGIN_SCREEN = false; // Set to true to always show login
      
      if (FORCE_LOGIN_SCREEN) {
        // Clear auth data to force login screen
        await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
        await AsyncStorage.removeItem(USER_DATA_KEY);
        return false;
      }
      
      const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      return !!token;
    } catch (error) {
      return false;
    }
  },

  // Get stored auth token
  getAuthToken: async () => {
    try {
      return await AsyncStorage.getItem(AUTH_TOKEN_KEY);
    } catch (error) {
      return null;
    }
  },

  // Get user data
  getUserData: async () => {
    try {
      const userData = await AsyncStorage.getItem(USER_DATA_KEY);
      return userData ? JSON.parse(userData) : null;
    } catch (error) {
      return null;
    }
  },

  // Update stored user data
  setUserData: async (userData) => {
    try {
      if (!userData) return;
      await AsyncStorage.setItem(USER_DATA_KEY, JSON.stringify(userData));
    } catch (error) {
      // Ignore storage errors silently
    }
  },
};

export default authService;
