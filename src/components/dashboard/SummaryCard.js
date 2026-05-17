import React, {memo} from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import colors from '../../styles/colors';

const SummaryCard = memo(({type, count, label}) => {
  const isPending = type === 'pending';
  const iconName = isPending ? 'alert-circle' : 'checkmark-circle';
  const backgroundColor = isPending ? '#FFEFF0' : '#ECFAF1';
  const iconColor = isPending ? colors.error : colors.success;
  const textColor = isPending ? colors.error : colors.success;

  return (
    <View style={[styles.card, {backgroundColor}]}>
      <View style={[styles.iconContainer, {backgroundColor: iconColor}]}>
        <Ionicons name={iconName} size={24} color="#FFFFFF" />
      </View>
      <Text style={[styles.label, {color: textColor}]}>{label}</Text>
      <Text style={[styles.count, {color: textColor}]}>{count}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 18,
    padding: 18,
    alignItems: 'center',
    marginHorizontal: 6,
    minHeight: 120,
    justifyContent: 'center',
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
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  count: {
    fontSize: 32,
    fontWeight: 'bold',
  },
});

SummaryCard.displayName = 'SummaryCard';

export default SummaryCard;
