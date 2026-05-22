// Authentication Context
import React, {createContext, useState, useEffect, useCallback} from 'react';
import authService from '../services/authService';

export const AuthContext = createContext();

export const AuthProvider = ({children}) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  // Check authentication status on mount
  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      const authenticated = await authService.isAuthenticated();
      const userData = await authService.getUserData();
      
      console.log('🔍 Auth status check:', { authenticated, hasUserData: !!userData });
      setIsAuthenticated(authenticated);
      setUser(userData);
      
      // Return the status for immediate use
      return { authenticated, userData };
    } catch (error) {
      console.error('Auth status check error:', error);
      setIsAuthenticated(false);
      setUser(null);
      return { authenticated: false, userData: null };
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (email, password) => {
    const result = await authService.login(email, password);
    if (result.success) {
      const userData = await authService.getUserData();
      setIsAuthenticated(true);
      setUser(userData);
    }
    return result;
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    setIsAuthenticated(false);
    setUser(null);
  }, []);

  const updateUser = useCallback((nextUser) => {
    setUser(nextUser);
  }, []);

  const value = {
    isAuthenticated,
    loading,
    user,
    login,
    logout,
    checkAuthStatus,
    updateUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
