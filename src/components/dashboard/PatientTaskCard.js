import React, {memo} from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import Badge from '../common/Badge';
import colors from '../../styles/colors';

const PatientTaskCard = memo(({task, onPress}) => {
  const {patientName, taskDescription, scheduledTime, emergencyLevel, status} = task;

  return (
    <TouchableOpacity 
      style={styles.card} 
      onPress={onPress}
      activeOpacity={0.7}>
      <View style={styles.iconContainer}>
        <Ionicons name="pulse" size={24} color={colors.primary} />
      </View>
      
      <View style={styles.content}>
        <Text style={styles.patientName}>{patientName}</Text>
        <Text style={styles.taskDescription}>{taskDescription}</Text>
        <Text style={styles.scheduledTime}>{scheduledTime}</Text>
      </View>

      <View style={styles.badgesContainer}>
        {emergencyLevel && (
        <Badge label={emergencyLevel} variant={emergencyLevel.toLowerCase()} />
        )}
        {emergencyLevel && status && <View style={styles.badgeSpacing} />}
        {status && (
        <Badge label={status} variant={status.toLowerCase()} />
        )}
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: colors.backgroundLight,
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderLight,
    shadowColor: colors.shadow,
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E8F1FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  content: {
    flex: 1,
  },
  patientName: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  taskDescription: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  scheduledTime: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  badgesContainer: {
    alignItems: 'flex-end',
  },
  badgeSpacing: {
    height: 4,
  },
});

PatientTaskCard.displayName = 'PatientTaskCard';

export default PatientTaskCard;
