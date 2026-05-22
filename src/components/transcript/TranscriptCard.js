import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Card from '../common/Card';
import colors from '../../styles/colors';

const TranscriptCard = ({transcript, onPress}) => {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
      <Card>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {transcript.title || 'Untitled Transcript'}
          </Text>
          <Text style={styles.date}>{transcript.date}</Text>
        </View>
        <Text style={styles.preview} numberOfLines={2}>
          {transcript.preview || 'No preview available'}
        </Text>
      </Card>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    flex: 1,
  },
  date: {
    fontSize: 14,
    color: colors.textTertiary,
    marginLeft: 10,
  },
  preview: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
});

export default TranscriptCard;
