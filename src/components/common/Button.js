import React from 'react';
import {TouchableOpacity, Text, StyleSheet} from 'react-native';
import colors from '../../styles/colors';

const Button = ({title, onPress, variant = 'primary', style}) => {
  const buttonStyle = variant === 'primary' ? styles.primaryButton : styles.secondaryButton;
  const textStyle = variant === 'primary' ? styles.primaryText : styles.secondaryText;

  return (
    <TouchableOpacity
      style={[buttonStyle, style]}
      onPress={onPress}
      activeOpacity={0.7}>
      <Text style={textStyle}>{title}</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 14,
    alignItems: 'center',
    minHeight: 48,
    shadowColor: colors.shadow,
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 4,
  },
  secondaryButton: {
    backgroundColor: colors.backgroundLight,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    minHeight: 48,
  },
  primaryText: {
    color: colors.textInverse,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '600',
  },
});

export default Button;
