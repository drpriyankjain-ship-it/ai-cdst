import React, {memo} from 'react';
import {View, Text, StyleSheet} from 'react-native';
import colors from '../../styles/colors';

const Badge = memo(({label, variant = 'default'}) => {
  const getVariantStyle = () => {
    switch (variant) {
      case 'high':
        return styles.high;
      case 'medium':
        return styles.medium;
      case 'low':
        return styles.low;
      case 'pending':
        return styles.pending;
      case 'done':
        return styles.done;
      default:
        return styles.default;
    }
  };

  return (
    <View style={[styles.badge, getVariantStyle()]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
    textTransform: 'uppercase',
  },
  high: {
    backgroundColor: colors.error,
  },
  medium: {
    backgroundColor: colors.warning,
  },
  low: {
    backgroundColor: colors.success,
  },
  pending: {
    backgroundColor: colors.warning,
  },
  done: {
    backgroundColor: colors.success,
  },
  default: {
    backgroundColor: colors.textTertiary,
  },
});

Badge.displayName = 'Badge';

export default Badge;
