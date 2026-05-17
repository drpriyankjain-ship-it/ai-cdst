import {StyleSheet} from 'react-native';
import colors from './colors';
import typography from './typography';

export const globalStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    ...typography.h1,
    color: colors.textPrimary,
    marginBottom: 10,
  },
  subtitle: {
    ...typography.h3,
    color: colors.textSecondary,
    marginBottom: 20,
  },
  text: {
    ...typography.body,
    color: colors.textPrimary,
  },
  card: {
    backgroundColor: colors.backgroundLight,
    borderRadius: 10,
    padding: 15,
    marginBottom: 15,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 3.84,
    elevation: 5,
  },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonText: {
    ...typography.body,
    color: colors.textInverse,
    fontWeight: typography.fontWeight.semibold,
  },
});

export default globalStyles;
