import React, {useState, useEffect, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import {useNavigation} from '@react-navigation/native';
import apiService from '../services/apiService';

export default function AdminCasesScreen() {
  const navigation = useNavigation();
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Expanded case tracking
  const [expandedCaseId, setExpandedCaseId] = useState(null);

  const fetchCases = useCallback(async (query = '', isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const result = await apiService.getAdminCases(query);
      if (result.success) {
        setCases(result.data || []);
      } else {
        setError(result.error || 'Failed to fetch cases');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    fetchCases();
  }, [fetchCases]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchCases(searchQuery, true);
  }, [fetchCases, searchQuery]);

  const handleSearch = () => {
    fetchCases(searchQuery);
  };

  const clearSearch = () => {
    setSearchQuery('');
    fetchCases('');
  };

  const toggleExpand = (caseId) => {
    if (expandedCaseId === caseId) {
      setExpandedCaseId(null);
    } else {
      setExpandedCaseId(caseId);
    }
  };

  const getRiskColor = (tier) => {
    if (!tier) return '#94A3B8';
    const t = tier.toUpperCase();
    if (t === 'EMERGENCY' || t === 'HIGH') return '#EF4444'; // Red
    if (t === 'MEDIUM') return '#F59E0B'; // Orange
    if (t === 'LOW') return '#10B981'; // Green
    return '#94A3B8';
  };

  const renderCaseCard = ({item}) => {
    const isExpanded = expandedCaseId === item.session_id;
    const date = new Date(item.created_at).toLocaleString();
    const triage = item.triage_output?.triage || {};

    return (
      <View style={styles.card}>
        <TouchableOpacity 
          style={styles.cardHeader} 
          onPress={() => toggleExpand(item.session_id)}
          activeOpacity={0.7}
        >
          <View style={styles.cardHeaderTop}>
            <View style={styles.patientInfo}>
              <Text style={styles.patientName}>{item.patient_name || 'Unknown Patient'}</Text>
              <Text style={styles.patientId}>ID: {item.patient_id}</Text>
            </View>
            <View style={[styles.riskBadge, {backgroundColor: getRiskColor(item.risk_tier) + '20'}]}>
              <View style={[styles.riskDot, {backgroundColor: getRiskColor(item.risk_tier)}]} />
              <Text style={[styles.riskText, {color: getRiskColor(item.risk_tier)}]}>
                {item.risk_tier || 'UNKNOWN'}
              </Text>
            </View>
          </View>
          
          <View style={styles.nurseInfo}>
            <Ionicons name="person-outline" size={14} color="#64748B" />
            <Text style={styles.nurseText}>{item.nurse.name} ({item.nurse.email})</Text>
          </View>

          <View style={styles.cardHeaderBottom}>
            <Text style={styles.dateText}>{date}</Text>
            <Ionicons 
              name={isExpanded ? "chevron-up" : "chevron-down"} 
              size={20} 
              color="#94A3B8" 
            />
          </View>
        </TouchableOpacity>

        {isExpanded && (
          <View style={styles.expandedContent}>
            {item.one_liner ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Summary</Text>
                <Text style={styles.oneLinerText}>{item.one_liner}</Text>
              </View>
            ) : null}

            {item.problem_list?.problems?.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Problem List</Text>
                {item.problem_list.problems.map((p, i) => (
                  <Text key={i} style={styles.listItem}>• {p.condition || p.problem}</Text>
                ))}
              </View>
            )}

            {item.followups && item.followups.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Follow-up Q&A</Text>
                {item.followups.map((f, i) => (
                  <View key={i} style={styles.qaContainer}>
                    <Text style={styles.questionText}>Q: {f.question}</Text>
                    <Text style={styles.answerText}>A: {f.answer}</Text>
                  </View>
                ))}
              </View>
            )}

            <TouchableOpacity 
              style={styles.viewFullButton}
              onPress={() => navigation.navigate('Transcript', { task: item })}
            >
              <Text style={styles.viewFullButtonText}>View Full Transcript & Details</Text>
              <Ionicons name="arrow-forward" size={16} color="#0D9488" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>All Cases</Text>
        <Text style={styles.headerSubtitle}>Manage and review consultations</Text>
      </View>

      <View style={styles.searchContainer}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={20} color="#94A3B8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by nurse email, patient name, or ID"
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
            placeholderTextColor="#94A3B8"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={clearSearch} style={styles.clearIcon}>
              <Ionicons name="close-circle" size={20} color="#94A3B8" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
          <Text style={styles.searchButtonText}>Search</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchCases(searchQuery)}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#0D9488" />
          <Text style={styles.loadingText}>Loading cases...</Text>
        </View>
      ) : (
        <FlatList
          data={cases}
          keyExtractor={(item) => item.session_id}
          renderItem={renderCaseCard}
          contentContainerStyle={styles.listContainer}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={['#0D9488']}
              tintColor="#0D9488"
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="folder-open-outline" size={48} color="#CBD5E1" />
              <Text style={styles.emptyTitle}>No Cases Found</Text>
              <Text style={styles.emptyText}>
                {searchQuery ? "No results match your search." : "There are no active consultations in the system yet."}
              </Text>
            </View>
          }
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 24,
    paddingBottom: 20,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#64748B',
  },
  searchContainer: {
    flexDirection: 'row',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    alignItems: 'center',
    gap: 12,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#1E293B',
    height: '100%',
  },
  clearIcon: {
    padding: 4,
  },
  searchButton: {
    backgroundColor: '#0D9488',
    paddingHorizontal: 16,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
  listContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  cardHeader: {
    padding: 16,
  },
  cardHeaderTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  patientInfo: {
    flex: 1,
    paddingRight: 12,
  },
  patientName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 4,
  },
  patientId: {
    fontSize: 14,
    color: '#64748B',
    fontWeight: '500',
  },
  riskBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
  },
  riskDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  riskText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  nurseInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    padding: 8,
    borderRadius: 8,
    marginBottom: 12,
    gap: 6,
  },
  nurseText: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  cardHeaderBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  dateText: {
    fontSize: 13,
    color: '#94A3B8',
    fontWeight: '500',
  },
  expandedContent: {
    padding: 16,
    paddingTop: 0,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    backgroundColor: '#FAFAF9',
  },
  section: {
    marginTop: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  oneLinerText: {
    fontSize: 15,
    color: '#334155',
    lineHeight: 22,
  },
  listItem: {
    fontSize: 15,
    color: '#334155',
    marginBottom: 6,
    lineHeight: 22,
  },
  qaContainer: {
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  questionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0F172A',
    marginBottom: 6,
  },
  answerText: {
    fontSize: 14,
    color: '#334155',
    lineHeight: 20,
  },
  viewFullButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    paddingVertical: 12,
    backgroundColor: '#F0FDFA',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CCFBF1',
    gap: 8,
  },
  viewFullButtonText: {
    color: '#0D9488',
    fontSize: 15,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#64748B',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 16,
    color: '#EF4444',
    marginBottom: 16,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#0D9488',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 16,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E293B',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 16,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 24,
  },
});
