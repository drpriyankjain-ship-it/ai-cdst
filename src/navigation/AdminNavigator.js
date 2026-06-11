import React from 'react';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Ionicons} from '@expo/vector-icons';

import AdminCasesScreen from '../screens/AdminCasesScreen';
import AdminDoctorsScreen from '../screens/AdminDoctorsScreen';
import AdminMetricsScreen from '../screens/AdminMetricsScreen';
import HelpSupportScreen from '../screens/HelpSupportScreen'; // Assuming there's a generic Help screen or we can reuse it. Or we can just use the same one from AppNavigator

const Tab = createBottomTabNavigator();

export default function AdminNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({route}) => ({
        headerShown: false,
        tabBarIcon: ({focused, color, size}) => {
          let iconName;

          if (route.name === 'Cases') {
            iconName = focused ? 'folder-open' : 'folder-open-outline';
          } else if (route.name === 'Doctors') {
            iconName = focused ? 'medkit' : 'medkit-outline';
          } else if (route.name === 'Metrics') {
            iconName = focused ? 'stats-chart' : 'stats-chart-outline';
          } else if (route.name === 'Settings') {
            iconName = focused ? 'settings' : 'settings-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#0D9488',
        tabBarInactiveTintColor: '#94A3B8',
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopWidth: 1,
          borderTopColor: '#E2E8F0',
          paddingBottom: 5,
          paddingTop: 5,
          height: 60,
        },
      })}
    >
      <Tab.Screen name="Cases" component={AdminCasesScreen} />
      <Tab.Screen name="Doctors" component={AdminDoctorsScreen} />
      <Tab.Screen name="Metrics" component={AdminMetricsScreen} />
      <Tab.Screen name="Settings" component={HelpSupportScreen} />
    </Tab.Navigator>
  );
}
