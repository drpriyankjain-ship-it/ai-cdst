import 'react-native-url-polyfill/auto';
import React, {useContext} from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {StatusBar} from 'expo-status-bar';
import {ActivityIndicator, View} from 'react-native';
import {AuthProvider, AuthContext} from './src/context/AuthContext';
import AppNavigator from './src/navigation/AppNavigator';
import AuthNavigator from './src/navigation/AuthNavigator';
import {registerRootComponent} from 'expo';

const RootNavigator = () => {
  const {isAuthenticated, loading} = useContext(AuthContext);

  if (loading) {
    return (
      <View style={{flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC'}}>
        <ActivityIndicator size="large" color="#0D9488" />
      </View>
    );
  }

  return isAuthenticated ? <AppNavigator /> : <AuthNavigator />;
};

function App() {
  return (
    <AuthProvider>
      <NavigationContainer>
        <StatusBar style="dark" />
        <RootNavigator />
      </NavigationContainer>
    </AuthProvider>
  );
}

registerRootComponent(App);
export default App;
