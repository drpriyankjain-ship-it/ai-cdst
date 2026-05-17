import React from 'react';
import {FlatList, StyleSheet} from 'react-native';
import TranscriptCard from './TranscriptCard';

const TranscriptList = ({transcripts, onTranscriptPress}) => {
  const renderItem = ({item}) => (
    <TranscriptCard
      transcript={item}
      onPress={() => onTranscriptPress(item)}
    />
  );

  return (
    <FlatList
      data={transcripts}
      renderItem={renderItem}
      keyExtractor={item => item.id}
      contentContainerStyle={styles.list}
      showsVerticalScrollIndicator={false}
    />
  );
};

const styles = StyleSheet.create({
  list: {
    padding: 16,
    paddingBottom: 24,
  },
});

export default TranscriptList;
