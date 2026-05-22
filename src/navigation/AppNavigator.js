import React, {useMemo} from 'react';
import {createStackNavigator} from '@react-navigation/stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Ionicons} from '@expo/vector-icons';

// Screens
import HomePage from '../screens/HomePage';
import LiveConsultationScreen from '../screens/LiveConsultationScreen';
import TranscriptPage from '../screens/TranscriptPage';
import HistoryPage from '../screens/HistoryPage';
import AboutPage from '../screens/AboutPage';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

const MainTabs = () => {
  const tabBarOptions = useMemo(() => ({
    activeTintColor: '#0D9488',
    inactiveTintColor: '#94A3B8',
    style: {
      backgroundColor: '#FFFFFF',
      borderTopWidth: 1,
      borderTopColor: '#E2E8F0',
      height: 60,
      paddingBottom: 8,
      paddingTop: 8,
    },
    labelStyle: {
      fontSize: 12,
      fontWeight: '500',
    },
  }), []);

  return (
    <Tab.Navigator screenOptions={{...tabBarOptions, headerShown: false}}>
      <Tab.Screen 
        name="Dashboard" 
        component={HomePage}
        options={{
          tabBarIcon: ({color, size}) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen 
        name="Consult" 
        component={LiveConsultationScreen}
        options={{
          tabBarIcon: ({color, size}) => (
            <Ionicons name="pulse" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen 
        name="History" 
        component={HistoryPage}
        options={{
          tabBarIcon: ({color, size}) => (
            <Ionicons name="time" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen 
        name="Help" 
        component={AboutPage}
        options={{
          tabBarIcon: ({color, size}) => (
            <Ionicons name="help-circle" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
};

const AppNavigator = () => {
  return (
    <Stack.Navigator 
      initialRouteName="MainTabs"
      screenOptions={{
        headerStyle: {
          backgroundColor: '#FFFFFF',
        },
        headerTintColor: '#1E293B',
        headerTitleStyle: {
          fontWeight: '600',
        },
      }}>
      <Stack.Screen 
        name="MainTabs" 
        component={MainTabs} 
        options={{headerShown: false}}
      />
      <Stack.Screen 
        name="Transcript" 
        component={TranscriptPage}
        options={{title: 'Transcript'}}
      />
    </Stack.Navigator>
  );
};

export default AppNavigator;
