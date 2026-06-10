import React, {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  SafeAreaView,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  TouchableOpacity,
  Pressable,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import apiService from '../services/apiService';
import useKeyboardCentering from '../hooks/useKeyboardCentering';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const SOURCE_LABELS = {
  'gemini-diagnosis': 'Diagnosis',
  gemini: 'Prescription',
  manual: 'Manual',
};

const SOURCE_COLORS = {
  'gemini-diagnosis': {bg: '#FFF7ED', text: '#C2410C'},
  gemini: {bg: '#E6FFFA', text: '#0D9488'},
  manual: {bg: '#F1F5F9', text: '#64748B'},
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'});
}

const TranscriptItem = React.memo(({item, isExpanded, onToggle}) => {
  const colors = SOURCE_COLORS[item.source] || SOURCE_COLORS.manual;
  const label = SOURCE_LABELS[item.source] || item.source || 'Unknown';
  return (
    <Pressable onPress={onToggle} style={styles.visitItem}>
      <View style={styles.visitHeader}>
        <View style={styles.visitDateRow}>
          <Ionicons name="calendar-outline" size={14} color="#94A3B8" />
          <Text style={styles.visitDate}>{formatDate(item.createdAt)}</Text>
        </View>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
          {item.verificationStatus === 'verified' && (
            <View style={styles.verifiedBadge}>
              <Ionicons name="shield-checkmark" size={11} color="#059669" />
              <Text style={styles.verifiedBadgeText}>Verified</Text>
            </View>
          )}
          <View style={[styles.sourceBadge, {backgroundColor: colors.bg}]}>
            <Text style={[styles.sourceBadgeText, {color: colors.text}]}>{label}</Text>
          </View>
        </View>
      </View>
      <Text style={styles.visitContent} numberOfLines={isExpanded ? undefined : 4}>
        {item.content || 'No content'}
      </Text>
    </Pressable>
  );
});

const PatientCard = React.memo(({group, isExpanded, onToggle, navigation}) => {
  const [expandedVisitId, setExpandedVisitId] = useState(null);
  const latestPreview = group.transcripts[0]?.content || '';
  const previewText = latestPreview.length > 120
    ? latestPreview.slice(0, 120) + '...'
    : latestPreview;

  const toggleVisit = useCallback((id) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedVisitId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <View style={styles.patientCard}>
      <Pressable onPress={onToggle} style={styles.patientCardHeader}>
        <View style={styles.patientInfo}>
          <View style={styles.patientAvatar}>
            <Text style={styles.patientAvatarText}>
              {(group.patientName || '?')[0].toUpperCase()}
            </Text>
          </View>
          <View style={styles.patientDetails}>
            <Text style={styles.patientName} numberOfLines={1}>
              {group.patientName || 'Unknown Patient'}
            </Text>
            <Text style={styles.patientId}>
              ID: {group.patientId || 'N/A'}
            </Text>
          </View>
        </View>
        <View style={styles.patientMeta}>
          <View style={styles.visitCountBadge}>
            <Text style={styles.visitCountText}>
              {group.visitCount} {group.visitCount === 1 ? 'entry' : 'entries'}
            </Text>
          </View>
          <Text style={styles.latestDate}>{formatDate(group.latestDate)}</Text>
          <Ionicons
            name={isExpanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color="#94A3B8"
            style={styles.chevron}
          />
        </View>
      </Pressable>

      {!isExpanded && (
        <View style={styles.previewContainer}>
          <Text style={styles.previewText} numberOfLines={2}>
            {previewText}
          </Text>
        </View>
      )}

      {isExpanded && (
        <View style={styles.visitsContainer}>
          {group.transcripts.map((t) => (
            <TranscriptItem
              key={t.id}
              item={t}
              isExpanded={expandedVisitId === t.id}
              onToggle={() => toggleVisit(t.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
});

const HistoryPage = ({navigation}) => {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState(null);
  const [expandedPatientKey, setExpandedPatientKey] = useState(null);
  const [mgmtHistory, setMgmtHistory] = useState([]);
  const [expandedMgmtId, setExpandedMgmtId] = useState(null);
  const listRef = useRef(null);
  const {onScroll, handleFocus} = useKeyboardCentering(listRef);

  const fetchData = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) {
        setLoading(true);
        setError(null);
      }

      const [result, mgmtResult] = await Promise.all([
        apiService.getGroupedTranscripts(),
        apiService.getManagementPlanHistory(),
      ]);

      if (result.success) {
        setGroups(result.data || []);
        setError(null);
      } else {
        setGroups([]);
        setError(result.error || 'Failed to load history');
      }

      if (mgmtResult.success) {
        setMgmtHistory(mgmtResult.data || []);
      } else {
        setMgmtHistory([]);
      }
    } catch (err) {
      console.error('Error fetching history:', err);
      setGroups([]);
      setMgmtHistory([]);
      setError('Network error. Please check your connection.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      apiService.clearCache();
      fetchData(true);
    });
    return unsubscribe;
  }, [navigation, fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    apiService.clearCache();
    fetchData(true);
  }, [fetchData]);

  const filteredGroups = useMemo(() => {
    const arr = Array.isArray(groups) ? groups : [];
    if (!searchQuery.trim()) return arr;
    const q = searchQuery.toLowerCase();
    return arr.filter(
      (g) =>
        g.patientName?.toLowerCase().includes(q) ||
        g.patientId?.toLowerCase().includes(q)
    );
  }, [groups, searchQuery]);

  const togglePatient = useCallback((key) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedPatientKey((prev) => (prev === key ? null : key));
  }, []);

  const toggleMgmt = useCallback((id) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedMgmtId((prev) => (prev === id ? null : id));
  }, []);

  const filteredMgmtHistory = useMemo(() => {
    const arr = Array.isArray(mgmtHistory) ? mgmtHistory : [];
    if (!searchQuery.trim()) return arr;
    const q = searchQuery.toLowerCase();
    return arr.filter(
      (p) =>
        p.patient_name?.toLowerCase().includes(q) ||
        p.patient_id?.toLowerCase().includes(q)
    );
  }, [mgmtHistory, searchQuery]);

  const renderMgmtHeader = useMemo(() => {
    if (filteredMgmtHistory.length === 0) return null;
    return (
      <View style={styles.mgmtHistorySection}>
        <Text style={styles.mgmtHistoryTitle}>Cleared Management Plans</Text>
        {filteredMgmtHistory.map((plan) => {
          const isExpanded = expandedMgmtId === plan.id;
          const mgmt = typeof plan.management_plan === 'string' ? JSON.parse(plan.management_plan) : (plan.management_plan || {});
          const riskTier = mgmt.risk_tier || 'unknown';
          const proforma = typeof plan.proforma === 'string' ? JSON.parse(plan.proforma) : (plan.proforma || null);
          const clarifying = typeof plan.clarifying_questions === 'string' ? JSON.parse(plan.clarifying_questions) : (plan.clarifying_questions || null);
          const problemList = mgmt.problem_list;
          const triage = mgmt.triage_output;
          return (
            <Pressable key={plan.id} onPress={() => toggleMgmt(plan.id)} style={styles.mgmtHistoryCard}>
              <View style={styles.mgmtHistoryHeader}>
                <View style={{flex: 1}}>
                  <Text style={styles.mgmtHistoryName}>{plan.patient_name || plan.patient_id || 'Unknown'}</Text>
                  <Text style={styles.mgmtHistoryId}>ID: {plan.patient_id || 'N/A'}</Text>
                </View>
                <View style={[styles.mgmtRiskBadge, riskTier === 'HIGH' ? styles.mgmtRiskHigh : styles.mgmtRiskLow]}>
                  <Text style={[styles.mgmtRiskText, riskTier === 'HIGH' ? {color: '#DC2626'} : {color: '#059669'}]}>{riskTier}</Text>
                </View>
              </View>
              <View style={{flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6}}>
                <Ionicons name={plan.source === 'live' ? 'pulse' : 'cloud-upload'} size={11} color="#94A3B8" />
                <Text style={{fontSize: 11, color: '#94A3B8'}}>{plan.source === 'live' ? 'Live' : 'Upload'}</Text>
                <Text style={{fontSize: 11, color: '#94A3B8', marginLeft: 'auto'}}>
                  {plan.created_at ? new Date(plan.created_at).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'}) : ''}
                </Text>
              </View>
              {triage && (
                <Text style={{fontSize: 13, color: '#475569', lineHeight: 19}} numberOfLines={isExpanded ? undefined : 2}>
                  {triage?.triage?.one_liner || triage?.one_liner || triage?.action || (typeof triage === 'string' ? triage : '')}
                </Text>
              )}
              {isExpanded && (
                <View style={styles.mgmtExpandedSection}>
                  {/* Problem List / Management Plan */}
                  {problemList && (() => {
                    const problems = problemList?.problem_list || (Array.isArray(problemList) ? problemList : []);
                    return problems.length > 0 ? (
                      <View style={styles.mgmtSubBlock}>
                        <Text style={styles.mgmtSubBlockTitle}>Management Plan</Text>
                        {problems.map((p, i) => (
                          <View key={i} style={{marginBottom: i < problems.length - 1 ? 10 : 0}}>
                            <View style={{flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3}}>
                              <Text style={{fontSize: 13, fontWeight: '700', color: '#1E293B'}}>
                                {p.diagnosis || p.disease || `Problem ${i + 1}`}
                              </Text>
                              {p.type && (
                                <View style={{backgroundColor: p.type === 'acute_new' ? '#FEE2E2' : '#E0F2FE', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4}}>
                                  <Text style={{fontSize: 9, fontWeight: '700', color: p.type === 'acute_new' ? '#DC2626' : '#0369A1'}}>
                                    {p.type?.replace(/_/g, ' ').toUpperCase()}
                                  </Text>
                                </View>
                              )}
                            </View>
                            {p.assessment?.provisional_diagnosis && (
                              <Text style={{fontSize: 12, color: '#475569', marginBottom: 2}}>
                                Dx: {p.assessment.provisional_diagnosis}
                              </Text>
                            )}
                            {(p.prescription?.drugs || []).map((drug, di) => (
                              <Text key={di} style={{fontSize: 12, color: '#475569', marginLeft: 8}}>
                                💊 {drug.name} {drug.dose || ''} {drug.route || ''} {drug.frequency || ''} {drug.duration ? `× ${drug.duration}` : ''}
                              </Text>
                            ))}
                            {(p.prescription?.non_pharmacological || []).map((np, ni) => (
                              <Text key={ni} style={{fontSize: 12, color: '#64748B', marginLeft: 8}}>
                                • {typeof np === 'string' ? np : np.instruction || np.measure || ''}
                              </Text>
                            ))}
                            {p.prescription?.referral && (
                              <Text style={{fontSize: 12, color: '#B45309', marginLeft: 8, marginTop: 2}}>
                                ↗ Refer: {typeof p.prescription.referral === 'string' ? p.prescription.referral : p.prescription.referral.to || p.prescription.referral.reason || ''}
                              </Text>
                            )}
                          </View>
                        ))}
                      </View>
                    ) : null;
                  })()}

                  {/* Triage details */}
                  {triage && (
                    <View style={styles.mgmtSubBlock}>
                      <Text style={styles.mgmtSubBlockTitle}>Triage & Instructions</Text>
                      {(triage?.triage?.referral || triage?.referral) && (
                        <Text style={{fontSize: 12, color: '#B45309', marginBottom: 4}}>
                          ↗ {typeof (triage?.triage?.referral || triage?.referral) === 'string'
                              ? (triage?.triage?.referral || triage?.referral)
                              : (triage?.triage?.referral?.to || triage?.referral?.to || 'Referral advised')}
                        </Text>
                      )}
                      {(() => {
                        const instr = triage?.triage?.patient_instructions || triage?.patient_instructions;
                        if (!instr) return null;
                        const doList = instr.do_list || instr.do || [];
                        const dontList = instr.dont_list || instr.dont || [];
                        const returnCriteria = instr.return_criteria || instr.return_if || [];
                        return (
                          <View>
                            {doList.length > 0 && doList.map((item, i) => (
                              <Text key={`do-${i}`} style={{fontSize: 12, color: '#059669', marginLeft: 4}}>✓ {item}</Text>
                            ))}
                            {dontList.length > 0 && dontList.map((item, i) => (
                              <Text key={`dont-${i}`} style={{fontSize: 12, color: '#DC2626', marginLeft: 4}}>✗ {item}</Text>
                            ))}
                            {returnCriteria.length > 0 && (
                              <View style={{marginTop: 4}}>
                                <Text style={{fontSize: 11, fontWeight: '600', color: '#92400E'}}>Return if:</Text>
                                {returnCriteria.map((item, i) => (
                                  <Text key={`ret-${i}`} style={{fontSize: 12, color: '#92400E', marginLeft: 4}}>⚠ {item}</Text>
                                ))}
                              </View>
                            )}
                          </View>
                        );
                      })()}
                    </View>
                  )}

                  {/* Clarifying Questions */}
                  {clarifying && (() => {
                    const questions = clarifying?.questions || (Array.isArray(clarifying) ? clarifying : []);
                    return questions.length > 0 ? (
                      <View style={styles.mgmtSubBlock}>
                        <Text style={styles.mgmtSubBlockTitle}>Clarifying Questions</Text>
                        {questions.map((q, i) => (
                          <Text key={i} style={{fontSize: 12, color: '#475569', marginBottom: 2}}>
                            {i + 1}. {typeof q === 'string' ? q : q.question || q.text || ''}
                          </Text>
                        ))}
                      </View>
                    ) : null;
                  })()}
                </View>
              )}
              <Text style={{fontSize: 11, color: '#94A3B8', marginTop: 6}}>
                {isExpanded ? 'Tap to collapse' : 'Tap to expand'}
              </Text>
            </Pressable>
          );
        })}
        {/* Divider before transcript history */}
        <View style={{height: 1, backgroundColor: '#E2E8F0', marginVertical: 8}} />
        <Text style={[styles.mgmtHistoryTitle, {marginTop: 4}]}>Transcript History</Text>
      </View>
    );
  }, [filteredMgmtHistory, expandedMgmtId, toggleMgmt]);

  const renderItem = useCallback(
    ({item}) => {
      const key = item.patientId || item.patientName || 'unknown';
      return (
        <PatientCard
          group={item}
          isExpanded={expandedPatientKey === key}
          onToggle={() => togglePatient(key)}
          navigation={navigation}
        />
      );
    },
    [expandedPatientKey, togglePatient, navigation]
  );

  const keyExtractor = useCallback(
    (item) => item.patientId || item.patientName || 'unknown',
    []
  );

  const renderEmpty = useMemo(() => {
    if (error) {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="alert-circle-outline" size={64} color="#DC2626" />
          <Text style={styles.emptyText}>Error Loading History</Text>
          <Text style={styles.emptySubtext}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchData()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="people-outline" size={64} color="#CCCCCC" />
        <Text style={styles.emptyText}>No patient history</Text>
        <Text style={styles.emptySubtext}>
          {searchQuery
            ? 'No patients match your search'
            : 'Patient records will appear here after recordings are processed.'}
        </Text>
      </View>
    );
  }, [searchQuery, error, fetchData]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#0D9488" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Text style={styles.title}>Patient History</Text>
        <View style={styles.searchContainer}>
          <Ionicons name="search" size={20} color="#94A3B8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by patient name or ID..."
            placeholderTextColor="#94A3B8"
            value={searchQuery}
            onChangeText={setSearchQuery}
            onFocus={handleFocus}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={20} color="#94A3B8" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={filteredGroups}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={
          filteredGroups.length === 0 && filteredMgmtHistory.length === 0 ? styles.emptyList : styles.list
        }
        ListHeaderComponent={renderMgmtHeader}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F7F8FA',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    paddingTop: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 12,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: '#1E293B',
  },
  list: {
    padding: 12,
  },
  emptyList: {
    flex: 1,
  },
  patientCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    overflow: 'hidden',
  },
  patientCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  patientInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  patientAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0D9488',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  patientAvatarText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  patientDetails: {
    flex: 1,
  },
  patientName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1E293B',
  },
  patientId: {
    fontSize: 13,
    color: '#666666',
    marginTop: 2,
  },
  patientMeta: {
    alignItems: 'flex-end',
  },
  visitCountBadge: {
    backgroundColor: '#E6FFFA',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    marginBottom: 4,
  },
  visitCountText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0D9488',
  },
  latestDate: {
    fontSize: 11,
    color: '#94A3B8',
  },
  chevron: {
    marginTop: 4,
  },
  previewContainer: {
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  previewText: {
    fontSize: 13,
    color: '#888888',
    lineHeight: 18,
  },
  visitsContainer: {
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  visitItem: {
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  visitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  visitDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  visitDate: {
    fontSize: 12,
    color: '#94A3B8',
    marginLeft: 4,
  },
  sourceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  sourceBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  visitContent: {
    fontSize: 14,
    color: '#444444',
    lineHeight: 20,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#666666',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#0D9488',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    marginTop: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 3,
  },
  verifiedBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#059669',
  },
  // Management plan history styles
  mgmtHistorySection: {
    marginBottom: 8,
  },
  mgmtHistoryTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 10,
  },
  mgmtHistoryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderLeftWidth: 3,
    borderLeftColor: '#0D9488',
  },
  mgmtHistoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  mgmtHistoryName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1E293B',
  },
  mgmtHistoryId: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 1,
  },
  mgmtRiskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  mgmtRiskHigh: {
    backgroundColor: '#FEE2E2',
  },
  mgmtRiskLow: {
    backgroundColor: '#DCFCE7',
  },
  mgmtRiskText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  mgmtExpandedSection: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 10,
  },
  mgmtSubBlock: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  mgmtSubBlockTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0D9488',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  mgmtSubBlockContent: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 18,
  },
});

export default React.memo(HistoryPage);
